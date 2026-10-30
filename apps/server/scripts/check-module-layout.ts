#!/usr/bin/env bun

const serverRoot = Bun.fileURLToPath(new URL("..", import.meta.url));
const sharedKernelRoot = `${serverRoot}/src/core/_shared`;
const sharedKernelFiles = new Set([
  "context.test.ts",
  "context.ts",
  "money.test.ts",
  "money.ts",
  "time.test.ts",
  "time.ts",
]);
const unexpectedSharedKernelFiles = Array.from(
  new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: sharedKernelRoot })
).filter((file) => !sharedKernelFiles.has(file));
if (unexpectedSharedKernelFiles.length > 0) {
  throw new Error(
    "The functional-core Shared Kernel contains values beyond Money, product context, and time: " +
      unexpectedSharedKernelFiles.join(", ")
  );
}

const sharedTestHarnesses = new Set(["credential-evidence-harness.ts", "crypto-harness.ts"]);
const sharedTestSupport = Array.from(
  new Bun.Glob("**/*.ts").scanSync({ cwd: `${serverRoot}/src/shell/testing` })
);
const unexpectedTestSupport = sharedTestSupport.filter((file) => !sharedTestHarnesses.has(file));
if (unexpectedTestSupport.length > 0) {
  throw new Error(
    "Shared test support is restricted to the named credential-evidence and cryptography harnesses; owner fixtures belong beside their owner (#616): " +
      unexpectedTestSupport.join(", ")
  );
}

const sourceLandmarks = Array.from(
  new Bun.Glob("*.{ts,tsx}").scanSync({ cwd: `${serverRoot}/src` })
);
const unexpectedSourceLandmarks = sourceLandmarks.filter(
  (path) =>
    !["client.ts", "browser-bootstrap.ts", "browser-transport.ts"].includes(path) &&
    !path.endsWith(".d.ts")
);
const shellLandmarks = Array.from(
  new Bun.Glob("*.{ts,tsx}").scanSync({ cwd: `${serverRoot}/src/shell` })
);
if (unexpectedSourceLandmarks.length > 0 || shellLandmarks.some((path) => path !== "api.ts")) {
  throw new Error(
    "Source landmarks are restricted to browser publication, ambient declarations, and the canonical API assembly; native HTTP composition belongs under cloudflare/core-http (#615)."
  );
}
