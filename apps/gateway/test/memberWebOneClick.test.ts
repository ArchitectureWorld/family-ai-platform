import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const directories: string[] = [];

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function writeExecutable(path: string, source: string): void {
  writeFileSync(path, source, { mode: 0o700 });
  chmodSync(path, 0o700);
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("one-click Member Web experience", () => {
  it("persists attachments inside the existing writable data mount", () => {
    const compose = read("compose.yaml");
    const devUp = read("scripts/dev-up.sh");

    expect(compose).toContain(
      "FAMILY_AI_ATTACHMENT_ROOT: /app/.runtime/data/attachments"
    );
    expect(compose).toContain("./.runtime/data:/app/.runtime/data");
    expect(compose).toContain("read_only: true");
    expect(compose).not.toContain("FAMILY_AI_ATTACHMENT_ROOT: /app/.runtime/attachments");

    expect(devUp).toContain('ATTACHMENT_DIR="$DATA_DIR/attachments"');
    expect(devUp).toContain('mkdir -p "$CONFIG_DIR" "$DATA_DIR" "$ATTACHMENT_DIR"');
    expect(devUp).toContain(
      'chmod 700 "$RUNTIME_DIR" "$CONFIG_DIR" "$DATA_DIR" "$ATTACHMENT_DIR"'
    );
  });

  it("builds isolated acceptance from a fail-closed runtime manifest", () => {
    const devUp = read("scripts/dev-up.sh");
    const acceptance = read("scripts/acceptance.sh");
    const isolation = read("scripts/runtime-isolation-lib.sh");

    for (const required of [
      "FAMILY_AI_RUNTIME_ROOT",
      "COMPOSE_PROJECT_NAME",
      "FAMILY_AI_HOST_PORT",
      "FAMILY_AI_IMAGE_REF",
      "127.0.0.1::8790",
      "--no-build",
      "isolated-runtime-manifest.json",
      "capture_formal_8790_identity",
      "validate_isolated_compose_json"
    ]) {
      expect(`${devUp}\n${isolation}`).toContain(required);
    }
    expect(devUp).not.toContain("127.0.0.1:0:8790");
    expect(acceptance).toContain("read_manifest_field");
    expect(acceptance).toContain("MANIFEST_DEVICE");
    expect(acceptance).toContain("MANIFEST_INODE");
    expect(acceptance).toContain("MANIFEST_FORMAL_8790");
    expect(acceptance).toContain("refresh_isolated_port_after_restart");
  });

  it("copies every static quality input into the Docker build stage", () => {
    const dockerfile = read("Dockerfile");

    expect(dockerfile).toContain("COPY AGENTS.md ./");
    expect(dockerfile).toContain(
      "COPY docs/development/2026-07-25-member-web-product-workbench.md docs/development/2026-07-25-member-web-product-workbench.md"
    );
  });

  it("keeps container attachment acceptance on the isolated manifest", () => {
    const acceptance = read("scripts/acceptance-container-attachments.sh");

    for (const required of [
      "isolated-runtime-manifest.json",
      "X-Family-AI-Chunk-Sha256",
      "chunkCount",
      "compose restart gateway",
      "sha256sum",
      "FAMILY_AI_ATTACHMENT_ROOT",
      "FORMAL_8790"
    ]) {
      expect(acceptance).toContain(required);
    }
    expect(acceptance).not.toContain("127.0.0.1:0:8790");
  });

  it("hands the verified real Family state to the normal product workbench", () => {
    const onboarding = read("scripts/acceptance-onboarding.sh");
    const devUp = read("scripts/dev-up.sh");
    const verify = read("scripts/verify-foundation.sh");

    expect(onboarding).toContain("/api/v1/admin/members/$PERSON_REF/pairing-codes");
    expect(onboarding).toContain("scripts/write-member-handoff.mjs");
    expect(onboarding).toContain("printf '%s\\0%s\\0%s\\0'");
    expect(onboarding).toMatch(/compose run --quiet --rm/);
    expect(onboarding).not.toContain("/member/?pairingRef=");
    expect(onboarding).toContain("member-web-url");
    expect(onboarding).not.toContain("#token=");

    expect(devUp).not.toContain("ACCEPTANCE_URL");
    expect(devUp).not.toContain("#token=");
    expect(devUp).not.toContain("xdg-open");
    expect(devUp).not.toContain("gio open");

    expect(verify).toContain("member-web-url");
    expect(verify).not.toMatch(/acceptance-onboarding\.sh[^\n]*\|\s*tee/);
    expect(verify).not.toMatch(/\bcat\s+["']?\$MEMBER_WEB_URL_FILE/);
    expect(verify).not.toMatch(/\$(?:\{MEMBER_WEB_URL\}|MEMBER_WEB_URL(?![A-Z0-9_]))/);
    expect(verify).toContain("真实个人工作台");
    expect(verify).not.toContain("beginner browser acceptance");
    expect(verify).not.toContain("家庭 AI 初始化与入口验收台");
    expect(verify).not.toContain("#token=");
    expect(verify).not.toContain("创建家庭并进入门户");
    expect(verify).toContain("stat -c '%a'");
    expect(verify).toContain('url.username !== ""');
    expect(verify).toContain('url.password !== ""');
  });

  it("keeps captured formal onboarding output and reports free of pairing secrets", () => {
    const fixture = mkdtempSync(join(tmpdir(), "family-ai-onboarding-handoff-"));
    directories.push(fixture);
    const scriptsDirectory = join(fixture, "scripts");
    const configDirectory = join(fixture, ".runtime", "config");
    const binDirectory = join(fixture, "bin");
    mkdirSync(scriptsDirectory, { recursive: true });
    mkdirSync(configDirectory, { recursive: true });
    mkdirSync(binDirectory, { recursive: true });
    copyFileSync(
      join(root, "scripts", "acceptance-onboarding.sh"),
      join(scriptsDirectory, "acceptance-onboarding.sh")
    );
    copyFileSync(
      join(root, "scripts", "write-member-handoff.mjs"),
      join(scriptsDirectory, "write-member-handoff.mjs")
    );
    writeFileSync(join(configDirectory, "device-token"), "bootstrap-token\n", { mode: 0o600 });
    writeFileSync(join(configDirectory, "compose.env"), "LOCAL_UID=1000\nLOCAL_GID=1000\n", {
      mode: 0o600
    });

    writeExecutable(
      join(binDirectory, "docker"),
      `#!${process.execPath}
import { spawnSync } from "node:child_process";
import { join } from "node:path";
const args = process.argv.slice(2);
if (args.includes("restart")) process.exit(0);
if (args.includes("run")) {
  if (!args.includes("--quiet")) {
    process.stderr.write("compose lifecycle noise\\n");
  }
  const volumes = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--volume") volumes.push(args[index + 1]);
  }
  const helperSuffix = ":/member-handoff/write-member-handoff.mjs:ro";
  const outputSuffix = ":/member-handoff-output";
  const helperVolume = volumes.find(value => value.endsWith(helperSuffix));
  const outputVolume = volumes.find(value => value.endsWith(outputSuffix));
  if (!helperVolume || !outputVolume) process.exit(5);
  const helperPath = helperVolume.slice(0, -helperSuffix.length);
  const outputDirectory = outputVolume.slice(0, -outputSuffix.length);
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const result = spawnSync(
    process.execPath,
    [helperPath, join(outputDirectory, "member-web-url")],
    { input: Buffer.concat(chunks), stdio: ["pipe", "pipe", "pipe"] }
  );
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}
if (!args.includes("exec")) process.exit(2);
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const codeIndex = args.indexOf("-e");
if (codeIndex < 0 || !args[codeIndex + 1]) process.exit(6);
const result = spawnSync(
  process.execPath,
  ["-e", args[codeIndex + 1], args.at(-1)],
  { input: Buffer.concat(chunks), stdio: ["pipe", "pipe", "pipe"] }
);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
`
    );

    const pairingRef = "pairing:OUTPUT-PAIRING-SENTINEL";
    const pairingCode = "OUTPUT-CODE-SENTINEL";
    const malformedEntryToken = "MALFORMED-ENTRY-TOKEN-SENTINEL";
    writeExecutable(
      join(binDirectory, "curl"),
      `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const rawArgv = args.join("\\n");
for (const secret of ["bootstrap-token", "admin-token", "personal-token"]) {
  if (rawArgv.includes(secret)) process.exit(9);
}
const configIndex = args.indexOf("--config");
const curlConfig = configIndex >= 0 ? readFileSync(args[configIndex + 1], "utf8") : "";
const url = args.find(value => value.startsWith("http://"));
if (url?.endsWith("/health")) {
  process.stdout.write(JSON.stringify({ service: "family-ai-gateway-foundation" }));
  process.exit(0);
}
const outputIndex = args.indexOf("--output");
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
const methodIndex = args.indexOf("--request");
const method = methodIndex >= 0 ? args[methodIndex + 1] : "GET";
const joined = \`\${rawArgv}\\n\${curlConfig}\`;
if (
  process.env.MALFORMED_FAMILY === "1" &&
  url?.endsWith("/api/v1/onboarding/family")
) {
  writeFileSync(
    outputPath,
    '{"entries":{"admin":{"token":${JSON.stringify(malformedEntryToken)}}}x'
  );
  process.stdout.write("201");
  process.exit(0);
}
let status = 200;
let body;
if (url?.endsWith("/api/v1/onboarding/status")) {
  body = { initialized: false };
} else if (url?.endsWith("/api/v1/onboarding/family")) {
  status = 201;
  body = {
    family: { familyRef: "family:test" },
    owner: { personRef: "person:owner" },
    device: { deviceRef: "device:managed" },
    entries: {
      admin: { entrySessionRef: "entry-session:admin", token: "admin-token" },
      personal: { entrySessionRef: "entry-session:personal", token: "personal-token" }
    }
  };
} else if (url?.endsWith("/api/v1/portal/context")) {
  const personal = joined.includes("personal-token");
  body = {
    audience: personal ? "personal" : "family_admin",
    person: { personRef: "person:owner" },
    device: { deviceRef: "device:managed" },
    agent: { agentRef: personal ? "agent:personal-assistant" : "agent:family-manager" },
    entrySessionRef: personal ? "entry-session:personal" : "entry-session:admin"
  };
} else if (url?.endsWith("/api/v1/admin/members/person:owner/pairing-codes")) {
  status = 201;
  body = {
    pairing: {
      pairingRef: ${JSON.stringify(pairingRef)},
      code: ${JSON.stringify(pairingCode)},
      expiresAt: "2030-01-01T00:00:00.000Z"
    }
  };
} else if (url?.endsWith("/api/v1/admin/members") && method === "POST") {
  status = 201;
  body = {
    member: {
      personRef: "person:child",
      entryStatus: "unclaimed",
      personalAssistant: { agentRef: "agent:personal-assistant" }
    }
  };
} else if (url?.endsWith("/api/v1/admin/members") && method === "GET") {
  status = 403;
  body = { code: "ENTRY_AUDIENCE_FORBIDDEN", category: "permission" };
} else {
  process.exit(3);
}
if (!outputPath) process.exit(4);
writeFileSync(outputPath, JSON.stringify(body));
process.stdout.write(String(status));
`
    );
    for (const command of [
      "bash",
      "cat",
      "chmod",
      "date",
      "dirname",
      "mkdir",
      "mktemp",
      "rm",
      "seq",
      "sleep"
    ]) {
      const resolved = spawnSync("sh", ["-c", `command -v ${command}`], {
        encoding: "utf8"
      }).stdout.trim();
      expect(resolved).not.toBe("");
      symlinkSync(resolved, join(binDirectory, command));
    }

    const result = spawnSync("bash", [join(scriptsDirectory, "acceptance-onboarding.sh")], {
      cwd: fixture,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: binDirectory
      }
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(`${result.stdout}${result.stderr}`).not.toContain(pairingRef);
    expect(`${result.stdout}${result.stderr}`).not.toContain(pairingCode);
    expect(result.stdout).not.toContain("/member/#pairingRef=");
    const handoffPath = join(configDirectory, "member-web-url");
    expect(
      result.stdout
        .split("\n")
        .filter(line => line.startsWith("Member Web handoff: "))
    ).toEqual([`Member Web handoff: ${handoffPath}`]);
    expect(readFileSync(handoffPath, "utf8")).toBe(
      "http://127.0.0.1:8790/member/#pairingRef=pairing%3AOUTPUT-PAIRING-SENTINEL&code=OUTPUT-CODE-SENTINEL\n"
    );
    const reportsDirectory = join(fixture, "docs", "acceptance", "runtime");
    const reportNames = readdirSync(reportsDirectory).filter(name => name.endsWith(".md"));
    expect(reportNames).toHaveLength(1);
    const report = readFileSync(join(reportsDirectory, reportNames[0]!), "utf8");
    expect(report).not.toContain(pairingRef);
    expect(report).not.toContain(pairingCode);
    expect(report).not.toContain("/member/#pairingRef=");

    const malformedResult = spawnSync(
      "bash",
      [join(scriptsDirectory, "acceptance-onboarding.sh")],
      {
        cwd: fixture,
        encoding: "utf8",
        env: {
          ...process.env,
          MALFORMED_FAMILY: "1",
          PATH: binDirectory
        }
      }
    );
    expect(malformedResult.status).not.toBe(0);
    expect(`${malformedResult.stdout}${malformedResult.stderr}`).not.toContain(
      malformedEntryToken
    );
    for (const reportName of readdirSync(reportsDirectory)) {
      expect(readFileSync(join(reportsDirectory, reportName), "utf8")).not.toContain(
        malformedEntryToken
      );
    }
  }, 20_000);

  it("describes verification only through normal Chat, Work and recovery behavior", () => {
    const verify = read("scripts/verify-foundation.sh");
    for (const normalProductStep of [
      "发送一条 Chat 消息",
      "看到个人助理回复",
      "创建一个 Work",
      "在 Work 中继续对话",
      "刷新页面",
      "restart gateway"
    ]) {
      expect(verify).toContain(normalProductStep);
    }
    expect(verify).not.toContain("点击一键验收");
    expect(verify).not.toContain("打开验收台");
  });

  it("does not execute another reset after generating the product pairing link", () => {
    const verify = read("scripts/verify-foundation.sh");
    const stepSix = verify.slice(verify.indexOf("[6/6]"));
    expect(stepSix).not.toMatch(/^\.\/scripts\/dev-reset\.sh --yes/m);
    expect(stepSix).not.toMatch(/^\.\/scripts\/dev-up\.sh/m);
  });

  it("cleans request bodies and credential configs when interrupted", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "family-ai-onboarding-interrupt-"));
    directories.push(fixture);
    const scriptsDirectory = join(fixture, "scripts");
    const configDirectory = join(fixture, ".runtime", "config");
    const binDirectory = join(fixture, "bin");
    const tempDirectory = join(fixture, "sensitive-tmp");
    const markerPath = join(fixture, "curl-started");
    mkdirSync(scriptsDirectory, { recursive: true });
    mkdirSync(configDirectory, { recursive: true });
    mkdirSync(binDirectory, { recursive: true });
    mkdirSync(tempDirectory, { recursive: true });
    copyFileSync(
      join(root, "scripts", "acceptance-onboarding.sh"),
      join(scriptsDirectory, "acceptance-onboarding.sh")
    );
    writeFileSync(join(configDirectory, "device-token"), "TERM-DEVICE-TOKEN\n", {
      mode: 0o600
    });
    writeFileSync(join(configDirectory, "compose.env"), "LOCAL_UID=1000\n", {
      mode: 0o600
    });
    writeExecutable(
      join(binDirectory, "curl"),
      `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const configIndex = args.indexOf("--config");
if (configIndex >= 0) readFileSync(args[configIndex + 1], "utf8");
writeFileSync(${JSON.stringify(markerPath)}, "started");
setInterval(() => {}, 1000);
`
    );

    const child = spawn("bash", [join(scriptsDirectory, "acceptance-onboarding.sh")], {
      cwd: fixture,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
        TMPDIR: tempDirectory
      }
    });
    const deadline = Date.now() + 4000;
    while (!existsSync(markerPath) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(existsSync(markerPath)).toBe(true);
    const closed = new Promise<void>((resolve, reject) => {
      child.once("close", () => resolve());
      child.once("error", reject);
    });
    process.kill(-child.pid!, "SIGTERM");
    await closed;

    expect(readdirSync(tempDirectory)).toEqual([]);
  });

  it.each([
    [
      "a secret query in an mjs script",
      { "scripts/leak.mjs": 'const url = "/member/?pairingRef=secret";\n' }
    ],
    [
      "a multiline handoff pipe to tee",
      {
        "scripts/leak.sh":
          '#!/usr/bin/env bash\ncat "$MEMBER_WEB_URL_FILE" \\\n  | tee /tmp/leak\n'
      }
    ],
    [
      "a multiline onboarding pipe to tee",
      {
        "scripts/leak.sh":
          "#!/usr/bin/env bash\nbash ./scripts/acceptance-onboarding.sh \\\n  | tee /tmp/leak\n"
      }
    ],
    [
      "a JavaScript handoff read written to stdout",
      {
        "scripts/leak.mjs":
          'import { readFileSync } from "node:fs";\nprocess.stdout.write(readFileSync(".runtime/config/member-web-url", "utf8"));\n'
      }
    ],
    [
      "a JavaScript handoff read written through console info",
      {
        "scripts/leak.mjs":
          'import { readFileSync } from "node:fs";\nconsole.info(readFileSync(".runtime/config/member-web-url", "utf8"));\n'
      }
    ],
    [
      "an Admin Web handoff read written through console info",
      {
        "scripts/leak.mjs":
          'import { readFileSync } from "node:fs";\nconsole.info(readFileSync(".runtime-preview/config/admin-web-url-9443", "utf8"));\n'
      }
    ],
    [
      "a callback handoff read written through console info",
      {
        "scripts/leak.mjs":
          'import { readFile } from "node:fs";\nreadFile(".runtime/config/member-web-url", "utf8", (error, handoff) => {\n  if (error) throw error;\n  console.info(handoff);\n});\n'
      }
    ],
    [
      "a promise handoff read written through console info",
      {
        "scripts/leak.mjs":
          'import { readFile } from "node:fs/promises";\nreadFile(".runtime/config/member-web-url", "utf8").then(handoff => console.info(handoff));\n'
      }
    ],
    [
      "a shell handoff command-substitution printed to stdout",
      {
        "scripts/leak.sh":
          '#!/usr/bin/env bash\nprintf "%s\\n" "$(<"$MEMBER_WEB_URL_FILE")"\n'
      }
    ],
    [
      "a stored shell handoff command-substitution printed later",
      {
        "scripts/leak.sh":
          '#!/usr/bin/env bash\nLEAK="$(<"$MEMBER_WEB_URL_FILE")"\nprintf "%s\\n" "$LEAK"\n'
      }
    ],
    [
      "a dd handoff read using its default stdout",
      {
        "scripts/leak.sh":
          '#!/usr/bin/env bash\ndd if="$MEMBER_WEB_URL_FILE" status=none\n'
      }
    ],
    [
      "a handoff copied to the stdout device",
      {
        "scripts/leak.sh":
          '#!/usr/bin/env bash\ncp "$MEMBER_WEB_URL_FILE" /dev/stdout\n'
      }
    ],
    [
      "a multiline static proxy import",
      {
        "apps/example/source.ts":
          'import {\n  proxy\n} from "../../../scripts/member-preview-claim-loss-proxy.mjs";\n'
      }
    ],
    [
      "a multiline dynamic proxy import",
      {
        "packages/example/source.ts":
          'const proxy = await import(\n  "../../../scripts/response-loss-proxy.mjs"\n);\n'
      }
    ],
    [
      "a workspace package production script",
      {
        "packages/example/package.json":
          '{"scripts":{"start":"node ../../scripts/member-preview-claim-loss-proxy.mjs"}}\n'
      }
    ]
  ])("rejects %s", (_name, files) => {
    const fixture = mkdtempSync(join(tmpdir(), "family-ai-static-mutation-"));
    directories.push(fixture);
    for (const [relativePath, source] of Object.entries(
      files as Record<string, string>
    )) {
      const target = join(fixture, relativePath);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, source);
    }

    const result = spawnSync(
      "bash",
      [join(root, "scripts", "static-check.sh"), "--member-handoff-scan", fixture],
      { cwd: root, encoding: "utf8" }
    );

    expect(result.status).not.toBe(0);
  });

  it("allows handoff reads whose bytes are not sent to an output sink", () => {
    const fixture = mkdtempSync(join(tmpdir(), "family-ai-static-safe-"));
    directories.push(fixture);
    const scriptsDirectory = join(fixture, "scripts");
    mkdirSync(scriptsDirectory, { recursive: true });
    writeFileSync(
      join(scriptsDirectory, "safe.sh"),
      '#!/usr/bin/env bash\ncat "$MEMBER_WEB_URL_FILE" >/dev/null;\n'
    );
    writeFileSync(
      join(scriptsDirectory, "safe.mjs"),
      'import { readFileSync } from "node:fs";\nconst handoff = readFileSync(".runtime/config/member-web-url", "utf8");\nif (!handoff.endsWith("\\n")) process.exit(1);\nconsole.log("handoff validated");\n'
    );

    const result = spawnSync(
      "bash",
      [join(root, "scripts", "static-check.sh"), "--member-handoff-scan", fixture],
      { cwd: root, encoding: "utf8" }
    );

    expect(result.status).toBe(0);
  });
});
