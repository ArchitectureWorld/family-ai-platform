#!/usr/bin/env python3
import errno
import fcntl
import os
import re
import stat
import sys

APP_UID = 1000
APP_GID = 1000
LOCK_NAME = ".family-ai-gateway.lock"
ROLES = {"gateway", "migrate", "provision", "recovery"}
RECOVERY_TARGETS = {"apps/gateway/dist/recoverGatewayDatabase.js", "dist/recoverGatewayDatabase.js"}


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


def protected_parent(
    info: os.stat_result, expected_uid: int, expected_gid: int
) -> bool:
    return (
        stat.S_ISDIR(info.st_mode)
        and info.st_uid == expected_uid
        and info.st_gid == expected_gid
        and stat.S_IMODE(info.st_mode) == 0o700
    )


def protected_lock(
    info: os.stat_result, expected_uid: int, expected_gid: int
) -> bool:
    return (
        stat.S_ISREG(info.st_mode)
        and info.st_uid == expected_uid
        and info.st_gid == expected_gid
        and info.st_nlink == 1
        and stat.S_IMODE(info.st_mode) == 0o600
    )


def open_validated_lock(
    database_path: str, expected_uid: int, expected_gid: int
) -> tuple[int, int]:
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
        if not protected_parent(os.fstat(parent_fd), expected_uid, expected_gid):
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
            not protected_lock(descriptor, expected_uid, expected_gid)
            or not protected_lock(path_info, expected_uid, expected_gid)
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


def claim_lock(
    database_path: str, expected_uid: int, expected_gid: int
) -> tuple[int, int]:
    parent_fd, lock_fd = open_validated_lock(
        database_path, expected_uid, expected_gid
    )
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


def assert_inherited(
    fd: int,
    role: str,
    database_path: str,
    expected_uid: int,
    expected_gid: int,
):
    if fd != 3 or role not in ROLES:
        fail("GATEWAY_DATABASE_LOCK_INVALID")
    parent_fd, path_fd = open_validated_lock(
        database_path, expected_uid, expected_gid
    )
    try:
        inherited = os.fstat(fd)
        current = os.fstat(path_fd)
        if (
            not protected_lock(inherited, expected_uid, expected_gid)
            or inherited.st_dev != current.st_dev
            or inherited.st_ino != current.st_ino
            or os.get_inheritable(fd) is False
        ):
            fail("GATEWAY_DATABASE_LOCK_INVALID")
        # An independent shared probe must conflict: only an already-exclusive
        # lock suffices. An EX probe would also accept SH, then upgrade fd3 below.
        try:
            fcntl.flock(path_fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
        except BlockingIOError:
            pass
        else:
            fcntl.flock(path_fd, fcntl.LOCK_UN)
            fail("GATEWAY_DATABASE_LOCK_INVALID")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            fail("GATEWAY_DATABASE_LOCK_INVALID")
    finally:
        os.close(path_fd)
        os.close(parent_fd)
    sys.stdout.write("GATEWAY_DATABASE_LOCK_OK\n")


def command_role(command: list[str], database: str) -> str:
    if len(command) >= 2 and command[0] == "node":
        if command[1] == "apps/gateway/test/fixtures/authorizedLockProbe.mjs":
            if os.environ.get("NODE_ENV") != "test":
                fail("GATEWAY_DATABASE_LOCK_ARGUMENTS_INVALID")
            role = "migrate"
        else:
            role = None
        targets = {
            "apps/gateway/dist/index.js": "gateway",
            "dist/index.js": "gateway",
            "apps/gateway/dist/migrate.js": "migrate",
            "dist/migrate.js": "migrate",
            "apps/gateway/dist/provisionFederationService.js": "provision",
            "dist/provisionFederationService.js": "provision",
            "apps/gateway/dist/adminOperatorCli.js": "provision",
            "dist/adminOperatorCli.js": "provision",
            "apps/gateway/dist/recoverGatewayDatabase.js": "recovery",
            "dist/recoverGatewayDatabase.js": "recovery",
        }
        role = role or targets.get(command[1])
        arguments = command[2:]
    else:
        fail("GATEWAY_DATABASE_LOCK_ARGUMENTS_INVALID")
    if role is None:
        fail("GATEWAY_DATABASE_LOCK_ARGUMENTS_INVALID")
    if role == "gateway":
        if arguments:
            fail("GATEWAY_DATABASE_LOCK_ARGUMENTS_INVALID")
        return role
    if len(arguments) % 2 != 0:
        fail("GATEWAY_DATABASE_LOCK_ARGUMENTS_INVALID")
    pairs: dict[str, str] = {}
    for index in range(0, len(arguments), 2):
        flag, value = arguments[index], arguments[index + 1]
        if flag in pairs:
            fail("GATEWAY_DATABASE_LOCK_ARGUMENTS_INVALID")
        pairs[flag] = value
    if role == "migrate":
        if pairs != {"--database": database}:
            fail("GATEWAY_DATABASE_LOCK_ARGUMENTS_INVALID")
        return role
    if role == "recovery":
        action = pairs.get("--action")
        operation = pairs.get("--operation-id")
        required = {"--database", "--action"}
        if action in {"resume", "retry"} or (action == "status" and operation is not None):
            required.add("--operation-id")
            if operation is None or re.fullmatch(r"[0-9a-f]{32}", operation) is None:
                fail("GATEWAY_DATABASE_LOCK_ARGUMENTS_INVALID")
        if action not in {"recover", "resume", "retry", "status"} or set(pairs) != required:
            fail("GATEWAY_DATABASE_LOCK_ARGUMENTS_INVALID")
        if pairs["--database"] != database:
            fail("GATEWAY_DATABASE_LOCK_ARGUMENTS_INVALID")
        return role
    if command[1] in {"apps/gateway/dist/adminOperatorCli.js", "dist/adminOperatorCli.js"}:
        if set(pairs) != {"--database", "--entry"}:
            fail("GATEWAY_DATABASE_LOCK_ARGUMENTS_INVALID")
        if pairs["--database"] != database:
            fail("GATEWAY_DATABASE_LOCK_ARGUMENTS_INVALID")
        return role
    if set(pairs) != {"--service-ref", "--product", "--credential-file", "--database"}:
        fail("GATEWAY_DATABASE_LOCK_ARGUMENTS_INVALID")
    if pairs["--database"] != database:
        fail("GATEWAY_DATABASE_LOCK_ARGUMENTS_INVALID")
    return role


def parse_normal(argv: list[str]) -> tuple[str, str, list[str]]:
    if len(argv) < 4 or argv[2] != "--":
        fail("GATEWAY_DATABASE_LOCK_ARGUMENTS_INVALID")
    if argv[0] == "--database-from-env":
        if argv[1] != "GATEWAY_DATABASE_PATH":
            fail("GATEWAY_DATABASE_LOCK_ARGUMENTS_INVALID")
        database = os.environ.get("GATEWAY_DATABASE_PATH")
    elif argv[0] == "--database":
        database = argv[1]
    else:
        fail("GATEWAY_DATABASE_LOCK_ARGUMENTS_INVALID")
    database_path = exact_database_path(database or "")
    command = argv[3:]
    return command_role(command, database_path), database_path, command


def main():
    os.umask(0o077)
    argv = sys.argv[1:]
    if argv == ["--self-check"]:
        sys.stdout.write("GATEWAY_DATABASE_LOCK_SELF_CHECK_OK\n")
        return
    if len(argv) == 4 and argv[0] == "--assert-inherited-fd":
        if argv[2] != "--database":
            fail("GATEWAY_DATABASE_LOCK_ARGUMENTS_INVALID")
        role = os.environ.get("FAMILY_AI_GATEWAY_LOCK_ROLE")
        if role not in ROLES:
            fail("GATEWAY_DATABASE_LOCK_INVALID")
        assert_inherited(
            int(argv[1]),
            role,
            exact_database_path(argv[3]),
            APP_UID,
            APP_GID,
        )
        return
    role, database, command = parse_normal(argv)
    if role == "recovery" and (os.getuid() != APP_UID or os.getgid() != APP_GID):
        fail("GATEWAY_DATABASE_LOCK_INVALID")
    parent_fd, lock_fd = claim_lock(database, APP_UID, APP_GID)
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
        os.execvpe(command[0], command, os.environ)
    except LockFailure:
        raise
    except OSError:
        fail("GATEWAY_DATABASE_LOCK_EXEC_FAILED")


if __name__ == "__main__":
    try:
        main()
    except LockFailure as error:
        recovery = any(value in RECOVERY_TARGETS for value in sys.argv[1:])
        code = ("RECOVERY_FAILED" if error.code == "GATEWAY_DATABASE_LOCK_BUSY" else "RECOVERY_INVALID") if recovery else error.code
        sys.stderr.write(code + "\n")
        raise SystemExit(1)
    except (OSError, ValueError, TypeError):
        recovery = any(value in RECOVERY_TARGETS for value in sys.argv[1:])
        sys.stderr.write("RECOVERY_INVALID\n" if recovery else "GATEWAY_DATABASE_LOCK_INVALID\n")
        raise SystemExit(1)
