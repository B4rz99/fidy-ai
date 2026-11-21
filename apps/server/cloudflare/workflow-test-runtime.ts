export const env = {};

export class WorkflowEntrypoint<Environment, _Parameters> {
  readonly env: Environment;
  constructor(_context: unknown, env: Environment) {
    this.env = env;
  }
}

export class WorkerEntrypoint<Environment> {
  readonly env: Environment;
  constructor(_context: unknown, environment: Environment) {
    this.env = environment;
  }
  fetch(_request: Request): Promise<Response> {
    return Promise.resolve(new Response(null, { status: 404 }));
  }
}

export class DurableObject<Environment> {
  protected readonly ctx: DurableObjectState;
  protected readonly env: Environment;
  constructor(state: DurableObjectState, environment: Environment) {
    this.ctx = state;
    this.env = environment;
  }
}
