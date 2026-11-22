import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect, Match, Option, Schema } from "effect";
import type { OAuthConfirmationAttempt } from "../../../src/shell/mcp/contract";
import { digestBytes, newId } from "../../secret-material/operations";
import type { LocalOAuthInvocation } from "../../oauth-agents/contract";
import {
  CanonicalAdmissionUnavailable,
  isCanonicalRejection,
} from "../../canonical-admission/contract";
import { OAuthNativeReview, OAuthReviewBinding } from "../contract";
import {
  acceptedNativeResponse,
  canonicalJson,
  disclosureRevision,
  maximumInputBytes,
  oauthReviewResponse,
  reviewLifetimeMilliseconds,
} from "./native-disclosure";

const isResponse = Schema.is(Schema.instanceOf(Response));

const refuse = (): Response =>
  Response.json(
    {
      error: {
        code: "user_action_required",
        message:
          "Esta operación requiere una nueva confirmación nativa del cliente OAuth autorizado.",
      },
      next: [],
    },
    { status: 403, headers: { "cache-control": "no-store" } }
  );

const captureIntent = Effect.fn(function* (
  admission: LocalOAuthInvocation["admission"],
  facts: OAuthReviewBinding
) {
  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(
    canonicalJson(admission.input)
  );

  const bytes = new TextEncoder().encode(encoded);

  if (bytes.length > maximumInputBytes) return refuse();
  const digest = yield* digestBytes(bytes);
  const binding = yield* Schema.encodeEffect(Schema.fromJsonString(OAuthReviewBinding))(facts);

  return { encoded, digest, binding };
});

const retainReview = Effect.fn(function* ({
  subject,
  admission,
  facts,
  current,
  encoded,
  digest,
  binding,
}: {
  subject: LocalOAuthInvocation["subject"];
  admission: LocalOAuthInvocation["admission"];
  facts: OAuthReviewBinding;
  current: number;
  encoded: string;
  digest: Uint8Array;
  binding: string;
}) {
  const sql = yield* SqliteClient;

  const reference = newId(),
    expires = current + reviewLifetimeMilliseconds;

  const message = `Fidy: ${facts
    .filter((fact) => fact.effect.length > 0)
    .map((fact) => fact.effect)
    .join(
      "\n"
    )}\nOperación exacta${facts.length > 1 ? " (lote completo, en este orden)" : ""}: ${admission.operation}\n${encoded}\n¿Confirmas esta acción?`;

  const review = yield* Schema.decodeEffect(OAuthNativeReview)({
    reference,
    message,
    expiresAtMilliseconds: expires,
  });

  yield* sql`DELETE FROM oauth_operation_intents WHERE expires_at_ms<=${current}`;

  const saved =
    yield* sql`INSERT INTO oauth_operation_intents(reference,user_id,connection_id,operation,input_json,input_digest,binding_json,disclosure_revision,created_at_ms,expires_at_ms)
    SELECT ${reference},${subject.userId},${subject.oauthConnectionId},${admission.operation},${encoded},${digest},${binding},${disclosureRevision},${current},${expires} WHERE (SELECT count(*) FROM oauth_operation_intents)<5 RETURNING reference`;

  return saved.length === 1 ? oauthReviewResponse(review) : refuse();
});

const decideIntent = Effect.fn(function* ({
  subject,
  admission,
  current,
  encoded,
  digest,
  binding,
  attempt,
}: {
  subject: LocalOAuthInvocation["subject"];
  admission: LocalOAuthInvocation["admission"];
  current: number;
  encoded: string;
  digest: Uint8Array;
  binding: string;
  attempt: (typeof OAuthConfirmationAttempt.members)[1]["Type"];
}) {
  const sql = yield* SqliteClient;

  if (!acceptedNativeResponse(attempt.response)) {
    yield* sql`DELETE FROM oauth_operation_intents WHERE reference=${attempt.reference} AND user_id=${subject.userId} AND connection_id=${subject.oauthConnectionId}`;

    return refuse();
  }

  const matches = sql`reference=${attempt.reference} AND user_id=${subject.userId} AND connection_id=${subject.oauthConnectionId} AND operation=${admission.operation} AND input_json=${encoded} AND input_digest=${digest} AND binding_json=${binding} AND disclosure_revision=${disclosureRevision} AND created_at_ms<=${current}`;

  const [row] =
    yield* sql`SELECT reference FROM oauth_operation_intents WHERE ${matches} AND expires_at_ms>${current}`;

  if (row === undefined) return refuse();

  return {
    paid: true,
    consume: Effect.gen(function* () {
      const removed =
        yield* sql`DELETE FROM oauth_operation_intents WHERE ${matches} AND expires_at_ms>${yield* Clock.currentTimeMillis} RETURNING reference`;

      if (removed.length !== 1) {
        return yield* new CanonicalAdmissionUnavailable({ cause: "confirmation expired" });
      }
    }),
  };
});

export const localConfirmation = Effect.fn(function* <E, R>(
  oauth: LocalOAuthInvocation,
  current: number,
  admit: Effect.Effect<Option.Option<Response>, E, R>
) {
  const { subject, admission } = oauth,
    attempt = admission.confirmation;

  const read = yield* oauth.review(current).pipe(
    Effect.catchIf(isCanonicalRejection, (rejection) =>
      Effect.logDebug({
        component: "oauth-confirmation",
        operation: "review",
        outcome: rejection.code,
      }).pipe(Effect.as(Option.none()))
    )
  );

  if (Option.isNone(read)) return refuse();

  if (read.value.length === 0) {
    return { paid: false, consume: Effect.void };
  }

  if (attempt === undefined) return refuse();
  const captured = yield* captureIntent(admission, read.value);

  if (isResponse(captured)) return captured;
  const { encoded, digest, binding } = captured;

  return yield* Match.valueTags(attempt, {
    Review: () =>
      Effect.gen(function* () {
        const refused = yield* admit;

        if (Option.isSome(refused)) return refused.value;

        return yield* retainReview({
          subject,
          admission,
          facts: read.value,
          current,
          encoded,
          digest,
          binding,
        });
      }),
    Decision: (decision) =>
      decideIntent({ subject, admission, current, encoded, digest, binding, attempt: decision }),
  });
});
