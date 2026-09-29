export type WorkerResources = Readonly<{
  migrationTag: string;
  bindings: Readonly<Record<string, unknown>>;
  exports: Readonly<Record<string, unknown>>;
}>;

/** Conservative eligibility: only code changed, with unchanged versioned binding and DO configuration. */
export const rollbackCompatible = (
  input: Readonly<{
    stable: WorkerResources;
    candidate: WorkerResources;
    changedPaths: ReadonlyArray<string>;
    workflowPaths: ReadonlyArray<string>;
  }>
): boolean =>
  input.stable.migrationTag === input.candidate.migrationTag &&
  JSON.stringify(input.stable.bindings) === JSON.stringify(input.candidate.bindings) &&
  JSON.stringify(input.stable.exports) === JSON.stringify(input.candidate.exports) &&
  !input.changedPaths.some(
    (path) =>
      input.workflowPaths.includes(path) ||
      path === "infra/cloudflare/alchemy.run.ts" ||
      path.startsWith("apps/server/cloudflare/migrations/") ||
      (path.startsWith("apps/server/cloudflare/") && /workflow|queue/i.test(path))
  );
