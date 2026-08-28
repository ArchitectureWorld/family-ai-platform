#!/usr/bin/env python3
"""Bounded stdin bridge from Family Agent Broker to the installed Hermes API."""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import sys
from typing import Any


MAX_FRAME_BYTES = 128 * 1024
MAX_QUERY_CHARS = 12_000
ALLOWED_PROFILES = frozenset({"default", "zzh", "nsy"})
SESSION_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{1,99}$")


def _fail() -> int:
    print("bridge_error:unavailable", file=sys.stderr)
    return 1


def _read_frame() -> dict[str, Any] | None:
    raw = sys.stdin.buffer.read(MAX_FRAME_BYTES + 1)
    if not raw or len(raw) > MAX_FRAME_BYTES:
        return None
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict):
        return None
    expected = {"protocolVersion", "profile", "query"}
    if "resume" in value:
        expected.add("resume")
    if set(value) != expected or value.get("protocolVersion") != 1:
        return None
    profile = value.get("profile")
    query = value.get("query")
    resume = value.get("resume")
    if profile not in ALLOWED_PROFILES:
        return None
    if (
        not isinstance(query, str)
        or not query.strip()
        or len(query) > MAX_QUERY_CHARS
    ):
        return None
    if resume is not None and (
        not isinstance(resume, str) or SESSION_ID.fullmatch(resume) is None
    ):
        return None
    return value


def _scope_home(profile: str) -> bool:
    home_value = os.environ.get("HERMES_HOME")
    if not home_value:
        return False
    home = Path(home_value)
    if not home.is_absolute():
        return False
    if profile != "default":
        home = home / "profiles" / profile
    if not home.is_dir():
        return False
    os.environ["HERMES_HOME"] = str(home)
    return True


def main() -> int:
    frame = _read_frame()
    if frame is None or not _scope_home(frame["profile"]):
        return _fail()
    os.environ["HERMES_SESSION_SOURCE"] = "tool"
    try:
        import cli

        cli.main(
            query=frame["query"],
            resume=frame.get("resume"),
            quiet=True,
        )
        return 0
    except SystemExit as error:
        code = error.code
        return code if isinstance(code, int) else 1
    except BaseException:
        return _fail()


if __name__ == "__main__":
    raise SystemExit(main())
