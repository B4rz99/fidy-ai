// Broad D1/DO integration interface: bundle the published coordinator for isolated workerd tests.
export { UserTransactionCoordinator } from "./transactions/runtime";

export default {
  fetch: (): Response => new Response("not_found", { status: 404 }),
};
