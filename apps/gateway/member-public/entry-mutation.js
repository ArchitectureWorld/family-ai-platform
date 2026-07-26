function unavailable(message) {
  const error = new Error(message);
  error.code = "ENTRY_MUTATION_LOCK_UNAVAILABLE";
  return error;
}

export function createEntryMutationLock({
  locks = globalThis.navigator?.locks
} = {}) {
  const available = typeof locks?.request === "function";
  const cookieMutationName = "family-ai-member-cookie-mutation";
  const entryMutationName = (installationId) =>
    `family-ai-member-entry-mutation:${installationId}`;
  const productFlightName = (installationId) =>
    `family-ai-member-product-flight:${installationId}`;
  const cacheOpenName = (installationId) =>
    `family-ai-member-cache-open:${installationId}`;

  return {
    available,

    async runCookieMutation(callback) {
      if (!available) {
        throw unavailable("当前浏览器不支持安全 Cookie 协调。");
      }
      return locks.request(
        cookieMutationName,
        { mode: "exclusive" },
        callback
      );
    },

    async run(installationId, callback) {
      if (!available) {
        throw unavailable("当前浏览器不支持安全恢复入口。");
      }
      return locks.request(
        entryMutationName(installationId),
        { mode: "exclusive" },
        callback
      );
    },

    async acquireProductFlight(installationId) {
      if (!available) {
        return { release: async () => {} };
      }

      let releaseHold;
      let acquiredResolve;
      let acquiredReject;
      let released = false;
      const acquired = new Promise((resolve, reject) => {
        acquiredResolve = resolve;
        acquiredReject = reject;
      });
      const hold = new Promise((resolve) => {
        releaseHold = resolve;
      });
      let done;
      try {
        done = Promise.resolve(locks.request(
          productFlightName(installationId),
          { mode: "shared" },
          async () => {
            acquiredResolve();
            await hold;
          }
        ));
      } catch (error) {
        releaseHold();
        throw error;
      }
      done.catch(acquiredReject);
      await acquired;
      return {
        async release() {
          if (!released) {
            released = true;
            releaseHold();
          }
          await done;
        }
      };
    },

    async runProductDrain(installationId, callback) {
      if (!available) {
        throw unavailable("当前浏览器不支持跨标签请求清理。");
      }
      return locks.request(
        productFlightName(installationId),
        { mode: "exclusive" },
        callback
      );
    },

    async runCacheOpen(installationId, callback) {
      if (!available) return callback();
      return locks.request(
        cacheOpenName(installationId),
        { mode: "exclusive" },
        callback
      );
    }
  };
}
