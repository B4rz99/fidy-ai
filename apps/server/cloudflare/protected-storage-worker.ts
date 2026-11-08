import { receiveProtectedUnit } from "./protected-storage/runtime";

export default {
  fetch: (
    request: Request,
    environment: Parameters<typeof receiveProtectedUnit>[0]["environment"]
  ): Promise<Response> => receiveProtectedUnit({ request, environment }),
};
