import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const libraryPath = join(root, "scripts", "member-preview-lan-lib.mjs");

function read(relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8");
}

async function library() {
  return import(`${pathToFileURL(libraryPath).href}?test=${Date.now()}-${Math.random()}`);
}

describe("LAN Preview pure boundary", () => {
  it("accepts only canonical RFC1918 IPv4 addresses and renders public URLs", async () => {
    const {
      lanUrls,
      privateIpv4FromRoute,
      validatePrivateIpv4
    } = await library();
    for (const value of ["10.0.0.1", "172.16.0.1", "172.31.255.254", "192.168.110.84"]) {
      expect(validatePrivateIpv4(value)).toBe(value);
    }
    for (const value of [
      "127.0.0.1",
      "169.254.1.1",
      "172.15.0.1",
      "172.32.0.1",
      "8.8.8.8",
      "192.168.001.1",
      "192.168.110.84/24",
      "::1",
      "example.com"
    ]) {
      expect(() => validatePrivateIpv4(value), value).toThrow("LAN_PRIVATE_IPV4_INVALID");
    }
    expect(lanUrls("192.168.110.84")).toEqual({
      ca: "http://192.168.110.84:9080/family-ai-preview-ca.crt",
      root: "https://192.168.110.84:9443/",
      admin: "https://192.168.110.84:9443/admin/",
      member: "https://192.168.110.84:9443/member/"
    });
    expect(privateIpv4FromRoute([{
      dst: "1.1.1.1",
      dev: "wlp2s0",
      prefsrc: "192.168.110.84"
    }])).toBe("192.168.110.84");
    for (const route of [
      [],
      [{ dst: "1.1.1.1", prefsrc: "127.0.0.1" }],
      [{ dst: "1.1.1.1", prefsrc: "192.168.110.84" }, { prefsrc: "10.0.0.2" }],
      { prefsrc: "192.168.110.84" }
    ]) {
      expect(() => privateIpv4FromRoute(route), JSON.stringify(route))
        .toThrow("LAN_ROUTE_INVALID");
    }
  });

  it("renders an isolated Nginx config with a CA-only HTTP surface", async () => {
    const { renderLeafExtensions, renderNginxConfig } = await library();
    const runtimeDir = "/tmp/family-ai-lan-preview";
    const extensions = renderLeafExtensions("192.168.110.84");
    expect(extensions).toContain("subjectAltName=IP:192.168.110.84");
    expect(extensions).toContain("extendedKeyUsage=serverAuth");

    const config = renderNginxConfig({
      ip: "192.168.110.84",
      runtimeDir
    });
    expect(config).toContain("listen 0.0.0.0:9080");
    expect(config).toContain("listen 0.0.0.0:9443 ssl");
    expect(config).toContain("location = /family-ai-preview-ca.crt");
    expect(config).toContain(`alias ${runtimeDir}/lan-tls/ca.crt`);
    expect(config).toContain("location / {\n      return 404;");
    expect(config).toContain("location = / {\n      return 302 /admin/;");
    expect(config).toContain("proxy_pass http://127.0.0.1:8791");
    expect(config).toContain("proxy_set_header Host $http_host");
    expect(config).toContain("proxy_set_header X-Forwarded-Proto https");
    expect(config).toContain("proxy_buffering off");
    expect(config).toContain("access_log off");
    expect(config).not.toContain("/etc/nginx");
    expect(config).not.toContain("8790");
  });

  it("fails closed on excessive or mismatched certificate metadata", async () => {
    const { validateTlsMetadata } = await library();
    const now = Date.parse("2026-07-28T00:00:00.000Z");
    expect(validateTlsMetadata({
      now,
      ip: "192.168.110.84",
      caNotAfter: "2027-07-28T00:00:00.000Z",
      leafNotAfter: "2026-08-27T00:00:00.000Z",
      leafSanIp: "192.168.110.84"
    })).toEqual({
      caRemainingMs: 365 * 24 * 60 * 60 * 1000,
      leafRemainingMs: 30 * 24 * 60 * 60 * 1000
    });
    for (const override of [
      { caNotAfter: "2027-07-30T00:00:00.000Z" },
      { leafNotAfter: "2026-08-29T00:00:00.000Z" },
      { leafNotAfter: "2026-07-28T00:30:00.000Z" },
      { leafSanIp: "192.168.110.85" }
    ]) {
      expect(() => validateTlsMetadata({
        now,
        ip: "192.168.110.84",
        caNotAfter: "2027-07-28T00:00:00.000Z",
        leafNotAfter: "2026-08-27T00:00:00.000Z",
        leafSanIp: "192.168.110.84",
        ...override
      })).toThrow("LAN_TLS_METADATA_INVALID");
    }
  });
});

describe("LAN Preview lifecycle scripts", () => {
  it.each([
    "scripts/member-preview-lan-up.sh",
    "scripts/member-preview-lan-down.sh"
  ])("provides %s", relativePath => {
    expect(existsSync(join(root, relativePath))).toBe(true);
  });

  it("pins startup to the approved host, worktree, ports, TLS and isolated Nginx", () => {
    const up = read("scripts/member-preview-lan-up.sh");
    for (const required of [
      "hostname -s",
      "id -un",
      "$REMOTE_USER_HOME/Development/family-ai-platform",
      'branch --show-current)" == "main"',
      "member-preview-up.sh",
      "ip -json -4 route get",
      "192.168",
      "9080",
      "9443",
      "openssl",
      "prime256v1",
      "lan-tls",
      "nginx -p",
      "daemon off",
      "127.0.0.1:8791",
      "baseline-8790",
      "member-preview-admin.mjs"
    ]) {
      expect(up, required).toContain(required);
    }
    expect(up).not.toContain("family-ai-platform-worktrees");
    expect(up).not.toMatch(/systemctl|service\s+nginx|\/etc\/nginx|ufw|docker\s+compose/);
  });

  it("uses exact process ownership and pidfd shutdown without touching the Gateway", () => {
    const down = read("scripts/member-preview-lan-down.sh");
    for (const required of [
      "/proc/",
      "starttime",
      "os.pidfd_open",
      "signal.pidfd_send_signal",
      "select.poll",
      "lan-nginx.pid.json",
      "9080",
      "9443",
      "baseline-8790"
    ]) {
      expect(down, required).toContain(required);
    }
    expect(down).not.toMatch(/pkill|killall|fuser|systemctl|member-preview-down\.sh/);
  });
});
