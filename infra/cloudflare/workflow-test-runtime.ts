// Vitest never invokes the native Workflow entrypoint: Cloudflare supplies this class at runtime.
/** Test-only placeholder for the Cloudflare runtime class in focused D1 and Queue tests. */
export class WorkflowEntrypoint<Environment, _Parameters> {
  readonly env: Environment;
  constructor(env: Environment) {
    this.env = env;
  }
}
