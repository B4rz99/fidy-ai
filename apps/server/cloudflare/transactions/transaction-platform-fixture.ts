// Used only by the platform integration test: the real Durable Object class is bundled for workerd.
export { UserTransactionCoordinator } from "./runtime";

export default {
  fetch: (): Response => new Response("not_found", { status: 404 }),
};
