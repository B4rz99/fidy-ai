export class WorkflowEntrypoint<Environment, _Parameters> {
  readonly env: Environment;
  constructor(_context: unknown, env: Environment) {
    this.env = env;
  }
}

/** Native Worker entrypoint construction for import-only test composition. */
export class WorkerEntrypoint<Environment> {
  readonly env: Environment;
  constructor(_context: unknown, environment: Environment) {
    this.env = environment;
  }
  fetch(_request: Request): Promise<Response> {
    return Promise.resolve(new Response(null, { status: 404 }));
  }
}
