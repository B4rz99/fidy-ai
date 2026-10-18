import { disposeAcceptanceClock } from "./acceptance-clock";

// Playwright's published export resolves to index.mjs, which oxlint misreads as extensionless.
// Dynamic import keeps that export without weakening the repository's lint rules.
const runtime = await import("@playwright/test");
export const playwright: typeof runtime = {
  ...runtime,
  test: runtime.test.extend<{ acceptanceClockScope: void }>({
    acceptanceClockScope: [
      ({ page }, use): Promise<void> => use().finally(() => disposeAcceptanceClock(page)),
      { auto: true },
    ],
  }),
};
