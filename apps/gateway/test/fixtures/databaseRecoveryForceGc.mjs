import { existsSync } from "node:fs";
import { setImmediate } from "node:timers/promises";

if (typeof globalThis.gc !== "function") throw new Error("EXPOSE_GC_REQUIRED");

process.on("message", async (message) => {
  if (message !== "force-gc") return;
  for (let index = 0; index < 8; index += 1) {
    globalThis.gc();
    await setImmediate();
  }
  process.send({
    type: "after-gc",
    wal: existsSync(`${process.argv[2]}-wal`),
    shm: existsSync(`${process.argv[2]}-shm`)
  });
});
