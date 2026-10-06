import { Array as Arr, type Cause, Clock, Effect, Option, Predicate, Schema } from "effect";
import { digestBytes, newId } from "../secret-material/operations";
import { liveOAuthCommitAuthority } from "../../src/shell/oauth-agents/operations";
import type { OAuthCaller } from "../../src/shell/oauth-agents/contract";
import {
  type OAuthConfirmationWork,
  type OAuthMutationReview,
  OAuthNativeReview,
  OAuthReviewBinding,
} from "./contract";
import type { OwnedStatement } from "../../src/shell/owner-write/contract";

/** Compose an owner's exact observed revision predicate into the protected unit. The owner must
 * provide the same facts in its effect/revision disclosure; values remain bound SQL parameters.
 */
export const oauthMutationReview = (
  input: Readonly<{
    db: D1Database;
    effect: string;
    revision: string;
    guard: OwnedStatement;
  }>
): OAuthMutationReview => ({
  effect: input.effect,
  revision: input.revision,
  guards: [
    input.db
      .prepare(`INSERT INTO oauth_confirmation_guard(singleton, accepted)
    SELECT 1, CASE WHEN EXISTS (${input.guard.sql}) THEN 1 ELSE 0 END
    ON CONFLICT(singleton) DO UPDATE SET accepted = excluded.accepted`)
      .bind(...input.guard.params),
  ],
});

const disclosureRevision = "oauth-native-988-v1";
const lifetimeMilliseconds = 300000;
const maximumInputBytes = 16384;
const AcceptedResponse = Schema.Struct({
  action: Schema.Literal("accept"),
  content: Schema.Struct({ confirm: Schema.Literal(true) }),
});
const databaseCurrent =
  "(CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER))";
const canonicalJson = (value: Schema.Json): Schema.Json => {
  if (
    Predicate.isNull(value) ||
    Predicate.isString(value) ||
    Predicate.isNumber(value) ||
    Predicate.isBoolean(value)
  ) {
    return value;
  }
  if (Arr.isArray<Schema.JsonArray | Schema.JsonObject>(value)) {
    return value.map(canonicalJson);
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalJson(value[key] ?? null)])
  );
};
type ConfirmationPreparation =
  | Readonly<{ _tag: "Review"; review: OAuthNativeReview }>
  | Readonly<{ _tag: "Refused" }>
  | Readonly<{ _tag: "Prepared"; statements: ReadonlyArray<D1PreparedStatement> }>;
type ConfirmationInput = Readonly<{
  db: D1Database;
  subject: OAuthCaller;
  work: OAuthConfirmationWork;
  binding: OAuthReviewBinding;
}>;
type IntentWork = Readonly<{
  input: ConfirmationInput;
  current: number;
  encoded: string;
  binding: string;
  digest: Uint8Array;
  authority: ReturnType<typeof liveOAuthCommitAuthority>;
}>;
type NativeDecision = Extract<OAuthConfirmationWork["attempt"], { _tag: "Decision" }>;

const discardIntent = (
  work: IntentWork,
  reference: string
): Effect.Effect<ConfirmationPreparation, Cause.UnknownError> =>
  Effect.tryPromise(() =>
    work.input.db
      .prepare(
        "DELETE FROM oauth_operation_intents WHERE reference = ? AND user_id = ? AND connection_id = ?"
      )
      .bind(reference, work.input.subject.userId, work.input.subject.oauthConnectionId)
      .run()
  ).pipe(Effect.as({ _tag: "Refused" } as const));

/** Only the canonical protected unit executes these statements, together with owner writes/Audit. */
const consumeIntent = (
  work: IntentWork,
  attempt: NativeDecision
): Effect.Effect<ConfirmationPreparation, Cause.UnknownError> => {
  if (
    Option.isNone(
      Schema.decodeUnknownOption(AcceptedResponse, { onExcessProperty: "error" })(attempt.response)
    )
  ) {
    return discardIntent(work, attempt.reference);
  }
  const { db, subject } = work.input;
  const live = `EXISTS (SELECT 1 FROM ${work.authority.table} WHERE ${work.authority.predicate})`;
  const consumed = db
    .prepare(`DELETE FROM oauth_operation_intents WHERE reference = ? AND user_id = ? AND connection_id = ?
        AND operation = ? AND input_json = ? AND input_digest = ? AND binding_json = ? AND disclosure_revision = ?
        AND expires_at_ms > ? AND expires_at_ms > ${databaseCurrent} AND ${live}`)
    .bind(
      attempt.reference,
      subject.userId,
      subject.oauthConnectionId,
      work.input.work.operation,
      work.encoded,
      work.digest,
      work.binding,
      disclosureRevision,
      work.current,
      ...work.authority.bindings
    );
  return Effect.succeed({
    _tag: "Prepared",
    statements: [
      consumed,
      db.prepare(`INSERT INTO oauth_confirmation_guard(singleton, accepted) VALUES (1, CASE WHEN changes() = 1 THEN 1 ELSE 0 END)
          ON CONFLICT(singleton) DO UPDATE SET accepted = excluded.accepted`),
    ],
  });
};

const issueStatements = (
  work: IntentWork,
  review: OAuthNativeReview
): ReadonlyArray<D1PreparedStatement> => {
  const { db, subject } = work.input;
  const live = `EXISTS (SELECT 1 FROM ${work.authority.table} WHERE ${work.authority.predicate})`;
  return [
    db
      .prepare("DELETE FROM oauth_operation_intents WHERE user_id = ? AND expires_at_ms <= ?")
      .bind(subject.userId, work.current),
    db
      .prepare(`INSERT INTO oauth_operation_intents(reference,user_id,connection_id,operation,input_json,input_digest,binding_json,disclosure_revision,created_at_ms,expires_at_ms)
        SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${live}`)
      .bind(
        review.reference,
        subject.userId,
        subject.oauthConnectionId,
        work.input.work.operation,
        work.encoded,
        work.digest,
        work.binding,
        disclosureRevision,
        work.current,
        review.expiresAtMilliseconds,
        ...work.authority.bindings
      ),
  ];
};
const issueIntent = (
  work: IntentWork
): Effect.Effect<ConfirmationPreparation, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const message =
      `Fidy: ${work.input.binding
        .filter(({ effect }) => effect.length > 0)
        .map(({ effect }) => effect)
        .join("\n")}\n` +
      `Operación exacta${work.input.binding.length > 1 ? " (lote completo, en este orden)" : ""}: ${work.input.work.operation}\n${work.encoded}\n¿Confirmas esta acción?`;
    const review = yield* Schema.decodeEffect(OAuthNativeReview)({
      reference: newId(),
      message,
      expiresAtMilliseconds: work.current + lifetimeMilliseconds,
    });
    const issued = yield* Effect.tryPromise(() =>
      work.input.db.batch([...issueStatements(work, review)])
    );
    return issued[1]?.meta.changes === 1
      ? ({ _tag: "Review", review } as const)
      : ({ _tag: "Refused" } as const);
  });

/** Issue immutable bounded review or lend single-use consumption to the caller's protected atomic unit.
 * A valid native response is an authorized-client assertion, not independent human attestation.
 * The caller must supply owner-observed bindings and compose their revision guards with all writes and Audit.
 */
export const prepareOAuthConfirmation = (
  input: ConfirmationInput
): Effect.Effect<ConfirmationPreparation> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(
      canonicalJson(input.work.input)
    );
    if (new TextEncoder().encode(encoded).length > maximumInputBytes) {
      return { _tag: "Refused" } as const;
    }
    const binding = yield* Schema.encodeEffect(Schema.fromJsonString(OAuthReviewBinding))(
      input.binding
    );
    const digest = yield* digestBytes(new TextEncoder().encode(encoded));
    const authority = liveOAuthCommitAuthority({ subject: input.subject, current });
    const intent = { input, current, encoded, binding, digest, authority };
    const attempt = input.work.attempt;
    return yield* attempt._tag === "Decision"
      ? consumeIntent(intent, attempt)
      : issueIntent(intent);
  }).pipe(Effect.catchCause(() => Effect.succeed({ _tag: "Refused" } as const)));

/** Private protocol handoff, never a canonical success or a model-callable approval tool. */
export const oauthReviewResponse = (review: OAuthNativeReview): Response =>
  Response.json(Schema.encodeSync(OAuthNativeReview)(review), {
    status: 409,
    headers: { "cache-control": "no-store", "fidy-oauth-review": "1" },
  });
