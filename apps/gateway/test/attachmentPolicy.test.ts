import { describe, expect, it } from "vitest";
import {
  inspectAttachmentPrefix,
  normalizeAttachmentName
} from "../src/attachmentPolicy.js";

describe("attachment allowlist policy", () => {
  it.each([
    ["report.pdf", "application/pdf", Buffer.from("%PDF-1.7"), "application/pdf"],
    ["photo.png", "image/png", Buffer.from("89504e470d0a1a0a", "hex"), "image/png"],
    ["photo.jpg", "image/jpeg", Buffer.from("ffd8ffe000104a46", "hex"), "image/jpeg"],
    ["photo.gif", "image/gif", Buffer.from("GIF89a"), "image/gif"],
    ["photo.webp", "image/webp", Buffer.from("524946460000000057454250", "hex"), "image/webp"],
    [
      "report.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      Buffer.from("504b0304", "hex"),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ],
    [
      "legacy.doc",
      "application/msword",
      Buffer.from("d0cf11e0a1b11ae1", "hex"),
      "application/msword"
    ],
    ["notes.md", "text/markdown", Buffer.from("# 会议记录\n", "utf8"), "text/markdown"],
    ["main.ts", "text/plain", Buffer.from("export const value = 1;\n", "utf8"), "text/plain"]
  ])("accepts %s when signature and declaration agree", (
    fileName,
    declaredMediaType,
    prefix,
    detectedMediaType
  ) => {
    expect(inspectAttachmentPrefix({
      fileName,
      declaredMediaType,
      prefix
    })).toEqual({
      detectedMediaType,
      kind: detectedMediaType.startsWith("text/")
        ? "utf8-text"
        : "binary"
    });
  });

  it.each([
    ["archive.zip", "application/zip", Buffer.from("504b0304", "hex")],
    ["program.exe", "application/octet-stream", Buffer.from("4d5a9000", "hex")],
    ["program", "application/octet-stream", Buffer.from("7f454c46", "hex")],
    ["setup.sh", "text/plain", Buffer.from("#!/bin/sh\n")],
    ["setup.ps1", "text/plain", Buffer.from("Write-Host bad\n")],
    ["report.pdf.exe", "application/pdf", Buffer.from("%PDF-1.7")],
    ["report.pdf", "image/png", Buffer.from("%PDF-1.7")],
    ["notes.txt", "text/plain", Buffer.from([0x66, 0x00, 0x6f])]
  ])("rejects unsafe or mismatched upload %s", (fileName, declaredMediaType, prefix) => {
    expect(() => inspectAttachmentPrefix({
      fileName,
      declaredMediaType,
      prefix
    })).toThrow();
  });

  it("normalizes a plain filename but rejects paths and controls", () => {
    expect(normalizeAttachmentName("  家庭 报告.pdf  ")).toBe("家庭 报告.pdf");
    expect(() => normalizeAttachmentName("../report.pdf")).toThrow();
    expect(() => normalizeAttachmentName("folder/report.pdf")).toThrow();
    expect(() => normalizeAttachmentName("bad\u0000name.txt")).toThrow();
    expect(() => normalizeAttachmentName("a".repeat(256))).toThrow();
  });
});
