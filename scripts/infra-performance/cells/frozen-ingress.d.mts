import type { IngressEnvironment } from "./contracts.d.mts";
export declare const ingress: {
  fetch(request: Request, env: IngressEnvironment): Promise<Response>;
};
