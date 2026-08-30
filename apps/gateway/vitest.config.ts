import { defineConfig, type UserConfig } from "vitest/config";

type GatewayVitestTimeouts = Pick<
  NonNullable<UserConfig["test"]>,
  "hookTimeout" | "testTimeout"
>;

export function resolveGatewayVitestTimeouts(
  containerBuild: string | undefined
): GatewayVitestTimeouts {
  return containerBuild === "1"
    ? { hookTimeout: 20_000, testTimeout: 20_000 }
    : {};
}

export default defineConfig({
  test: resolveGatewayVitestTimeouts(process.env.FAMILY_AI_CONTAINER_BUILD)
});
