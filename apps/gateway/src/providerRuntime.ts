import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  FakeProviderAdapter,
  HermesProviderAdapter,
  ProviderAdapterRouter,
  type ProviderAdapter
} from "@family-ai/provider-adapter-sdk";
import type { GatewayMode } from "./app.js";

const providerProfileRefSchema = z
  .string()
  .regex(/^provider-profile:[a-z0-9][a-z0-9._:-]{1,126}$/);

const safeRuntimeTextSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/[\r\n\0]/.test(value), "control characters are not allowed");

const apiKeySchema = z
  .string()
  .min(16)
  .max(4096)
  .refine((value) => !/[\r\n\0]/.test(value), "control characters are not allowed");

const baseUrlSchema = z.string().superRefine((value, context) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    context.addIssue({ code: "custom", message: "baseUrl must be an absolute URL" });
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    context.addIssue({ code: "custom", message: "baseUrl must use HTTP or HTTPS" });
  }
  if (url.username || url.password || url.search || url.hash) {
    context.addIssue({
      code: "custom",
      message: "baseUrl must not contain credentials, query or fragment"
    });
  }
});

const hermesProfileSchema = z
  .object({
    kind: z.literal("hermes"),
    providerProfileRef: providerProfileRefSchema,
    baseUrl: baseUrlSchema,
    apiKey: apiKeySchema,
    model: safeRuntimeTextSchema,
    sessionKey: safeRuntimeTextSchema
  })
  .strict();

const providerRuntimeConfigSchema = z
  .object({
    version: z.literal(1),
    profiles: z.array(hermesProfileSchema).min(1).max(100)
  })
  .strict()
  .superRefine((value, context) => {
    const refs = value.profiles.map((profile) => profile.providerProfileRef);
    if (new Set(refs).size !== refs.length) {
      context.addIssue({
        code: "custom",
        path: ["profiles"],
        message: "providerProfileRef values must be unique"
      });
    }
  });

export interface RuntimeProviderOptions {
  mode: GatewayMode;
  providerConfigPath: string | null;
  readFile?: (path: string) => string;
  fetchImpl?: typeof fetch;
  clock?: () => Date;
}

function readRuntimeConfig(
  path: string,
  readFile: (path: string) => string
): z.infer<typeof providerRuntimeConfigSchema> {
  let source: string;
  try {
    source = readFile(path);
  } catch {
    throw new Error("Unable to read GATEWAY_PROVIDER_CONFIG_PATH");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    throw new Error("Provider runtime config must contain valid JSON");
  }
  const parsed = providerRuntimeConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("Provider runtime config is invalid");
  }
  return parsed.data;
}

export function loadRuntimeProviderAdapter(options: RuntimeProviderOptions): ProviderAdapter {
  if (!options.providerConfigPath) {
    if (options.mode === "production") {
      throw new Error("production requires GATEWAY_PROVIDER_CONFIG_PATH");
    }
    return new FakeProviderAdapter({ clock: options.clock });
  }

  const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const config = readRuntimeConfig(options.providerConfigPath, readFile);
  const hermes = new HermesProviderAdapter({
    profiles: config.profiles.map(({ kind: _kind, ...profile }) => profile),
    fetchImpl: options.fetchImpl,
    clock: options.clock
  });
  const hermesRefs = config.profiles.map((profile) => profile.providerProfileRef);

  if (options.mode === "production") {
    return new ProviderAdapterRouter([
      { providerProfileRefs: hermesRefs, adapter: hermes }
    ], options.clock);
  }

  const fake = new FakeProviderAdapter({ clock: options.clock });
  return new ProviderAdapterRouter([
    { providerProfileRefs: ["provider-profile:fake-local"], adapter: fake },
    { providerProfileRefs: hermesRefs, adapter: hermes }
  ], options.clock);
}
