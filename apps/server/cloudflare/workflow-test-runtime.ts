export class WorkflowEntrypoint<Environment, _Parameters> {
  readonly env: Environment;
  constructor(_context: unknown, env: Environment) {
    this.env = env;
  }
}

export class WorkerEntrypoint<Environment> {
  readonly env: Environment;
  readonly ctx: unknown;
  constructor(context: unknown, env: Environment) {
    this.ctx = context;
    this.env = env;
  }
}
