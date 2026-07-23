import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROTOCOL_VERSION,
  type AdapterHealth,
  type ProviderInvocationRequest,
  type ProviderInvocationResult
} from "@family-ai/contracts";
import type { ProviderAdapter } from "@family-ai/provider-adapter-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGatewayApp } from "../src/app.js";

const deviceToken = "provider-result-validation-device-token";
const bootstrapHeaders = {
  authorization: `Bearer ${deviceToken}`,
  "x-device-ref": "device:test"
};

interface EntryCredential {
  entrySessionRef: string;
  token: string;
}

function entryHeaders(entry: EntryCredential) {
  return {
    authorization: `Bearer ${entry.token}`,
    "x-entry-session-ref": entry.entrySessionRef
  };
}

abstract class ResultAdapter implements ProviderAdapter {
  async health(): Promise<AdapterHealth> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      adapterRef: "adapter:result-validation",
      status: "online",
      providerProfiles: ["provider-profile:fake-local"],
      checkedAt: "2026-07-23T18:00:00.000Z"
    };
  }

  abstract invoke(request: ProviderInvocationRequest): Promise<ProviderInvocationResult>;
}

class MismatchedResultAdapter extends ResultAdapter {
  async invoke(request: ProviderInvocationRequest): Promise<ProviderInvocationResult> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      invocationRef: "invocation:mismatched-result",
      correlationRef: request.correlationRef,
      status: "succeeded",
      completedAt: "2026-07-23T18:00:01.000Z",
      output: [{ type: "text", text: "不应写入的错误关联回复。" }],
      externalSessionRef: "external-session:mismatched-result"
    };
  }
}

class TimedOutResultAdapter extends ResultAdapter {
  async invoke(request: ProviderInvocationRequest): Promise<ProviderInvocationResult> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      invocationRef: request.invocationRef,
      correlationRef: request.correlationRef,
      status: "timed_out",
      completedAt: "2026-07-23T18:00:30.000Z",
      error: {
        code: "PROVIDER_TIMEOUT",
        category: "timeout",
        message: "个人助理响应超时。",
        retryable: true
      }
    };
  }
}

describe("Chat Work Provider result validation", () => {
  let directory = "";
  let app: Awaited<ReturnType<typeof buildGatewayApp>>;
  let personal: EntryCredential;

  async function createApp(providerAdapter: ProviderAdapter) {
    app = await buildGatewayApp({
      databasePath: join(directory, "gateway.sqlite"),
      deviceToken,
      mode: "test",
      providerAdapter,
      now: () => new Date("2026-07-23T18:00:00.000Z")
    });
    const onboarding = await app.inject({
      method: "POST",
      url: "/api/v1/onboarding/family",
      headers: bootstrapHeaders,
      payload: {
        familyName: "测试家庭",
        ownerName: "家庭创建者",
        deviceName: "测试电脑"
      }
    });
    expect(onboarding.statusCode).toBe(201);
    personal = onboarding.json().entries.personal as EntryCredential;
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "family-ai-provider-result-validation-"));
  });

  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function send() {
    const chat = await app.inject({
      method: "GET",
      url: "/api/v1/chat?timezone=UTC",
      headers: entryHeaders(personal)
    });
    const threadRef = chat.json().chat.threadRef as string;
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/threads/${encodeURIComponent(threadRef)}/messages`,
      headers: entryHeaders(personal),
      payload: {
        protocolVersion: 1,
        clientMessageId: "provider-result-validation-0001",
        occurredAt: "2026-07-23T18:00:00.000Z",
        content: { type: "text", text: "验证 Provider 结果。" }
      }
    });
    return { threadRef, response };
  }

  it("rejects a validly-shaped result belonging to another invocation", async () => {
    await createApp(new MismatchedResultAdapter());

    const { threadRef, response } = await send();
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      code: "PROVIDER_RESPONSE_INVALID",
      category: "internal",
      retryable: true
    });

    const messages = await app.inject({
      method: "GET",
      url: `/api/v1/threads/${encodeURIComponent(threadRef)}/messages`,
      headers: entryHeaders(personal)
    });
    expect(messages.json().messages).toHaveLength(1);
  });

  it("maps a correlated Provider timeout to HTTP 504", async () => {
    await createApp(new TimedOutResultAdapter());

    const { response } = await send();
    expect(response.statusCode).toBe(504);
    expect(response.json()).toMatchObject({
      code: "PROVIDER_TIMEOUT",
      category: "timeout",
      retryable: true
    });
  });
});
