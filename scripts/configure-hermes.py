#!/usr/bin/env python3
"""Configure the local Hermes Jarvis/zzh profiles for Family AI without exposing secrets."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
from typing import Iterable
from urllib import error as urllib_error
from urllib import request as urllib_request

PRESET = "hermes-jarvis-yutu-v1"
TARGET_KEYS = (
    "API_SERVER_ENABLED",
    "API_SERVER_HOST",
    "API_SERVER_PORT",
    "API_SERVER_MODEL_NAME",
    "API_SERVER_KEY",
)
PROFILES = (
    {
        "name": "jarvis",
        "port": 8650,
        "provider_profile_ref": "provider-profile:hermes-jarvis",
        "session_key": "family-ai:hermes:jarvis",
    },
    {
        "name": "zzh",
        "port": 8651,
        "provider_profile_ref": "provider-profile:hermes-zzh",
        "session_key": "family-ai:hermes:zzh",
    },
)


class ConfigurationError(RuntimeError):
    pass


def parse_args(argv: list[str]) -> argparse.Namespace:
    script_root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(
        description="Configure Hermes Jarvis and zzh profiles for Family AI."
    )
    parser.add_argument("--repo-root", type=Path, default=script_root)
    parser.add_argument(
        "--hermes-home",
        type=Path,
        default=Path(os.environ.get("HERMES_HOME", "~/.hermes")).expanduser(),
    )
    parser.add_argument("--hermes-bin", default=os.environ.get("HERMES_BIN", "hermes"))
    parser.add_argument("--configure-only", action="store_true")
    parser.add_argument("--no-health-check", action="store_true")
    parser.add_argument("--command-timeout", type=float, default=30.0)
    parser.add_argument("--health-timeout", type=float, default=5.0)
    parser.add_argument("--health-attempts", type=int, default=12)
    parser.add_argument("--health-interval", type=float, default=1.0)
    parser.add_argument("--jarvis-health-url", default="http://127.0.0.1:8650")
    parser.add_argument("--zzh-health-url", default="http://127.0.0.1:8651")
    args = parser.parse_args(argv)
    if args.command_timeout <= 0 or args.health_timeout <= 0:
        parser.error("timeouts must be positive")
    if args.health_attempts <= 0 or args.health_interval < 0:
        parser.error("health retry values are invalid")
    return args


def atomic_write_text(path: Path, content: str, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", dir=str(path.parent), text=True
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
        os.chmod(path, mode)
    finally:
        if temporary.exists():
            temporary.unlink()


def split_env_assignment(line: str) -> tuple[str, str] | None:
    stripped = line.strip()
    if not stripped or stripped.startswith("#") or "=" not in stripped:
        return None
    key, value = stripped.split("=", 1)
    key = key.strip()
    if not key:
        return None
    return key, value


def read_existing_key(lines: Iterable[str]) -> str | None:
    for line in lines:
        assignment = split_env_assignment(line)
        if assignment and assignment[0] == "API_SERVER_KEY" and assignment[1]:
            return assignment[1]
    return None


def update_env(path: Path, values: dict[str, str]) -> None:
    original = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    output: list[str] = []
    emitted: set[str] = set()
    for line in original:
        assignment = split_env_assignment(line)
        key = assignment[0] if assignment else None
        if key in TARGET_KEYS:
            if key not in emitted:
                output.append(f"{key}={values[key]}")
                emitted.add(key)
            continue
        output.append(line)
    if output and output[-1] != "":
        output.append("")
    for key in TARGET_KEYS:
        if key not in emitted:
            output.append(f"{key}={values[key]}")
    atomic_write_text(path, "\n".join(output).rstrip("\n") + "\n")


def run_command(
    command: list[str],
    *,
    timeout: float,
    env: dict[str, str],
) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            command,
            env=env,
            timeout=timeout,
            check=False,
            capture_output=True,
            text=True,
        )
    except subprocess.TimeoutExpired as exc:
        raise ConfigurationError(f"command timed out: {' '.join(command[:4])}") from exc
    except OSError as exc:
        raise ConfigurationError(f"unable to execute Hermes command: {command[0]}") from exc


def ensure_profile(
    hermes_bin: str,
    hermes_home: Path,
    profile_name: str,
    timeout: float,
) -> Path:
    profile_directory = hermes_home / "profiles" / profile_name
    if profile_directory.is_dir():
        return profile_directory
    env = dict(os.environ)
    env["HERMES_HOME"] = str(hermes_home)
    result = run_command(
        [hermes_bin, "profile", "create", profile_name],
        timeout=timeout,
        env=env,
    )
    if result.returncode != 0 or not profile_directory.is_dir():
        raise ConfigurationError(f"failed to create Hermes profile: {profile_name}")
    return profile_directory


def configure_profiles(args: argparse.Namespace) -> list[dict[str, object]]:
    hermes_home = args.hermes_home.expanduser().resolve()
    hermes_home.mkdir(parents=True, exist_ok=True)
    configured: list[dict[str, object]] = []
    for profile in PROFILES:
        name = str(profile["name"])
        directory = ensure_profile(
            args.hermes_bin,
            hermes_home,
            name,
            args.command_timeout,
        )
        env_path = directory / ".env"
        existing_lines = env_path.read_text(encoding="utf-8").splitlines() if env_path.exists() else []
        api_key = read_existing_key(existing_lines) or secrets.token_hex(32)
        values = {
            "API_SERVER_ENABLED": "true",
            "API_SERVER_HOST": "0.0.0.0",
            "API_SERVER_PORT": str(profile["port"]),
            "API_SERVER_MODEL_NAME": name,
            "API_SERVER_KEY": api_key,
        }
        update_env(env_path, values)
        configured.append({**profile, "api_key": api_key})
        print(f"Configured Hermes profile {name} on port {profile['port']}.")
    return configured


def write_gateway_runtime(repo_root: Path, profiles: list[dict[str, object]]) -> None:
    config_directory = repo_root.resolve() / ".runtime" / "config"
    provider_payload = {
        "version": 1,
        "profiles": [
            {
                "kind": "hermes",
                "providerProfileRef": profile["provider_profile_ref"],
                "baseUrl": f"http://host.docker.internal:{profile['port']}",
                "apiKey": profile["api_key"],
                "model": profile["name"],
                "sessionKey": profile["session_key"],
            }
            for profile in profiles
        ],
    }
    atomic_write_text(
        config_directory / "providers.json",
        json.dumps(provider_payload, ensure_ascii=False, indent=2) + "\n",
    )
    atomic_write_text(
        config_directory / "hermes-jarvis-yutu.enabled",
        PRESET + "\n",
    )
    print("Wrote the ignored Family AI Hermes runtime configuration.")


def restart_profile(args: argparse.Namespace, profile_name: str) -> None:
    env = dict(os.environ)
    env["HERMES_HOME"] = str(args.hermes_home.expanduser().resolve())
    restart = run_command(
        [args.hermes_bin, "-p", profile_name, "gateway", "restart"],
        timeout=args.command_timeout,
        env=env,
    )
    if restart.returncode == 0:
        print(f"Restarted Hermes profile service {profile_name}.")
        return
    install = run_command(
        [args.hermes_bin, "-p", profile_name, "gateway", "install", "--force"],
        timeout=args.command_timeout,
        env=env,
    )
    if install.returncode != 0:
        raise ConfigurationError(f"failed to install Hermes profile service: {profile_name}")
    start = run_command(
        [args.hermes_bin, "-p", profile_name, "gateway", "start"],
        timeout=args.command_timeout,
        env=env,
    )
    if start.returncode != 0:
        raise ConfigurationError(f"failed to start Hermes profile service: {profile_name}")
    print(f"Installed and started Hermes profile service {profile_name}.")


def health_url(args: argparse.Namespace, profile_name: str) -> str:
    return (
        args.jarvis_health_url if profile_name == "jarvis" else args.zzh_health_url
    ).rstrip("/") + "/v1/models"


def check_profile_health(
    args: argparse.Namespace,
    profile: dict[str, object],
) -> None:
    name = str(profile["name"])
    endpoint = health_url(args, name)
    last_reason = "unavailable"
    for attempt in range(args.health_attempts):
        http_request = urllib_request.Request(
            endpoint,
            headers={"Authorization": f"Bearer {profile['api_key']}"},
            method="GET",
        )
        try:
            with urllib_request.urlopen(http_request, timeout=args.health_timeout) as response:
                if response.status != 200:
                    last_reason = f"HTTP {response.status}"
                else:
                    payload = json.loads(response.read().decode("utf-8"))
                    data = payload.get("data") if isinstance(payload, dict) else None
                    model_ids = {
                        item.get("id")
                        for item in data
                        if isinstance(data, list) and isinstance(item, dict)
                    } if isinstance(data, list) else set()
                    if name in model_ids:
                        print(f"Hermes profile {name} health is online.")
                        return
                    last_reason = "advertised model mismatch"
        except (urllib_error.URLError, urllib_error.HTTPError, TimeoutError, ValueError, json.JSONDecodeError) as exc:
            if isinstance(exc, urllib_error.HTTPError):
                last_reason = f"HTTP {exc.code}"
            else:
                last_reason = "unavailable"
        if attempt + 1 < args.health_attempts:
            time.sleep(args.health_interval)
    raise ConfigurationError(f"Hermes profile health failed: {name} ({last_reason})")


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    hermes_bin = args.hermes_bin
    if os.path.sep not in hermes_bin and shutil.which(hermes_bin) is None:
        raise ConfigurationError("Hermes CLI was not found")
    if os.path.sep in hermes_bin and not Path(hermes_bin).is_file():
        raise ConfigurationError("Hermes CLI was not found")

    profiles = configure_profiles(args)
    write_gateway_runtime(args.repo_root, profiles)
    if args.configure_only:
        print("Configuration complete; Hermes services were not started.")
        return 0

    for profile in profiles:
        restart_profile(args, str(profile["name"]))
    if not args.no_health_check:
        for profile in profiles:
            check_profile_health(args, profile)
    print("Jarvis and zzh Hermes profiles are ready for Family AI Gateway.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ConfigurationError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
