export { UserTransactionCoordinator } from "./transactions/runtime";

export default {
  fetch: (): Response => new Response("not_found", { status: 404 }),
};
