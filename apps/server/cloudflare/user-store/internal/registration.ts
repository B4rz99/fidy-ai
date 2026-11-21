import { Clock, Effect } from "effect";
import type { UserId } from "../../../src/core/identity/contract";
import {
  UserRegistrationUnavailable,
  maintenanceName,
  registerLifetimeUrl,
  registrationAcceptedStatus,
} from "../../maintenance/contract";

export const registerUserLifetime = Effect.fn(function* (
  maintenance: Pick<DurableObjectNamespace, "getByName">,
  userId: UserId
) {
  const issuedAt = yield* Clock.currentTimeMillis;

  const response = yield* Effect.tryPromise((signal) =>
    maintenance.getByName(maintenanceName).fetch(registerLifetimeUrl, {
      method: "POST",
      headers: { "fidy-user-id": userId, "fidy-registration-issued-ms": String(issuedAt) },
      signal,
    })
  );

  if (response.status !== registrationAcceptedStatus) {
    return yield* new UserRegistrationUnavailable();
  }
});
