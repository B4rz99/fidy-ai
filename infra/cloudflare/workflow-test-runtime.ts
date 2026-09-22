// Cloudflare supplies this constructor; tests invoke the versioned Activity driver directly.
/** Test-only placeholder for the native Workflow entrypoint import. */
export class WorkflowEntrypoint<Environment, _Parameters> {
  readonly env: Environment;
  constructor(_context: unknown, env: Environment) {
    this.env = env;
  }
}
