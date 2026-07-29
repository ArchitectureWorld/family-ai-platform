import { extname } from "node:path";

type AttachmentKind = "binary" | "utf8-text";

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".csv", ".json", ".xml", ".yaml", ".yml",
  ".toml", ".ini", ".log", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".css", ".html", ".htm", ".py", ".java", ".c", ".h", ".cc", ".cpp",
  ".hpp", ".cs", ".go", ".rs", ".swift", ".kt", ".kts", ".rb", ".php",
  ".sql", ".r", ".scala", ".vue", ".svelte"
]);

const UNSAFE_EXTENSIONS = new Set([
  ".exe", ".dll", ".com", ".scr", ".msi", ".app", ".dmg", ".deb", ".rpm",
  ".bat", ".cmd", ".ps1", ".sh", ".bash", ".zsh", ".fish", ".jar",
  ".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz"
]);

const OOXML_TYPES = new Map([
  [
    ".docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ],
  [
    ".xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  ],
  [
    ".pptx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  ]
]);

const LEGACY_OFFICE_TYPES = new Map([
  [".doc", "application/msword"],
  [".xls", "application/vnd.ms-excel"],
  [".ppt", "application/vnd.ms-powerpoint"]
]);

function policyError(code: string, message: string): Error {
  const error = new Error(message);
  Object.defineProperty(error, "code", {
    value: code,
    enumerable: true
  });
  return error;
}

function beginsWith(value: Buffer, signature: readonly number[]): boolean {
  return (
    value.length >= signature.length &&
    signature.every((byte, index) => value[index] === byte)
  );
}

function declaredEquals(actual: string, expected: string): void {
  if (actual !== expected) {
    throw policyError(
      "ATTACHMENT_TYPE_MISMATCH",
      "附件声明类型与文件内容不一致。"
    );
  }
}

function isExecutableSignature(prefix: Buffer): boolean {
  return (
    beginsWith(prefix, [0x4d, 0x5a]) ||
    beginsWith(prefix, [0x7f, 0x45, 0x4c, 0x46]) ||
    beginsWith(prefix, [0xfe, 0xed, 0xfa, 0xce]) ||
    beginsWith(prefix, [0xfe, 0xed, 0xfa, 0xcf]) ||
    beginsWith(prefix, [0xcf, 0xfa, 0xed, 0xfe]) ||
    beginsWith(prefix, [0xce, 0xfa, 0xed, 0xfe])
  );
}

export function normalizeAttachmentName(fileName: string): string {
  if (typeof fileName !== "string") {
    throw policyError("ATTACHMENT_NAME_INVALID", "附件名称无效。");
  }
  const normalized = fileName.normalize("NFC").trim();
  if (
    normalized.length < 1 ||
    normalized.length > 255 ||
    normalized === "." ||
    normalized === ".." ||
    /[\/\\\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw policyError("ATTACHMENT_NAME_INVALID", "附件名称无效。");
  }
  return normalized;
}

export function inspectAttachmentPrefix(input: {
  fileName: string;
  declaredMediaType: string;
  prefix: Buffer;
}): { detectedMediaType: string; kind: AttachmentKind } {
  const fileName = normalizeAttachmentName(input.fileName);
  const extension = extname(fileName).toLowerCase();
  const declaredMediaType = input.declaredMediaType.trim().toLowerCase();
  const prefix = input.prefix;

  if (UNSAFE_EXTENSIONS.has(extension) || isExecutableSignature(prefix)) {
    throw policyError("ATTACHMENT_TYPE_FORBIDDEN", "不支持这种附件类型。");
  }

  if (beginsWith(prefix, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    if (extension !== ".pdf") {
      throw policyError("ATTACHMENT_TYPE_MISMATCH", "PDF 扩展名不正确。");
    }
    declaredEquals(declaredMediaType, "application/pdf");
    return { detectedMediaType: "application/pdf", kind: "binary" };
  }

  const imageSignatures: Array<{
    extension: string;
    mediaType: string;
    matches: boolean;
  }> = [
    {
      extension: ".png",
      mediaType: "image/png",
      matches: beginsWith(prefix, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    },
    {
      extension: ".jpg",
      mediaType: "image/jpeg",
      matches: beginsWith(prefix, [0xff, 0xd8, 0xff])
    },
    {
      extension: ".gif",
      mediaType: "image/gif",
      matches:
        prefix.subarray(0, 6).toString("ascii") === "GIF87a" ||
        prefix.subarray(0, 6).toString("ascii") === "GIF89a"
    },
    {
      extension: ".webp",
      mediaType: "image/webp",
      matches:
        prefix.subarray(0, 4).toString("ascii") === "RIFF" &&
        prefix.subarray(8, 12).toString("ascii") === "WEBP"
    }
  ];
  const image = imageSignatures.find((candidate) => candidate.matches);
  if (image) {
    if (
      extension !== image.extension &&
      !(image.mediaType === "image/jpeg" && extension === ".jpeg")
    ) {
      throw policyError("ATTACHMENT_TYPE_MISMATCH", "图片扩展名不正确。");
    }
    declaredEquals(declaredMediaType, image.mediaType);
    return { detectedMediaType: image.mediaType, kind: "binary" };
  }

  if (beginsWith(prefix, [0x50, 0x4b, 0x03, 0x04])) {
    const expected = OOXML_TYPES.get(extension);
    if (!expected) {
      throw policyError("ATTACHMENT_TYPE_FORBIDDEN", "不支持压缩归档附件。");
    }
    declaredEquals(declaredMediaType, expected);
    return { detectedMediaType: expected, kind: "binary" };
  }

  if (beginsWith(prefix, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    const expected = LEGACY_OFFICE_TYPES.get(extension);
    if (!expected) {
      throw policyError("ATTACHMENT_TYPE_MISMATCH", "Office 扩展名不正确。");
    }
    declaredEquals(declaredMediaType, expected);
    return { detectedMediaType: expected, kind: "binary" };
  }

  if (TEXT_EXTENSIONS.has(extension)) {
    if (
      declaredMediaType !== "text/plain" &&
      !declaredMediaType.startsWith("text/") &&
      declaredMediaType !== "application/json" &&
      declaredMediaType !== "application/xml"
    ) {
      throw policyError("ATTACHMENT_TYPE_MISMATCH", "文本附件类型不正确。");
    }
    if (prefix.includes(0)) {
      throw policyError("ATTACHMENT_TEXT_INVALID", "文本附件包含无效字节。");
    }
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(prefix);
    } catch {
      throw policyError("ATTACHMENT_TEXT_INVALID", "文本附件不是有效 UTF-8。");
    }
    return { detectedMediaType: declaredMediaType, kind: "utf8-text" };
  }

  throw policyError("ATTACHMENT_TYPE_FORBIDDEN", "不支持这种附件类型。");
}
