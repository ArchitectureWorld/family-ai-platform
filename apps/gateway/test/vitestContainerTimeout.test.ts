import { describe, expect, it } from "vitest";

import { resolveGatewayVitestTimeouts } from "../vitest.config.js";

describe("Gateway Vitest container timeout policy", () => {
  it("keeps host runs on Vitest defaults and enables only the exact container flag", () => {
    expect(resolveGatewayVitestTimeouts(undefined)).toEqual({});
    expect(resolveGatewayVitestTimeouts("0")).toEqual({});
    expect(resolveGatewayVitestTimeouts("true")).toEqual({});
    expect(resolveGatewayVitestTimeouts("1")).toEqual({
      hookTimeout: 20_000,
      testTimeout: 20_000
    });
  });
});
