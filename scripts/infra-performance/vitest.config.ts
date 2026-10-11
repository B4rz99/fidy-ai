import { mergeConfig } from "vitest/config";
import cloudflare from "../../apps/server/cloudflare/vitest.config";

export default mergeConfig(cloudflare, {
  test: {
    setupFiles: [new URL("./canonical-request-observer.test-fixture.ts", import.meta.url).pathname],
    fileParallelism: false,
    maxWorkers: 1,
  },
});
