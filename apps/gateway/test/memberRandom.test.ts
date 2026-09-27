import { describe, expect, it } from "vitest";
import { secureRandomUuid } from "../member-public/pairing.js";

describe("Member secure random UUID", () => {
  it("falls back to getRandomValues with RFC 4122 version and variant bits", () => {
    const uuid = secureRandomUuid({
      getRandomValues(bytes: Uint8Array) {
        bytes.forEach((_, index) => { bytes[index] = index; });
        return bytes;
      }
    });
    expect(uuid).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
  });

  it("fails closed when no cryptographic source exists", () => {
    expect(() => secureRandomUuid({})).toThrow("SECURE_RANDOM_UNAVAILABLE");
  });
});
