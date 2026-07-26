import { describe, expect, it } from "vitest";
import {
  decodeCanonicalWebDeviceCredential,
  deriveWebClaimEntryToken
} from "../src/webEntryCrypto.js";

describe("web entry credential crypto", () => {
  it("derives the fixed v2 claim-session vector", () => {
    const credential = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    expect(decodeCanonicalWebDeviceCredential(credential)).toHaveLength(32);
    expect(deriveWebClaimEntryToken(credential, "pairing:web-alice-0001"))
      .toBe("-dlmHncaTJJzTa7rq-30_N_VkSGf-Ep3EDeDdMaze08");
  });

  it.each([
    "",
    "A".repeat(42),
    "A".repeat(44),
    "A".repeat(42) + "/",
    "A".repeat(42) + "B"
  ])("rejects non-canonical Credential %j", (credential) => {
    expect(() => decodeCanonicalWebDeviceCredential(credential))
      .toThrow("WEB_DEVICE_CREDENTIAL_INVALID");
  });
});
