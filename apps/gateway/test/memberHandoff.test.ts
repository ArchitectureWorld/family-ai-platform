import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const helper = join(root, "scripts/write-member-handoff.mjs");
const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "family-ai-member-handoff-"));
  directories.push(directory);
  return directory;
}

function runCli(outputPath: string, input: string | Buffer, extraArgv: string[] = []) {
  return spawnSync(process.execPath, [helper, outputPath, ...extraArgv], {
    cwd: root,
    encoding: "utf8",
    input
  });
}

function runCliAsync(outputPath: string, input: string | Buffer): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helper, outputPath], {
      cwd: root,
      stdio: ["pipe", "ignore", "ignore"]
    });
    child.once("error", reject);
    child.once("close", resolve);
    child.stdin.end(input);
  });
}

function framed(baseUrl: string, pairingRef: string, code: string): string {
  return `${baseUrl}\u0000${pairingRef}\u0000${code}\u0000`;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("Member Web pairing handoff", () => {
  it("writes the exact percent-encoded member fragment plus one newline", () => {
    const directory = temporaryDirectory();
    const outputPath = join(directory, "member-web-url");
    const pairingRef = "pairing:web alice/0001";
    const code = "ABCD EFGH/+";

    const result = runCli(
      outputPath,
      framed("http://127.0.0.1:8791/old?discard=yes#discard", pairingRef, code)
    );

    expect(result.status).toBe(0);
    expect(readFileSync(outputPath, "utf8")).toBe(
      "http://127.0.0.1:8791/member/#pairingRef=pairing%3Aweb+alice%2F0001&code=ABCD+EFGH%2F%2B\n"
    );
  });

  it("atomically replaces the destination with mode 0600 and leaves no temporary file", () => {
    const directory = temporaryDirectory();
    const outputPath = join(directory, "member-web-url");
    writeFileSync(outputPath, "old handoff\n", { mode: 0o644 });
    chmodSync(outputPath, 0o644);
    const oldInode = statSync(outputPath).ino;

    const result = runCli(
      outputPath,
      framed("http://127.0.0.1:8791", "pairing:atomic-0001", "ATOM-0001")
    );

    expect(result.status).toBe(0);
    expect(statSync(outputPath).ino).not.toBe(oldInode);
    expect(statSync(outputPath).mode & 0o777).toBe(0o600);
    expect(readdirSync(directory)).toEqual([basename(outputPath)]);
  });

  it("never exposes a missing or partial destination while replacing it", async () => {
    const directory = temporaryDirectory();
    const outputPath = join(directory, "member-web-url");
    const oldValue = "old handoff\n";
    const newValue =
      "http://127.0.0.1:8791/member/#pairingRef=pairing%3Aatomic-window&code=ATOM-WINDOW\n";
    writeFileSync(outputPath, oldValue, { mode: 0o600 });
    const observations: Array<string | "MISSING"> = [readFileSync(outputPath, "utf8")];
    let running = true;
    const observer = (async () => {
      while (running) {
        try {
          observations.push(readFileSync(outputPath, "utf8"));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            observations.push("MISSING");
          } else {
            throw error;
          }
        }
        await new Promise(resolve => setImmediate(resolve));
      }
    })();

    const status = await runCliAsync(
      outputPath,
      framed("http://127.0.0.1:8791", "pairing:atomic-window", "ATOM-WINDOW")
    );
    running = false;
    await observer;
    observations.push(readFileSync(outputPath, "utf8"));

    expect(status).toBe(0);
    expect(observations).toContain(oldValue);
    expect(observations).toContain(newValue);
    expect(new Set(observations)).toEqual(new Set([oldValue, newValue]));
  });

  it("replaces an existing symlink without changing its victim", () => {
    const directory = temporaryDirectory();
    const victimPath = join(directory, "victim");
    const outputPath = join(directory, "member-web-url");
    writeFileSync(victimPath, "victim stays intact\n", { mode: 0o640 });
    chmodSync(victimPath, 0o640);
    symlinkSync(victimPath, outputPath);

    const result = runCli(
      outputPath,
      framed("http://127.0.0.1:8791", "pairing:symlink", "SYMLINK")
    );

    expect(result.status).toBe(0);
    expect(lstatSync(outputPath).isSymbolicLink()).toBe(false);
    expect(statSync(outputPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(victimPath, "utf8")).toBe("victim stays intact\n");
    expect(statSync(victimPath).mode & 0o777).toBe(0o640);
  });

  it("keeps successful stdout and stderr empty and sends no secret sentinel in argv", () => {
    const directory = temporaryDirectory();
    const outputPath = join(directory, "member-web-url");
    const pairingRef = "pairing:ARGV-PAIRING-SENTINEL";
    const code = "ARGV-CODE-SENTINEL";
    const argv = [helper, outputPath];

    expect(argv.join("\n")).not.toContain(pairingRef);
    expect(argv.join("\n")).not.toContain(code);

    const result = runCli(
      outputPath,
      framed("http://127.0.0.1:8791", pairingRef, code)
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it.each([
    [
      "missing",
      "http://MISSING-BASE-SENTINEL\u0000pairing:MISSING-PAIRING-SENTINEL\u0000"
    ],
    [
      "empty",
      "http://EMPTY-BASE-SENTINEL\u0000\u0000EMPTY-CODE-SENTINEL\u0000"
    ],
    [
      "extra",
      "http://EXTRA-BASE-SENTINEL\u0000pairing:EXTRA-PAIRING-SENTINEL\u0000EXTRA-CODE-SENTINEL\u0000EXTRA-FIELD-SENTINEL\u0000"
    ],
    [
      "unterminated",
      "http://UNTERMINATED-BASE-SENTINEL\u0000pairing:UNTERMINATED-PAIRING-SENTINEL\u0000UNTERMINATED-CODE-SENTINEL"
    ]
  ])(
    "rejects %s framing without creating or replacing the destination or echoing input",
    (_name, input) => {
      const directory = temporaryDirectory();
      const outputPath = join(directory, "member-web-url");
      writeFileSync(outputPath, "keep existing handoff\n", { mode: 0o640 });
      chmodSync(outputPath, 0o640);
      const before = statSync(outputPath);

      const result = runCli(outputPath, input);

      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("MEMBER_HANDOFF_INPUT_INVALID\n");
      expect(`${result.stdout}${result.stderr}`).not.toContain("SENTINEL");
      expect(readFileSync(outputPath, "utf8")).toBe("keep existing handoff\n");
      expect(statSync(outputPath).ino).toBe(before.ino);
      expect(statSync(outputPath).mode & 0o777).toBe(0o640);
      expect(readdirSync(directory)).toEqual([basename(outputPath)]);
    }
  );

  it("rejects malformed UTF-8 without replacing the destination", () => {
    const directory = temporaryDirectory();
    const outputPath = join(directory, "member-web-url");
    writeFileSync(outputPath, "keep utf8 destination\n", { mode: 0o600 });
    const invalidUtf8 = Buffer.concat([
      Buffer.from("http://UTF8-BASE-SENTINEL\u0000pairing:UTF8-PAIRING-SENTINEL\u0000"),
      Buffer.from([0xc3, 0x28]),
      Buffer.from("\u0000")
    ]);

    const result = runCli(outputPath, invalidUtf8);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("MEMBER_HANDOFF_INPUT_INVALID\n");
    expect(`${result.stdout}${result.stderr}`).not.toContain("SENTINEL");
    expect(readFileSync(outputPath, "utf8")).toBe("keep utf8 destination\n");
    expect(readdirSync(directory)).toEqual([basename(outputPath)]);
  });

  it("rejects secret-bearing extra argv without creating the destination or echoing it", () => {
    const directory = temporaryDirectory();
    const outputPath = join(directory, "member-web-url");
    const extraArgv = "ARGV-EXTRA-SECRET-SENTINEL";

    const result = runCli(
      outputPath,
      framed("http://127.0.0.1:8791", "pairing:valid", "VALID-CODE"),
      [extraArgv]
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("MEMBER_HANDOFF_INPUT_INVALID\n");
    expect(`${result.stdout}${result.stderr}`).not.toContain(extraArgv);
    expect(readdirSync(directory)).toEqual([]);
  });

  it("uses the same URL format and 0600 mode through the export and CLI", async () => {
    const directory = temporaryDirectory();
    const exportedPath = join(directory, "exported-member-web-url");
    const cliPath = join(directory, "cli-member-web-url");
    const input = {
      baseUrl: "http://127.0.0.1:8791",
      pairingRef: "pairing:shared format/0001",
      code: "SHARED CODE/+"
    };
    const module = await import(`${pathToFileURL(helper).href}?test=${Date.now()}`);

    await module.writeMemberHandoff({ outputPath: exportedPath, ...input });
    const cliResult = runCli(
      cliPath,
      framed(input.baseUrl, input.pairingRef, input.code)
    );

    expect(cliResult.status).toBe(0);
    expect(readFileSync(exportedPath, "utf8")).toBe(readFileSync(cliPath, "utf8"));
    expect(readFileSync(exportedPath, "utf8")).toBe(
      "http://127.0.0.1:8791/member/#pairingRef=pairing%3Ashared+format%2F0001&code=SHARED+CODE%2F%2B\n"
    );
    expect(statSync(exportedPath).mode & 0o777).toBe(0o600);
    expect(statSync(cliPath).mode & 0o777).toBe(0o600);
  });
});
