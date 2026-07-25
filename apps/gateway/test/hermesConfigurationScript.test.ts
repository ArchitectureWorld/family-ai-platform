import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const configureScript = join(repositoryRoot, "scripts/configure-hermes.py");
const directories: string[] = [];

function mode(path: string) {
  return statSync(path).mode & 0o777;
}

function writeExecutable(path: string, content: string) {
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o755);
}

function runConfigure(input: {
  repoRoot: string;
  hermesHome: string;
  hermesBin: string;
  extra?: string[];
}) {
  return spawnSync("python3", [
    configureScript,
    "--repo-root", input.repoRoot,
    "--hermes-home", input.hermesHome,
    "--hermes-bin", input.hermesBin,
    "--configure-only",
    ...(input.extra ?? [])
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      HERMES_HOME: input.hermesHome,
      FAKE_HERMES_LOG: join(input.repoRoot, "hermes-command.log")
    }
  });
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("configure-hermes.py", () => {
  it("configures Jarvis and zzh idempotently without replacing Profile content or exposing keys", () => {
    const root = mkdtempSync(join(tmpdir(), "family-ai-hermes-config-"));
    directories.push(root);
    const repoRoot = join(root, "repo");
    const hermesHome = join(root, "hermes-home");
    const profiles = join(hermesHome, "profiles");
    mkdirSync(join(repoRoot, ".runtime/config"), { recursive: true });
    mkdirSync(join(profiles, "jarvis"), { recursive: true });

    const jarvisConfig = "model: existing-jarvis-config\n";
    const jarvisSoul = "# Existing Jarvis Soul\nDo not overwrite me.\n";
    const existingJarvisKey = "jarvis-existing-runtime-key-0123456789abcdef";
    writeFileSync(join(profiles, "jarvis/config.yaml"), jarvisConfig);
    writeFileSync(join(profiles, "jarvis/SOUL.md"), jarvisSoul);
    writeFileSync(join(profiles, "jarvis/.env"), [
      "# preserve this comment",
      "OTHER_SETTING=keep-me",
      `API_SERVER_KEY=${existingJarvisKey}`,
      "API_SERVER_PORT=9999",
      ""
    ].join("\n"));

    const fakeHermes = join(root, "fake-hermes");
    writeExecutable(fakeHermes, `#!/usr/bin/env python3
import os
import pathlib
import sys
log = pathlib.Path(os.environ["FAKE_HERMES_LOG"])
with log.open("a", encoding="utf-8") as handle:
    handle.write(" ".join(sys.argv[1:]) + "\\n")
args = sys.argv[1:]
if len(args) == 3 and args[0] == "profile" and args[1] == "create":
    profile = pathlib.Path(os.environ["HERMES_HOME"]) / "profiles" / args[2]
    profile.mkdir(parents=True, exist_ok=True)
    (profile / "config.yaml").write_text("model: created-by-fake\\n", encoding="utf-8")
    (profile / "SOUL.md").write_text("# Created Soul\\n", encoding="utf-8")
    sys.exit(0)
sys.exit(2)
`);

    const first = runConfigure({ repoRoot, hermesHome, hermesBin: fakeHermes });
    expect(first.status, `${first.stdout}\n${first.stderr}`).toBe(0);

    const jarvisEnv = readFileSync(join(profiles, "jarvis/.env"), "utf8");
    const zzhEnv = readFileSync(join(profiles, "zzh/.env"), "utf8");
    expect(readFileSync(join(profiles, "jarvis/config.yaml"), "utf8")).toBe(jarvisConfig);
    expect(readFileSync(join(profiles, "jarvis/SOUL.md"), "utf8")).toBe(jarvisSoul);
    expect(jarvisEnv).toContain("# preserve this comment");
    expect(jarvisEnv).toContain("OTHER_SETTING=keep-me");
    expect(jarvisEnv).toContain(`API_SERVER_KEY=${existingJarvisKey}`);
    expect(jarvisEnv).toContain("API_SERVER_ENABLED=true");
    expect(jarvisEnv).toContain("API_SERVER_HOST=0.0.0.0");
    expect(jarvisEnv).toContain("API_SERVER_PORT=8650");
    expect(jarvisEnv).toContain("API_SERVER_MODEL_NAME=jarvis");
    expect(zzhEnv).toMatch(/API_SERVER_KEY=[a-f0-9]{64}/);
    expect(zzhEnv).toContain("API_SERVER_PORT=8651");
    expect(zzhEnv).toContain("API_SERVER_MODEL_NAME=zzh");

    const generatedZzhKey = /API_SERVER_KEY=([^\n]+)/.exec(zzhEnv)?.[1];
    expect(generatedZzhKey).toMatch(/^[a-f0-9]{64}$/);
    const providerPath = join(repoRoot, ".runtime/config/providers.json");
    const providers = JSON.parse(readFileSync(providerPath, "utf8"));
    expect(providers).toEqual({
      version: 1,
      profiles: [
        {
          kind: "hermes",
          providerProfileRef: "provider-profile:hermes-jarvis",
          baseUrl: "http://host.docker.internal:8650",
          apiKey: existingJarvisKey,
          model: "jarvis",
          sessionKey: "family-ai:hermes:jarvis"
        },
        {
          kind: "hermes",
          providerProfileRef: "provider-profile:hermes-zzh",
          baseUrl: "http://host.docker.internal:8651",
          apiKey: generatedZzhKey,
          model: "zzh",
          sessionKey: "family-ai:hermes:zzh"
        }
      ]
    });
    expect(readFileSync(join(root, "hermes-command.log"), "utf8").trim())
      .toBe("profile create zzh");
    expect(mode(join(profiles, "jarvis/.env"))).toBe(0o600);
    expect(mode(join(profiles, "zzh/.env"))).toBe(0o600);
    expect(mode(providerPath)).toBe(0o600);
    expect(readFileSync(join(repoRoot, ".runtime/config/hermes-jarvis-yutu.enabled"), "utf8"))
      .toBe("hermes-jarvis-yutu-v1\n");
    expect(`${first.stdout}\n${first.stderr}`).not.toContain(existingJarvisKey);
    expect(`${first.stdout}\n${first.stderr}`).not.toContain(String(generatedZzhKey));

    const beforeSecond = readFileSync(join(root, "hermes-command.log"), "utf8");
    const second = runConfigure({ repoRoot, hermesHome, hermesBin: fakeHermes });
    expect(second.status, `${second.stdout}\n${second.stderr}`).toBe(0);
    expect(readFileSync(join(root, "hermes-command.log"), "utf8")).toBe(beforeSecond);
    expect(readFileSync(join(profiles, "jarvis/config.yaml"), "utf8")).toBe(jarvisConfig);
    expect(readFileSync(join(profiles, "jarvis/SOUL.md"), "utf8")).toBe(jarvisSoul);
    expect(JSON.parse(readFileSync(providerPath, "utf8"))).toEqual(providers);
  });
});
