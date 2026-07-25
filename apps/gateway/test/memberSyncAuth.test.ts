import { describe, expect, it, vi } from "vitest";
import { GatewayError } from "../member-public/api.js";
import { createMemoryCache } from "../member-public/cache.js";
import { createStore } from "../member-public/store.js";
import { createSyncController } from "../member-public/sync.js";

describe("Member Web sync authentication recovery", () => {
  it("reports an expired Entry Session to the Entry lifecycle before retrying", async () => {
    const error = new GatewayError({
      status: 401,
      code: "ENTRY_SESSION_EXPIRED",
      category: "permission",
      message: "入口会话已经过期。",
      retryable: false
    });
    const onError = vi.fn();
    const controller = createSyncController({
      api: {
        getSyncEvents: vi.fn(async () => { throw error; }),
        ackSyncEvent: vi.fn()
      },
      cache: createMemoryCache(),
      store: createStore({
        activeThreadRef: null,
        sync: {
          status: "idle",
          localAppliedSequence: 0,
          acknowledgedSequence: 0,
          latestSequence: 0,
          error: null
        }
      }),
      applyEvent: vi.fn(),
      onError,
      EventSourceClass: class {},
      BroadcastChannelClass: undefined,
      setTimeoutFn: () => 0,
      clearTimeoutFn: () => undefined
    });

    await expect(controller.catchUp()).rejects.toBe(error);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(error);
  });
});
