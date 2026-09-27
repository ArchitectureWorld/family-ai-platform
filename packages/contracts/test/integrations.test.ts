import { describe, expect, it } from "vitest";
import {
  assetRefSchema,
  createExecutionLinkRequestSchema,
  executionLinkSchema,
  familyWorkToCanvasSchema,
  resourceRefSchema
} from "../src/integrations.js";

const resource = (
  system: "family-ai" | "super-canvas" | "me-system",
  kind: string,
  id: string
) => ({
  schemaVersion: "resource-ref/1.0" as const,
  system,
  kind,
  id,
  uri: `ai://${system}/${kind}/${id}`
});

describe("ecosystem integration contracts", () => {
  it("requires deterministic ResourceRef URIs", () => {
    expect(resourceRefSchema.parse(resource("family-ai", "work", "work:one"))).toEqual(
      resource("family-ai", "work", "work:one")
    );
    expect(() => resourceRefSchema.parse({
      ...resource("family-ai", "work", "work:one"),
      uri: "ai://family-ai/work/work:forged"
    })).toThrow();
  });

  it("forbids local paths in AssetRef", () => {
    const asset = {
      schemaVersion: "asset-ref/1.0",
      asset: resource("family-ai", "attachment", "attachment:one"),
      fileName: "one.pdf",
      mediaType: "application/pdf",
      sizeBytes: 1024,
      sha256: "a".repeat(64),
      sensitivity: "project-private",
      retrievalMode: "capability"
    };
    expect(assetRefSchema.parse(asset)).toEqual(asset);
    expect(() => assetRefSchema.parse({ ...asset, localPath: "/mnt/one.pdf" })).toThrow();
  });

  it("validates the thin Family Work to Canvas package", () => {
    const payload = {
      schemaVersion: "family-work-to-canvas/1.1",
      agentRef: "agent:hermes-zzh",
      sourceWork: resource("family-ai", "work", "work:one"),
      title: "照明工作",
      goal: "完成照明方案",
      summary: "当前已确认范围。",
      messageRefs: [resource("family-ai", "message", "message:one")],
      assets: [],
      sourceSequence: 42,
      idempotencyKey: "work:one:canvas:42"
    };
    expect(familyWorkToCanvasSchema.parse(payload)).toEqual(payload);
    expect(() => familyWorkToCanvasSchema.parse({
      ...payload,
      messages: [{ content: "full history must not cross" }]
    })).toThrow();
    expect(() => familyWorkToCanvasSchema.parse({
      ...payload,
      agentRef: "agent:other"
    })).not.toThrow();
    const { agentRef: _agentRef, ...withoutAgent } = payload;
    expect(() => familyWorkToCanvasSchema.parse(withoutAgent)).toThrow();
  });

  it("separates the browser command from server-owned Work fields", () => {
    const command = {
      protocolVersion: 1,
      idempotencyKey: "work:one:canvas:42",
      messageRefs: ["message:one"],
      attachmentRefs: ["attachment:one"]
    };
    expect(createExecutionLinkRequestSchema.parse(command)).toEqual(command);
    expect(() => createExecutionLinkRequestSchema.parse({
      ...command,
      accountId: "forged"
    })).toThrow();
  });

  it("validates the stored external link summary without Canvas data copies", () => {
    const link = {
      linkRef: "execution-link:one",
      workConversationRef: "work:one",
      externalResource: resource("super-canvas", "workflow", "workflow:one"),
      rootSession: resource("super-canvas", "session", "session:one"),
      status: "active",
      deepLink: "http://127.0.0.1:3000/session-alpha/session:one",
      sourceSequence: 42,
      createdByPersonRef: "person:master",
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
      revokedAt: null
    };
    expect(executionLinkSchema.parse(link)).toEqual(link);
    expect(() => executionLinkSchema.parse({ ...link, messages: [] })).toThrow();
  });
});
