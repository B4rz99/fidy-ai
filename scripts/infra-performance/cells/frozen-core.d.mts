import type { CoreEnvironment } from "./contracts.d.mts";
export declare const core: {
  fetch(request: Request, env: CoreEnvironment, execution: unknown): Promise<Response>;
};
export class UserTransactionCoordinator {
  constructor(state: unknown, env: CoreEnvironment);
  fetch(request: Request): Promise<Response>;
}
