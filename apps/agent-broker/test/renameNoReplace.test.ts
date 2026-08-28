import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];
const helper = fileURLToPath(
  new URL("../runtime/rename_noreplace.py", import.meta.url)
);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { force: true, recursive: true })
    )
  );
});

async function invoke(frame: unknown): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  return await new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/python3", [helper], {
      env: {},
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (exitCode) =>
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      })
    );
    child.stdin.end(`${JSON.stringify(frame)}\n`);
  });
}

describe("rename_noreplace helper", () => {
  it("atomically renames when the destination is absent", async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "rename-noreplace-"));
    temporaryDirectories.push(runtimeDirectory);
    const source = join(runtimeDirectory, "source");
    const destination = join(runtimeDirectory, "destination");
    await writeFile(source, "owned object", "utf8");

    const result = await invoke({
      protocolVersion: 1,
      runtimeDirectory,
      source,
      destination
    });

    expect(result).toEqual({
      exitCode: 0,
      stdout: '{"status":"renamed"}\n',
      stderr: ""
    });
    await expect(access(source)).rejects.toThrow();
    expect(await readFile(destination, "utf8")).toBe("owned object");
  });

  it("reports destination_exists and preserves both objects without overwrite", async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "rename-noreplace-"));
    temporaryDirectories.push(runtimeDirectory);
    const source = join(runtimeDirectory, "source");
    const destination = join(runtimeDirectory, "destination");
    await writeFile(source, "source object", "utf8");
    await writeFile(destination, "destination object", "utf8");

    const result = await invoke({
      protocolVersion: 1,
      runtimeDirectory,
      source,
      destination
    });

    expect(result.stdout).toBe('{"status":"destination_exists"}\n');
    expect(await readFile(source, "utf8")).toBe("source object");
    expect(await readFile(destination, "utf8")).toBe("destination object");
  });

  it("rejects malformed bounded input without echoing it", async () => {
    const result = await invoke({
      protocolVersion: 1,
      source: "SENTINEL_SECRET"
    });

    expect(result.stdout).toBe('{"status":"invalid"}\n');
    expect(`${result.stdout}${result.stderr}`).not.toContain("SENTINEL_SECRET");
  });
});
