import { Effect, Schema } from "effect";
import { Headers, type HttpServerRequest } from "effect/unstable/http";
import { UserId } from "~/core/_shared/user";
import { Unauthenticated } from "./errors";

/**
 * The header the stand-in reads the caller from. Deliberately not
 * `Authorization`: nothing here verifies anything, so it must not look like it
 * does, and a client written against it fails loudly the day real bearer auth
 * (#3) lands rather than being quietly trusted.
 */
export const callerHeader = "x-fidy-caller";

const decodeUserId = Schema.decodeUnknownEffect(UserId);

const unauthenticated = () =>
  Unauthenticated.make({
    error: {
      code: "unauthenticated",
      message:
        `Every operation runs as a user and this request named none that resolves. ` +
        `Send the caller's id in the ${callerHeader} header and retry.`,
    },
    next: [],
  });

/**
 * The one place a request becomes a user. Every handler starts here and passes
 * the result down explicitly; nothing else in the shell reads the caller off
 * the wire, and no repo or core function discovers it any other way.
 *
 * This stand-in believes whatever the header says, so it belongs to development
 * only. #3 replaces the body with a token lookup; what repos and handlers
 * depend on is the returned `UserId`, and that does not change. An absent or
 * malformed credential is a 401 — never a fallback owner.
 */
export const resolveCaller = (
  request: HttpServerRequest.HttpServerRequest
): Effect.Effect<UserId, Unauthenticated> =>
  Headers.get(request.headers, callerHeader).pipe(
    Effect.fromOption(unauthenticated),
    Effect.flatMap(decodeUserId),
    Effect.mapError(unauthenticated)
  );
