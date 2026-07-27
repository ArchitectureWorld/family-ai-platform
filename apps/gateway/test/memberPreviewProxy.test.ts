import {
  createServer,
  request as httpRequest,
  type Server,
  type ServerResponse
} from "node:http";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const expectedRecoveryRoot = root.replace(/\/$/, "");
const proxyPath = join(root, "scripts/member-preview-claim-loss-proxy.mjs");
const directories: string[] = [];
const servers: Server[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "family-ai-preview-proxy-"));
  directories.push(directory);
  return directory;
}

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("LISTEN_FAILED");
  return address.port;
}

async function loadProxy() {
  expect(existsSync(proxyPath)).toBe(true);
  return import(`${pathToFileURL(proxyPath).href}?test=${Date.now()}-${Math.random()}`);
}

function request(
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string> } = {},
  body = ""
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  rawHeaders: string[];
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const client = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: options.method ?? "GET",
        path: options.path ?? "/",
        headers: options.headers
      },
      response => {
        const chunks: Buffer[] = [];
        response.on("data", chunk => chunks.push(Buffer.from(chunk)));
        response.once("aborted", () => reject(new Error("DOWNSTREAM_ABORTED")));
        response.once("error", reject);
        response.once("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            rawHeaders: response.rawHeaders,
            body: Buffer.concat(chunks).toString("utf8")
          })
        );
      }
    );
    client.once("error", reject);
    if (body) client.write(body);
    client.end();
  });
}

async function outcome<T>(promise: Promise<T>): Promise<
  { kind: "response"; value: T } | { kind: "failure"; error: Error }
> {
  try {
    return { kind: "response", value: await promise };
  } catch (error) {
    return { kind: "failure", error: error as Error };
  }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`TIMEOUT_${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function stateName(stateFile: string): string | undefined {
  if (!existsSync(stateFile)) return undefined;
  try {
    return JSON.parse(readFileSync(stateFile, "utf8")).state;
  } catch {
    return undefined;
  }
}

function writeInFlightRecoveryFixture(directory: string) {
  const stateFile = join(directory, "state.json");
  const manifestFile = join(directory, "proxy.pid.json");
  const expectedRoot = expectedRecoveryRoot;
  writeFileSync(stateFile, JSON.stringify({
    version: 1,
    state: "in_flight",
    requestId: "request:orphaned-owner",
    timestamp: "2026-07-27T00:00:00.000Z"
  }), { mode: 0o600 });
  writeFileSync(manifestFile, JSON.stringify({
    version: 1,
    kind: "claim_loss_proxy",
    pid: 4242,
    starttime: "987654",
    cwd: expectedRoot,
    entrypoint: "scripts/member-preview-claim-loss-proxy.mjs",
    host: "127.0.0.1",
    port: 8792,
    upstreamOrigin: "http://127.0.0.1:8791",
    launchCommit: "a".repeat(40),
    proxySourceSha256: "b".repeat(64),
    proxyConfigSha256: "c".repeat(64)
  }), { mode: 0o600 });
  return { stateFile, manifestFile, expectedRoot };
}

function rawRequest(port: number, path: string, headers: string[]): Promise<{
  status: number;
  statusMessage: string;
  headers: Record<string, string | string[] | undefined>;
  rawHeaders: string[];
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const client = httpRequest({ host: "127.0.0.1", port, path, headers, agent: false }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.once("aborted", () => reject(new Error("DOWNSTREAM_ABORTED")));
      response.once("error", reject);
      response.once("end", () => resolve({
        status: response.statusCode ?? 0,
        statusMessage: response.statusMessage ?? "",
        headers: response.headers,
        rawHeaders: response.rawHeaders,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    client.once("error", reject);
    client.end();
  });
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("one-shot Claim response-loss proxy", () => {
  it("keeps a proven live Claim-loss owner in flight", async () => {
    const { __proxyInternals } = await loadProxy();
    const fixture = writeInFlightRecoveryFixture(temporaryDirectory());
    const inspector = {
      inspectProcess: async () => ({
        starttime: "987654",
        cwd: fixture.expectedRoot,
        argv: ["/usr/bin/node", "scripts/member-preview-claim-loss-proxy.mjs"]
      }),
      inspectListeners: async () => [{
        localAddress: "127.0.0.1:8792",
        pids: [4242]
      }]
    };

    await expect(__proxyInternals.recoverCliInFlightState(
      fixture.stateFile,
      fixture.manifestFile,
      fixture.expectedRoot,
      inspector
    )).rejects.toThrow("CLAIM_LOSS_IN_FLIGHT");
    expect(stateName(fixture.stateFile)).toBe("in_flight");
  });

  it.each([
    {
      label: "a reused PID with the wrong starttime",
      inspectProcess: async () => ({
        starttime: "111111",
        cwd: expectedRecoveryRoot,
        argv: ["/usr/bin/node", "scripts/member-preview-claim-loss-proxy.mjs"]
      }),
      inspectListeners: async () => []
    },
    {
      label: "a matching PID with the wrong cwd",
      inspectProcess: async () => ({
        starttime: "987654",
        cwd: "/tmp/reused-owner",
        argv: ["/usr/bin/node", "scripts/member-preview-claim-loss-proxy.mjs"]
      }),
      inspectListeners: async () => [{
        localAddress: "127.0.0.1:8792",
        pids: [4242]
      }]
    },
    {
      label: "a matching PID with a non-exact NUL argv",
      inspectProcess: async () => ({
        starttime: "987654",
        cwd: expectedRecoveryRoot,
        argv: ["/usr/bin/node", "scripts/member-preview-claim-loss-proxy.mjs", "--unexpected"]
      }),
      inspectListeners: async () => [{
        localAddress: "127.0.0.1:8792",
        pids: [4242]
      }]
    },
    {
      label: "a matching process with a foreign 8792 listener PID",
      inspectProcess: async () => ({
        starttime: "987654",
        cwd: expectedRecoveryRoot,
        argv: ["/usr/bin/node", "scripts/member-preview-claim-loss-proxy.mjs"]
      }),
      inspectListeners: async () => [{
        localAddress: "127.0.0.1:8792",
        pids: [9999]
      }]
    },
    {
      label: "an absent PID while any 8792 listener exists",
      inspectProcess: async () => null,
      inspectListeners: async () => [{
        localAddress: "127.0.0.1:8792",
        pids: [9999]
      }]
    }
  ])("fails closed for $label", async ({ inspectProcess, inspectListeners }) => {
    const { __proxyInternals } = await loadProxy();
    const fixture = writeInFlightRecoveryFixture(temporaryDirectory());

    await expect(__proxyInternals.recoverCliInFlightState(
      fixture.stateFile,
      fixture.manifestFile,
      fixture.expectedRoot,
      { inspectProcess, inspectListeners }
    )).rejects.toThrow("CLAIM_LOSS_STARTUP_AMBIGUOUS");
    expect(stateName(fixture.stateFile)).toBe("in_flight");
  });

  it("re-arms only when PID is absent, 8792 is unbound and the manifest is stable", async () => {
    const { __proxyInternals } = await loadProxy();
    const fixture = writeInFlightRecoveryFixture(temporaryDirectory());
    const inspector = {
      inspectProcess: async () => null,
      inspectListeners: async () => []
    };

    await expect(__proxyInternals.recoverCliInFlightState(
      fixture.stateFile,
      fixture.manifestFile,
      fixture.expectedRoot,
      inspector
    )).resolves.toBe("rearmed");
    expect(existsSync(fixture.stateFile)).toBe(false);
  });

  it("preserves in-flight state when the manifest changes during recovery", async () => {
    const { __proxyInternals } = await loadProxy();
    const fixture = writeInFlightRecoveryFixture(temporaryDirectory());
    let listenerChecks = 0;
    const inspector = {
      inspectProcess: async () => null,
      inspectListeners: async () => {
        listenerChecks += 1;
        if (listenerChecks === 1) {
          const changed = JSON.parse(readFileSync(fixture.manifestFile, "utf8"));
          changed.proxyConfigSha256 = "d".repeat(64);
          writeFileSync(fixture.manifestFile, JSON.stringify(changed), { mode: 0o600 });
        }
        return [];
      }
    };

    await expect(__proxyInternals.recoverCliInFlightState(
      fixture.stateFile,
      fixture.manifestFile,
      fixture.expectedRoot,
      inspector
    )).rejects.toThrow("CLAIM_LOSS_STARTUP_AMBIGUOUS");
    expect(stateName(fixture.stateFile)).toBe("in_flight");
  });

  it.each([
    {
      label: "state mode is not 0600",
      prepare: ({ stateFile }) => chmodSync(stateFile, 0o644),
      code: "CLAIM_LOSS_INVALID_STATE"
    },
    {
      label: "manifest is a symlink",
      prepare: ({ manifestFile }) => {
        const target = `${manifestFile}.target`;
        writeFileSync(target, readFileSync(manifestFile), { mode: 0o600 });
        rmSync(manifestFile);
        symlinkSync(target, manifestFile);
      },
      code: "CLAIM_LOSS_STARTUP_AMBIGUOUS"
    },
    {
      label: "manifest exceeds the bounded size",
      prepare: ({ manifestFile }) => {
        writeFileSync(manifestFile, "x".repeat(16385), { mode: 0o600 });
      },
      code: "CLAIM_LOSS_STARTUP_AMBIGUOUS"
    }
  ])("fails closed when protected recovery $label", async ({ prepare, code }) => {
    const { __proxyInternals } = await loadProxy();
    const fixture = writeInFlightRecoveryFixture(temporaryDirectory());
    prepare(fixture);

    await expect(__proxyInternals.recoverCliInFlightState(
      fixture.stateFile,
      fixture.manifestFile,
      fixture.expectedRoot,
      {
        inspectProcess: async () => null,
        inspectListeners: async () => []
      }
    )).rejects.toThrow(code);
    expect(stateName(fixture.stateFile)).toBe("in_flight");
  });

  it("preserves in-flight state when state bytes change before locked revalidation", async () => {
    const { __proxyInternals } = await loadProxy();
    const fixture = writeInFlightRecoveryFixture(temporaryDirectory());
    let listenerChecks = 0;
    const inspector = {
      inspectProcess: async () => null,
      inspectListeners: async () => {
        listenerChecks += 1;
        if (listenerChecks === 1) {
          const changed = JSON.parse(readFileSync(fixture.stateFile, "utf8"));
          changed.timestamp = "2026-07-27T00:00:01.000Z";
          writeFileSync(fixture.stateFile, JSON.stringify(changed), { mode: 0o600 });
        }
        return [];
      }
    };

    await expect(__proxyInternals.recoverCliInFlightState(
      fixture.stateFile,
      fixture.manifestFile,
      fixture.expectedRoot,
      inspector
    )).rejects.toThrow("CLAIM_LOSS_STARTUP_AMBIGUOUS");
    expect(stateName(fixture.stateFile)).toBe("in_flight");
  });

  it("exports the proxy and resets only consumed state", async () => {
    const { createClaimLossProxy, resetConsumedClaimLossState } = await loadProxy();
    expect(createClaimLossProxy).toBeTypeOf("function");
    expect(resetConsumedClaimLossState).toBeTypeOf("function");
    const directory = temporaryDirectory();
    const stateFile = join(directory, "state.json");

    await expect(resetConsumedClaimLossState(stateFile)).resolves.toBe("absent");
    writeFileSync(
      stateFile,
      JSON.stringify({
        version: 1,
        state: "consumed",
        requestId: "request:consumed",
        timestamp: "2026-07-27T00:00:00.000Z"
      }),
      { mode: 0o600 }
    );
    await expect(resetConsumedClaimLossState(stateFile)).resolves.toBe("rearmed");
    expect(existsSync(stateFile)).toBe(false);

    writeFileSync(
      stateFile,
      JSON.stringify({
        version: 1,
        state: "in_flight",
        requestId: "request:live",
        timestamp: "2026-07-27T00:00:00.000Z"
      }),
      { mode: 0o600 }
    );
    await expect(resetConsumedClaimLossState(stateFile)).rejects.toThrow(
      "CLAIM_LOSS_IN_FLIGHT"
    );
    expect(readFileSync(stateFile, "utf8")).toContain('"in_flight"');
  });

  it("streams ordinary traffic and filters fixed plus nominated hop headers", async () => {
    const { createClaimLossProxy } = await loadProxy();
    const directory = temporaryDirectory();
    const stateFile = join(directory, "state.json");
    const seen: { host?: string; origin?: string; hop?: string } = {};
    const upstream = createServer((incoming, response) => {
      seen.host = incoming.headers.host;
      seen.origin = incoming.headers.origin;
      seen.hop = incoming.headers["x-request-hop"] as string | undefined;
      response.writeHead(
        207,
        "Preview",
        [
          "content-type",
          "application/json",
          "connection",
          "x-response-hop",
          "x-response-hop",
          "remove-me",
          "x-end-to-end",
          "kept"
        ]
      );
      response.write('{"chunk":');
      setImmediate(() => response.end('"ok"}'));
    });
    const upstreamPort = await listen(upstream);
    const proxy = createClaimLossProxy({
      upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
      stateFile,
      log() {}
    });
    const proxyPort = await listen(proxy);

    const result = await request(proxyPort, {
      path: "/api/example",
      headers: {
        host: "preview.example",
        origin: "http://preview.example",
        connection: "x-request-hop",
        "x-request-hop": "remove-me",
        "x-end-to-end": "kept"
      }
    });

    expect(result).toMatchObject({
      status: 207,
      body: '{"chunk":"ok"}'
    });
    expect(seen).toEqual({
      host: "preview.example",
      origin: "http://preview.example",
      hop: undefined
    });
    expect(result.headers["x-response-hop"]).toBeUndefined();
    expect(result.headers["x-end-to-end"]).toBe("kept");
  });

  it("drops exactly the first completed 204 Claim response and passes retry cookies", async () => {
    const { createClaimLossProxy } = await loadProxy();
    const directory = temporaryDirectory();
    const stateFile = join(directory, "state.json");
    let successfulClaims = 0;
    const upstream = createServer((incoming, response) => {
      if (
        incoming.method === "POST" &&
        incoming.url === "/api/v1/web-entry/pairing/claim"
      ) {
        successfulClaims += 1;
        incoming.resume();
        incoming.on("end", () => {
          response.writeHead(204, [
            "set-cookie",
            "family_ai_entry=a; HttpOnly; Path=/",
            "set-cookie",
            "family_ai_device=b; HttpOnly; Path=/"
          ]);
          response.end();
        });
        return;
      }
      response.writeHead(404).end();
    });
    const upstreamPort = await listen(upstream);
    const proxy = createClaimLossProxy({
      upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
      stateFile,
      log() {}
    });
    const proxyPort = await listen(proxy);
    const options = {
      method: "POST",
      path: "/api/v1/web-entry/pairing/claim",
      headers: {
        "content-type": "application/json",
        "content-length": "2"
      }
    };

    await expect(request(proxyPort, options, "{}")).rejects.toBeTruthy();
    const retry = await request(proxyPort, options, "{}");

    expect(retry.status).toBe(204);
    expect(retry.body).toBe("");
    expect(retry.headers["set-cookie"]).toEqual([
      "family_ai_entry=a; HttpOnly; Path=/",
      "family_ai_device=b; HttpOnly; Path=/"
    ]);
    expect(successfulClaims).toBe(2);
  });

  it("re-arms the owner after a non-204 response and an upstream transport failure", async () => {
    const { createClaimLossProxy } = await loadProxy();
    const directory = temporaryDirectory();
    const stateFile = join(directory, "state.json");
    let attempts = 0;
    const upstream = createServer((incoming, response) => {
      if (incoming.method !== "POST" || incoming.url !== "/api/v1/web-entry/pairing/claim") {
        response.writeHead(404).end();
        return;
      }
      attempts += 1;
      const attempt = attempts;
      incoming.resume();
      incoming.once("end", () => {
        if (attempt === 1) {
          response.writeHead(409, "Pairing Pending", { "content-type": "application/json" });
          response.end('{"code":"PAIRING_PENDING"}');
          return;
        }
        if (attempt === 2) {
          incoming.socket.destroy();
          return;
        }
        response.writeHead(204, ["set-cookie", "entry=after-transport; HttpOnly"]);
        response.end();
      });
    });
    const upstreamPort = await listen(upstream);
    const proxy = createClaimLossProxy({
      upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
      stateFile,
      log() {}
    });
    const proxyPort = await listen(proxy);
    const options = {
      method: "POST",
      path: "/api/v1/web-entry/pairing/claim",
      headers: { "content-length": "2", "content-type": "application/json" }
    };

    const non204 = await request(proxyPort, options, "{}");
    expect(non204).toMatchObject({
      status: 409,
      body: '{"code":"PAIRING_PENDING"}'
    });
    expect(existsSync(stateFile)).toBe(false);

    await expect(request(proxyPort, options, "{}")).rejects.toBeTruthy();
    await waitFor(() => !existsSync(stateFile), "TRANSPORT_REARM");

    await expect(request(proxyPort, options, "{}")).rejects.toBeTruthy();
    await waitFor(() => stateName(stateFile) === "consumed", "POST_TRANSPORT_CONSUMED");
    expect(attempts).toBe(3);
  });

  it("gives exactly one concurrent successful Claim the fault and reset re-arms one later loss", async () => {
    const { createClaimLossProxy, resetConsumedClaimLossState } = await loadProxy();
    const directory = temporaryDirectory();
    const stateFile = join(directory, "state.json");
    let arrivals = 0;
    const firstPair: ServerResponse[] = [];
    const upstream = createServer((incoming, response) => {
      if (incoming.method !== "POST" || incoming.url !== "/api/v1/web-entry/pairing/claim") {
        response.writeHead(404).end();
        return;
      }
      arrivals += 1;
      incoming.resume();
      incoming.once("end", () => {
        if (arrivals <= 2) {
          firstPair.push(response);
          if (firstPair.length < 2) return;
          for (const pending of firstPair.splice(0)) {
            pending.writeHead(204, [
              "set-cookie", "entry=concurrent; HttpOnly",
              "set-cookie", "device=concurrent; HttpOnly"
            ]);
            pending.end();
          }
          return;
        }
        response.writeHead(204, [
          "set-cookie", "entry=rearmed; HttpOnly",
          "set-cookie", "device=rearmed; HttpOnly"
        ]);
        response.end();
      });
    });
    const upstreamPort = await listen(upstream);
    const proxy = createClaimLossProxy({
      upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
      stateFile,
      log() {}
    });
    const proxyPort = await listen(proxy);
    const claim = () => outcome(request(proxyPort, {
      method: "POST",
      path: "/api/v1/web-entry/pairing/claim",
      headers: { "content-length": "2" }
    }, "{}"));

    const concurrent = await Promise.all([claim(), claim()]);
    expect(concurrent.filter(result => result.kind === "failure")).toHaveLength(1);
    const passed = concurrent.filter(result => result.kind === "response");
    expect(passed).toHaveLength(1);
    if (passed[0]?.kind === "response") {
      expect(passed[0].value.status).toBe(204);
      expect(passed[0].value.headers["set-cookie"]).toEqual([
        "entry=concurrent; HttpOnly",
        "device=concurrent; HttpOnly"
      ]);
    }
    await waitFor(() => stateName(stateFile) === "consumed", "CONCURRENT_CONSUMED");

    await expect(resetConsumedClaimLossState(stateFile)).resolves.toBe("rearmed");
    expect(existsSync(stateFile)).toBe(false);
    expect((await claim()).kind).toBe("failure");
    await waitFor(() => stateName(stateFile) === "consumed", "REARMED_CONSUMED");
    const retry = await claim();
    expect(retry.kind).toBe("response");
    if (retry.kind === "response") {
      expect(retry.value.headers["set-cookie"]).toEqual([
        "entry=rearmed; HttpOnly",
        "device=rearmed; HttpOnly"
      ]);
    }
    expect(arrivals).toBe(4);
  });

  it("delivers the first SSE frame before the upstream response ends", async () => {
    const { createClaimLossProxy } = await loadProxy();
    const directory = temporaryDirectory();
    const stateFile = join(directory, "state.json");
    let releaseUpstream!: () => void;
    let upstreamEnded = false;
    const upstream = createServer((_incoming, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: first\n\n");
      releaseUpstream = () => {
        upstreamEnded = true;
        response.end("data: final\n\n");
      };
    });
    const upstreamPort = await listen(upstream);
    const proxy = createClaimLossProxy({
      upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
      stateFile,
      log() {}
    });
    const proxyPort = await listen(proxy);
    let firstFrameResolve!: (frame: string) => void;
    const firstFrame = new Promise<string>(resolve => {
      firstFrameResolve = resolve;
    });
    const completed = new Promise<void>((resolve, reject) => {
      const client = httpRequest({ host: "127.0.0.1", port: proxyPort, path: "/events" }, response => {
        response.once("data", chunk => firstFrameResolve(String(chunk)));
        response.once("end", resolve);
        response.once("error", reject);
      });
      client.once("error", reject);
      client.end();
    });

    await expect(Promise.race([
      firstFrame,
      new Promise((_, reject) => setTimeout(() => reject(new Error("SSE_TIMEOUT")), 2000))
    ])).resolves.toBe("data: first\n\n");
    expect(upstreamEnded).toBe(false);
    releaseUpstream();
    await completed;
  });

  it("persists consumed startup state and fails closed on in-flight or malformed state", async () => {
    const { createClaimLossProxy, resetConsumedClaimLossState } = await loadProxy();
    const directory = temporaryDirectory();
    const consumedFile = join(directory, "consumed.json");
    const inFlightFile = join(directory, "in-flight.json");
    const malformedFile = join(directory, "malformed.json");
    const consumedBytes = JSON.stringify({
      version: 1,
      state: "consumed",
      requestId: "request:consumed-startup",
      timestamp: "2026-07-27T00:00:00.000Z"
    });
    writeFileSync(consumedFile, consumedBytes, { mode: 0o600 });
    writeFileSync(inFlightFile, JSON.stringify({
      version: 1,
      state: "in_flight",
      requestId: "request:startup-live",
      timestamp: "2026-07-27T00:00:00.000Z"
    }), { mode: 0o600 });
    const malformedSentinel = "MALFORMED-STATE-SECRET-SENTINEL";
    writeFileSync(malformedFile, JSON.stringify({ secret: malformedSentinel }), { mode: 0o600 });
    const upstream = createServer((_incoming, response) => response.end("ordinary"));
    const upstreamPort = await listen(upstream);
    const options = {
      upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
      log() {}
    };

    const consumedProxy = createClaimLossProxy({ ...options, stateFile: consumedFile });
    const consumedPort = await listen(consumedProxy);
    expect((await request(consumedPort)).body).toBe("ordinary");
    expect(readFileSync(consumedFile, "utf8")).toBe(consumedBytes);
    expect(() => createClaimLossProxy({ ...options, stateFile: inFlightFile }))
      .toThrow("CLAIM_LOSS_IN_FLIGHT");
    expect(() => createClaimLossProxy({ ...options, stateFile: malformedFile }))
      .toThrow("CLAIM_LOSS_INVALID_STATE");
    await expect(resetConsumedClaimLossState(malformedFile))
      .rejects.toThrow("CLAIM_LOSS_INVALID_STATE");
    try {
      await resetConsumedClaimLossState(malformedFile);
    } catch (error) {
      expect(String(error)).not.toContain(malformedSentinel);
    }
  });

  it("logs fixed metadata only and excludes request, Cookie and Set-Cookie sentinels", async () => {
    const { createClaimLossProxy } = await loadProxy();
    const directory = temporaryDirectory();
    const stateFile = join(directory, "state.json");
    const logs: unknown[] = [];
    const bodySentinel = "CLAIM-BODY-SECRET-SENTINEL";
    const cookieSentinel = "COOKIE-SECRET-SENTINEL";
    const setCookieSentinel = "SET-COOKIE-SECRET-SENTINEL";
    const upstream = createServer((incoming, response) => {
      incoming.resume();
      incoming.once("end", () => {
        response.writeHead(204, [
          "set-cookie", `entry=${setCookieSentinel}; HttpOnly`,
          "x-end-to-end", "ordinary"
        ]);
        response.end();
      });
    });
    const upstreamPort = await listen(upstream);
    const proxy = createClaimLossProxy({
      upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
      stateFile,
      log(record: unknown) {
        logs.push(record);
      }
    });
    const proxyPort = await listen(proxy);

    await expect(request(proxyPort, {
      method: "POST",
      path: "/api/v1/web-entry/pairing/claim",
      headers: {
        cookie: `family_ai_entry=${cookieSentinel}`,
        "content-length": String(Buffer.byteLength(bodySentinel))
      }
    }, bodySentinel)).rejects.toBeTruthy();
    await waitFor(() => stateName(stateFile) === "consumed", "LOG_PROBE_CONSUMED");

    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain(bodySentinel);
    expect(serialized).not.toContain(cookieSentinel);
    expect(serialized).not.toContain(setCookieSentinel);
    expect(logs.length).toBeGreaterThan(0);
    for (const record of logs as Array<Record<string, unknown>>) {
      expect(Object.keys(record).sort()).toEqual(["event", "requestId", "timestamp"]);
      expect(record).not.toHaveProperty("url");
      expect(record).not.toHaveProperty("headers");
      expect(record).not.toHaveProperty("body");
    }
  });

  it("parses every Connection token, preserves duplicate Set-Cookie, and blocks absolute-form targets", async () => {
    const { createClaimLossProxy } = await loadProxy();
    const directory = temporaryDirectory();
    const stateFile = join(directory, "state.json");
    let upstreamCalls = 0;
    let seenHeaders: Record<string, string | string[] | undefined> = {};
    const upstream = createServer((incoming, response) => {
      upstreamCalls += 1;
      seenHeaders = incoming.headers;
      response.writeHead(208, "Header Probe", [
        "Connection", "x-response-one, keep-alive",
        "Connection", "x-response-two",
        "X-Response-One", "remove-one",
        "X-Response-Two", "remove-two",
        "Keep-Alive", "timeout=91",
        "Proxy-Authenticate", "Basic response-hop-sentinel",
        "X-End-To-End", "kept",
        "Set-Cookie", "entry=one; HttpOnly",
        "Set-Cookie", "device=two; HttpOnly"
      ]);
      response.end("ok");
    });
    const upstreamPort = await listen(upstream);
    const proxy = createClaimLossProxy({
      upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
      stateFile,
      log() {}
    });
    const proxyPort = await listen(proxy);
    const headers = [
      "Host", "preview.invalid",
      "Origin", "http://preview.invalid",
      "Connection", "x-request-one, keep-alive",
      "Connection", "x-request-two",
      "X-Request-One", "remove-one",
      "X-Request-Two", "remove-two",
      "Keep-Alive", "timeout=92",
      "Proxy-Authorization", "Basic request-hop-sentinel",
      "X-End-To-End", "kept"
    ];

    const response = await rawRequest(proxyPort, "/headers", headers);
    expect(response).toMatchObject({ status: 208, statusMessage: "Header Probe", body: "ok" });
    expect(seenHeaders.host).toBe("preview.invalid");
    expect(seenHeaders.origin).toBe("http://preview.invalid");
    expect(seenHeaders["x-end-to-end"]).toBe("kept");
    expect(seenHeaders["x-request-one"]).toBeUndefined();
    expect(seenHeaders["x-request-two"]).toBeUndefined();
    expect(seenHeaders["proxy-authorization"]).toBeUndefined();
    expect(seenHeaders["keep-alive"]).not.toBe("timeout=92");
    expect(response.headers["x-response-one"]).toBeUndefined();
    expect(response.headers["x-response-two"]).toBeUndefined();
    expect(response.headers["proxy-authenticate"]).toBeUndefined();
    expect(response.headers["keep-alive"]).not.toBe("timeout=91");
    expect(response.headers["x-end-to-end"]).toBe("kept");
    expect(response.headers["set-cookie"]).toEqual([
      "entry=one; HttpOnly",
      "device=two; HttpOnly"
    ]);

    await expect(rawRequest(
      proxyPort,
      `http://127.0.0.1:${upstreamPort}/must-not-forward`,
      ["Host", "preview.invalid"]
    )).rejects.toBeTruthy();
    expect(upstreamCalls).toBe(1);
  });
});
