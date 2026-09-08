#!/usr/bin/env python3
"""Bounded stdin bridge from Family Agent Broker to the installed Hermes API."""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import sys
from urllib.request import Request, urlopen
from typing import Any


MAX_FRAME_BYTES = 128 * 1024
MAX_QUERY_CHARS = 12_000
ALLOWED_PROFILES = frozenset({"default", "zzh", "nsy"})
SESSION_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{1,99}$")
BROKER_HERMES_HOME = Path("/home/youran/.local/share/three-product-candidates/hermes")


def _fail() -> int:
    print("bridge_error:unavailable", file=sys.stderr)
    return 1


def _read_frame() -> dict[str, Any] | None:
    # The Node runner writes one newline-delimited frame but keeps the pipe
    # open while waiting for the child.  A full ``read(n)`` therefore waits
    # forever for EOF; consume exactly one bounded frame instead.
    raw = sys.stdin.buffer.readline(MAX_FRAME_BYTES + 1)
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


def _direct_config() -> tuple[str, str, str] | None:
    """Read the explicitly configured local OpenAI-compatible endpoint.

    Hermes' full startup probes several Ollama-style metadata endpoints. The
    LAN Antigravity gateway intentionally implements only the OpenAI surface,
    so the Broker uses this narrow chat path when explicitly enabled.
    """
    candidate = BROKER_HERMES_HOME / "config.yaml"
    path = candidate if candidate.is_file() else Path(os.environ["HERMES_HOME"]) / "config.yaml"
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return None
    if os.environ.get("HERMES_BROKER_DIRECT") != "1" and "direct_openai_compat: true" not in text:
        return None
    model = re.search(r"^  default:\s*(\S+)\s*$", text, re.MULTILINE)
    base = re.search(r"^  base_url:\s*(\S+)\s*$", text, re.MULTILINE)
    key = re.search(r"^  api_key:\s*(\S+)\s*$", text, re.MULTILINE)
    if not model or not base or not key:
        return None
    return model.group(1), base.group(1).rstrip("/"), key.group(1)


def _direct_chat(frame: dict[str, Any], config: tuple[str, str, str]) -> int:
    model, base_url, api_key = config
    profile = str(frame["profile"])
    session_id = str(frame.get("resume") or f"direct-{profile}")
    if not SESSION_ID.fullmatch(session_id):
        return _fail()
    store = BROKER_HERMES_HOME / "broker-sessions"
    try:
        store.mkdir(mode=0o700, parents=True, exist_ok=True)
        history_path = store / f"{profile}.json"
        history: list[dict[str, str]] = []
        if frame.get("resume") and history_path.exists():
            loaded = json.loads(history_path.read_text(encoding="utf-8"))
            if isinstance(loaded, list) and all(isinstance(item, dict) for item in loaded):
                history = loaded[-20:]
        history.append({"role": "user", "content": str(frame["query"])})
        body = json.dumps({"model": model, "messages": history, "stream": False}).encode()
        request = Request(
            f"{base_url}/chat/completions",
            data=body,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(request, timeout=45) as response:
            payload = json.loads(response.read(256 * 1024).decode("utf-8"))
        output = payload["choices"][0]["message"]["content"]
        if not isinstance(output, str) or not output.strip() or len(output) > MAX_QUERY_CHARS:
            return _fail()
        history.append({"role": "assistant", "content": output})
        temporary = history_path.with_suffix(f".{os.getpid()}.tmp")
        temporary.write_text(json.dumps(history, ensure_ascii=False), encoding="utf-8")
        os.chmod(temporary, 0o600)
        temporary.replace(history_path)
        print(output.strip())
        print(f"session_id: {session_id}", file=sys.stderr)
        return 0
    except Exception:
        return _fail()


def main() -> int:
    frame = _read_frame()
    if frame is None or not _scope_home(frame["profile"]):
        return _fail()
    direct = _direct_config()
    if direct is not None:
        return _direct_chat(frame, direct)
    os.environ["HERMES_SESSION_SOURCE"] = "tool"
    try:
        import cli

        cli.main(
            query=frame["query"],
            resume=frame.get("resume"),
            quiet=True,
            # The Broker exposes chat only.  Avoid initializing Hermes' full
            # interactive tool registry (which probes local model metadata and
            # unrelated MCP/tool backends before the first chat request).
            toolsets=["hermes-cli"],
        )
        return 0
    except SystemExit as error:
        code = error.code
        return code if isinstance(code, int) else 1
    except BaseException:
        return _fail()


if __name__ == "__main__":
    raise SystemExit(main())
