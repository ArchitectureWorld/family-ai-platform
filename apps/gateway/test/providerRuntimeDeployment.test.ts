import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const composePath = fileURLToPath(new URL("../../../compose.yaml", import.meta.url));
const devUpPath = fileURLToPath(new URL("../../../scripts/dev-up.sh", import.meta.url));

describe("Hermes runtime deployment wiring", () => {
  it("mounts runtime provider configuration read-only and resolves the Docker host", () => {
    const compose = readFileSync(composePath, "utf8");
    expect(compose).toContain('"host.docker.internal:host-gateway"');
    expect(compose).toContain("./.runtime/config:/app/.runtime/config:ro");
    expect(compose).toContain('"127.0.0.1:8790:8790"');
  });

  it("enables the Provider config only when the ignored runtime JSON exists", () => {
    const script = readFileSync(devUpPath, "utf8");
    expect(script).toContain('PROVIDER_CONFIG_FILE="$CONFIG_DIR/providers.json"');
    expect(script).toMatch(/if \[\[ -f "\$PROVIDER_CONFIG_FILE" \]\]; then/);
    expect(script).toContain(
      "GATEWAY_PROVIDER_CONFIG_PATH=/app/.runtime/config/providers.json"
    );
    expect(script).not.toContain("cat \"$PROVIDER_CONFIG_FILE\"");
  });
});
