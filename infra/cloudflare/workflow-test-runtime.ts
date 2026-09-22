// Cloudflare supplies this constructor; tests replace only its runtime environment and Step.
/** Test-only constructor seam for invoking a Workflow with a deterministic Step substitute. */
export class WorkflowEntrypoint<Environment, _Parameters> {
  readonly env: Environment;
  constructor(_context: unknown, env: Environment) {
    this.env = env;
  }
}
