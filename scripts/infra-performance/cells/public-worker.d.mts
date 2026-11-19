import type { IngressEnvironment } from "./contracts.d.mts";
declare const ingress: { fetch(request: Request, env: IngressEnvironment): Promise<Response> };
export default ingress;
