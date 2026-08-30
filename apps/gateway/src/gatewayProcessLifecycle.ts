import type { FastifyInstance } from "fastify";

export interface GatewayProcessLock {
  close(): void;
}

export function createGatewayProcessLifecycle(input: {
  app: FastifyInstance;
  lock: GatewayProcessLock;
}): { close(): Promise<void> } {
  let closePromise: Promise<void> | undefined;
  return {
    close: () => {
      closePromise ??= (async () => {
        await input.app.close();
        input.lock.close();
      })();
      return closePromise;
    }
  };
}
