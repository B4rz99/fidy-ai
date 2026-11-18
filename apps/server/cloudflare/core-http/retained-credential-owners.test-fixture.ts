import { Clock, Effect, Option } from "effect";
import type { CatalogOperation } from "../../src/shell/canonical-catalog/contract";
import { handlePATRequest, patRoute, resolveCanonicalPATCredential } from "../tokens/operations";
import { logoutWebSession } from "../web-session/operations";
import {
  canonicalAdmissionUnavailable,
  noAuthority,
  protectCanonicalRequest,
  protectCanonicalSource,
} from "../canonical-admission/operations";
import { canonicalOperation } from "../routing/operations";
import { browserCanonicalResponse, executeCanonicalWork } from "./internal/http";
import type { CoreHttpEnvironment } from "./contract";

const patWork = Effect.fn(function* (
  request: Request,
  environment: CoreHttpEnvironment,
  operation: CatalogOperation
) {
  const db = environment.DB,
    current = yield* Clock.currentTimeMillis;
  const subject = yield* resolveCanonicalPATCredential({ request, db, operation });
  if (subject === "unauthenticated") {
    const refusal = yield* protectCanonicalSource({ db, request, current });
    return Option.getOrElse(refusal, noAuthority);
  }
  if (subject === "user_action_required") {
    return Response.json(
      {
        error: {
          code: "user_action_required",
          message: "Return to Fidy to review your withdrawn Consent.",
        },
        next: [],
      },
      { status: 403 }
    );
  }
  return yield* protectCanonicalRequest({
    db,
    request,
    operation,
    current,
    caller: { _tag: "PAT", value: subject },
    work: executeCanonicalWork({
      request,
      environment,
      operation,
      subject,
      completion: Option.none(),
    }),
  });
});
export const retainedWork = ({
  request,
  environment,
  path,
}: {
  request: Request;
  environment: CoreHttpEnvironment;
  path: string;
}): Option.Option<Effect.Effect<Response>> => {
  if (path === "/web/session/logout" && request.method === "POST") {
    return Option.some(
      logoutWebSession({ request, db: environment.DB }).pipe(
        Effect.orElseSucceed(canonicalAdmissionUnavailable)
      )
    );
  }
  if (patRoute(path) && !(path === "/pats" && request.method === "GET")) {
    return Option.some(
      handlePATRequest({ request, db: environment.DB }).pipe(
        Effect.orElseSucceed(canonicalAdmissionUnavailable)
      )
    );
  }
  const operation = canonicalOperation({ method: request.method, path });
  return Option.map(operation, (selected) =>
    request.headers.has("authorization")
      ? patWork(request, environment, selected).pipe(
          Effect.orElseSucceed(canonicalAdmissionUnavailable)
        )
      : browserCanonicalResponse({ request, environment, operation: selected })
  );
};
