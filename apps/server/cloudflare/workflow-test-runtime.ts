export class WorkflowEntrypoint<Environment, _Parameters> {
  readonly env: Environment;
  constructor(_context: unknown, env: Environment) {
    this.env = env;
  }
}
