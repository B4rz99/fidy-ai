// Playwright's published export resolves to index.mjs, which oxlint misreads as extensionless.
// Dynamic import keeps that export without weakening the repository's lint rules.
export const playwright = await import("@playwright/test");
