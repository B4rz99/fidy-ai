import { installedOrigins } from "../../../src/shell/browser-transport/contract";
import type { AuthenticationProvider } from "../../../src/shell/provider-authentication/contract";
import type { NativeAcceptanceSettings } from "../../release-isolation/contract";
import { Effect, Schema } from "effect";

const created = Schema.is(Schema.Struct({ status: Schema.Literal("created") }));

export const observeCanonicalSignup = Effect.fn(function* ({
  environment,
  request,
  provider,
  response,
}: {
  environment: NativeAcceptanceSettings;
  request: Request;
  provider: AuthenticationProvider;
  response: Response;
}) {
  if (
    environment.NATIVE_STORAGE_ADMISSION !== "open" ||
    environment.RECOVERY_ISOLATION !== "" ||
    new URL(request.url).origin !== installedOrigins.production.api ||
    !response.ok
  ) {
    return;
  }

  const payload = yield* Effect.tryPromise(() => response.clone().json()).pipe(
    Effect.orElseSucceed(() => undefined)
  );

  if (created(payload)) {
    yield* Effect.logInfo({
      message:
        "fidy.operational component=canonical-signup operation=" + provider + " state=created",
    });
  }
});
