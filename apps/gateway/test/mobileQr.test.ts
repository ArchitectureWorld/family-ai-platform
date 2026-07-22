import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const publicDirectory = fileURLToPath(new URL("../public/", import.meta.url));

async function loadQrModule() {
  const source = readFileSync(join(publicDirectory, "qr-v10.mjs"), "utf8");
  const encoded = Buffer.from(source, "utf8").toString("base64");
  return import(`data:text/javascript;base64,${encoded}`) as Promise<{
    createQrMatrix(value: string): boolean[][];
    createQrSvg(value: string, options?: { title?: string }): string;
  }>;
}

describe("local mobile pairing QR encoder", () => {
  it("encodes a maximum practical Contract payload without network dependencies", async () => {
    const host = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(55)}`;
    expect(host.length).toBe(247);
    const gateway = `https://${host}`;
    const pairingRef = `pairing:${"x".repeat(120)}`;
    const code = "ABCD-EFGH";
    const expiresAt = "2026-07-22T12:05:00.000Z";
    const query = new URLSearchParams({
      v: "1",
      gateway,
      pairingRef,
      code,
      expiresAt
    });
    const payload = `familyai://pair#${query.toString()}`;

    const { createQrMatrix, createQrSvg } = await loadQrModule();
    const matrix = createQrMatrix(payload);
    expect(matrix).toHaveLength(97);
    expect(matrix.every((row) => row.length === 97 && row.every((value) => typeof value === "boolean")))
      .toBe(true);

    const svg = createQrSvg(payload, { title: "Mobile Entry QR" });
    expect(svg).toContain('viewBox="0 0 105 105"');
    expect(svg).toContain("Mobile Entry QR");
    expect(svg).not.toContain(code);
    expect(svg).not.toContain(gateway);
  });
});
