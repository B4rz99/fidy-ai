// Used only by the platform integration test: the real Durable Object class is bundled for workerd.
export { UserTransactionCoordinator } from "./transaction-coordinator";

// oxlint-disable-next-line import/no-default-export -- Workerd loads this bundled fixture as a Worker module.
export default {
  fetch: (): Response => new Response("not_found", { status: 404 }),
};
