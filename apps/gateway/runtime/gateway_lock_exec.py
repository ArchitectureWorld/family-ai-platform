#!/usr/bin/env python3
import errno
import fcntl
import os
import shutil
import stat
import sys

APP_UID = 1000
APP_GID = 1000
LOCK_NAME = ".family-ai-gateway.lock"
ROLES = {"gateway", "migrate", "provision"}


class LockFailure(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def fail(code: str):
    raise LockFailure(code)


def exact_database_path(value: str) -> str:
    if not value or not os.path.isabs(value) or os.path.normpath(value) != value:
        fail("GATEWAY_DATABASE_LOCK_ARGUMENTS_INVALID")
    parent = os.path.dirname(value)
    if value == "/" or not parent or os.path.realpath(parent) != parent:
        fail("GATEWAY_DATABASE_LOCK_INVALID")
    return value


def protected_parent(info: os.stat_result) -> bool:
    return (
        stat.S_ISDIR(info.st_mode)
        and info.st_uid == APP_UID
        and info.st_gid == APP_GID
        and stat.S_IMODE(info.st_mode) == 0o700
    )


def protected_lock(info: os.stat_result) -> bool:
    return (
        stat.S_ISREG(info.st_mode)
        and info.st_uid == APP_UID
        and info.st_gid == APP_GID
        and info.st_nlink == 1
        and stat.S_IMODE(info.st_mode) == 0o600
    )


def open_validated_lock(database_path: str) -> tuple[int, int]:
    parent_path = os.path.dirname(database_path)
    try:
        parent_fd = os.open(
            parent_path,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
        )
    except OSError:
        fail("GATEWAY_DATABASE_LOCK_INVALID")
    lock_fd = -1
    try:
        if not protected_parent(os.fstat(parent_fd)):
            fail("GATEWAY_DATABASE_LOCK_INVALID")
        lock_fd = os.open(
            LOCK_NAME,
            os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC,
            0o600,
            dir_fd=parent_fd,
        )
        descriptor = os.fstat(lock_fd)
        path_info = os.stat(LOCK_NAME, dir_fd=parent_fd, follow_symlinks=False)
        if (
            not protected_lock(descriptor)
            or not protected_lock(path_info)
            or descriptor.st_dev != path_info.st_dev
            or descriptor.st_ino != path_info.st_ino
        ):
            fail("GATEWAY_DATABASE_LOCK_INVALID")
        return parent_fd, lock_fd
    except Exception:
        if lock_fd >= 0:
            os.close(lock_fd)
        os.close(parent_fd)
        raise


def claim_lock(database_path: str) -> tuple[int, int]:
    parent_fd, lock_fd = open_validated_lock(database_path)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(lock_fd)
        os.close(parent_fd)
        fail("GATEWAY_DATABASE_LOCK_BUSY")
    except OSError:
        os.close(lock_fd)
        os.close(parent_fd)
        fail("GATEWAY_DATABASE_LOCK_INVALID")
    return parent_fd, lock_fd


def assert_inherited(fd: int, role: str, database_path: str):
    if fd != 3 or role not in ROLES:
        fail("GATEWAY_DATABASE_LOCK_INVALID")
    parent_fd, path_fd = open_validated_lock(database_path)
    try:
        inherited = os.fstat(fd)
        current = os.fstat(path_fd)
        if (
            not protected_lock(inherited)
            or inherited.st_dev != current.st_dev
            or inherited.st_ino != current.st_ino
            or os.get_inheritable(fd) is False
        ):
            fail("GATEWAY_DATABASE_LOCK_INVALID")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            fail("GATEWAY_DATABASE_LOCK_INVALID")
        try:
            fcntl.flock(path_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            pass
        else:
            fcntl.flock(path_fd, fcntl.LOCK_UN)
            fail("GATEWAY_DATABASE_LOCK_INVALID")
    finally:
        os.close(path_fd)
        os.close(parent_fd)
    sys.stdout.write("GATEWAY_DATABASE_LOCK_OK\n")


def parse_normal(argv: list[str]) -> tuple[str, str, list[str]]:
    passthrough: list[str] = []
    if "--" in argv:
        split = argv.index("--")
        passthrough = argv[split + 1 :]
        argv = argv[:split]
    role = None
    database = None
    index = 0
    while index < len(argv):
        if index + 1 >= len(argv):
            fail("GATEWAY_DATABASE_LOCK_ARGUMENTS_INVALID")
        flag, value = argv[index], argv[index + 1]
        if flag == "--role" and role is None:
            role = value
        elif flag == "--database" and database is None:
            database = value
        else:
            fail("GATEWAY_DATABASE_LOCK_ARGUMENTS_INVALID")
        index += 2
    if role not in ROLES:
        fail("GATEWAY_DATABASE_LOCK_ARGUMENTS_INVALID")
    if role == "gateway":
        if passthrough:
            fail("GATEWAY_DATABASE_LOCK_ARGUMENTS_INVALID")
        database = database or os.environ.get("GATEWAY_DATABASE_PATH") or os.path.abspath(
            ".runtime/data/gateway.sqlite"
        )
    elif role == "migrate":
        if passthrough or database is None:
            fail("GATEWAY_DATABASE_LOCK_ARGUMENTS_INVALID")
    elif database is None:
        database_positions = [
            index for index, value in enumerate(passthrough) if value == "--database"
        ]
        if len(database_positions) != 1:
            fail("GATEWAY_DATABASE_LOCK_ARGUMENTS_INVALID")
        position = database_positions[0]
        if position + 1 >= len(passthrough):
            fail("GATEWAY_DATABASE_LOCK_ARGUMENTS_INVALID")
        database = passthrough[position + 1]
        passthrough = passthrough[:position] + passthrough[position + 2 :]
    return role, exact_database_path(database or ""), passthrough


def fixed_command(root: str, role: str, database: str, passthrough: list[str]) -> list[str]:
    node = shutil.which("node")
    if not node or not os.path.isabs(node):
        fail("GATEWAY_DATABASE_LOCK_EXEC_FAILED")
    target = {
        "gateway": "index.js",
        "migrate": "migrate.js",
        "provision": "provisionFederationService.js",
    }[role]
    command = [node, os.path.join(root, "apps", "gateway", "dist", target)]
    if role == "migrate":
        command.extend(["--database", database])
    elif role == "provision":
        command.extend([*passthrough, "--database", database])
    return command


def main():
    os.umask(0o077)
    argv = sys.argv[1:]
    if argv == ["--self-check"]:
        sys.stdout.write("GATEWAY_DATABASE_LOCK_SELF_CHECK_OK\n")
        return
    if len(argv) == 6 and argv[0] == "--assert-inherited-fd":
        if argv[2] != "--role" or argv[4] != "--database":
            fail("GATEWAY_DATABASE_LOCK_ARGUMENTS_INVALID")
        assert_inherited(int(argv[1]), argv[3], exact_database_path(argv[5]))
        return
    role, database, passthrough = parse_normal(argv)
    parent_fd, lock_fd = claim_lock(database)
    try:
        os.close(parent_fd)
        if lock_fd != 3:
            os.dup2(lock_fd, 3, inheritable=True)
            os.close(lock_fd)
            lock_fd = 3
        else:
            os.set_inheritable(lock_fd, True)
        os.environ["FAMILY_AI_GATEWAY_LOCK_ROLE"] = role
        os.environ["FAMILY_AI_GATEWAY_LOCK_DATABASE"] = database
        root = os.path.realpath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
        os.execvpe(fixed_command(root, role, database, passthrough)[0], fixed_command(
            root, role, database, passthrough
        ), os.environ)
    except LockFailure:
        raise
    except OSError:
        fail("GATEWAY_DATABASE_LOCK_EXEC_FAILED")


if __name__ == "__main__":
    try:
        main()
    except LockFailure as error:
        sys.stderr.write(error.code + "\n")
        raise SystemExit(1)
