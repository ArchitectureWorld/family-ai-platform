#!/usr/bin/env python3
"""Linux renameat2(RENAME_NOREPLACE) bridge for Broker-owned UDS lifecycle."""

from __future__ import annotations

import ctypes
import errno
import json
import os
import sys
from typing import Any


MAX_FRAME_BYTES = 16 * 1024
MAX_PATH_BYTES = 4096
AT_FDCWD = -100
RENAME_NOREPLACE = 1


def _emit(status: str) -> int:
    print(json.dumps({"status": status}, separators=(",", ":")))
    return 0


def _frame() -> dict[str, Any] | None:
    raw = sys.stdin.buffer.read(MAX_FRAME_BYTES + 1)
    if not raw or len(raw) > MAX_FRAME_BYTES:
        return None
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict) or set(value) != {
        "protocolVersion",
        "runtimeDirectory",
        "source",
        "destination",
    }:
        return None
    if value.get("protocolVersion") != 1:
        return None
    for key in ("runtimeDirectory", "source", "destination"):
        candidate = value.get(key)
        if (
            not isinstance(candidate, str)
            or not candidate
            or "\x00" in candidate
            or len(candidate.encode("utf-8")) > MAX_PATH_BYTES
            or not os.path.isabs(candidate)
        ):
            return None
    runtime = os.path.realpath(value["runtimeDirectory"])
    source_parent = os.path.realpath(os.path.dirname(value["source"]))
    destination_parent = os.path.realpath(os.path.dirname(value["destination"]))
    try:
        if os.path.commonpath([runtime, source_parent]) != runtime:
            return None
        if os.path.commonpath([runtime, destination_parent]) != runtime:
            return None
    except ValueError:
        return None
    return value


def main() -> int:
    frame = _frame()
    if frame is None:
        return _emit("invalid")
    try:
        renameat2 = ctypes.CDLL(None, use_errno=True).renameat2
    except AttributeError:
        return _emit("unsupported")
    renameat2.argtypes = [
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_uint,
    ]
    renameat2.restype = ctypes.c_int
    result = renameat2(
        AT_FDCWD,
        os.fsencode(frame["source"]),
        AT_FDCWD,
        os.fsencode(frame["destination"]),
        RENAME_NOREPLACE,
    )
    if result == 0:
        return _emit("renamed")
    error = ctypes.get_errno()
    if error in {errno.EEXIST, errno.ENOTEMPTY}:
        return _emit("destination_exists")
    if error in {errno.ENOSYS, errno.EINVAL, errno.EOPNOTSUPP, errno.EXDEV}:
        return _emit("unsupported")
    return _emit("failed")


if __name__ == "__main__":
    raise SystemExit(main())
