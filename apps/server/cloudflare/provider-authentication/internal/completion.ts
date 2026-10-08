import { type Cause, Clock, Effect, Option, Schema } from "effect";
import { ProviderBrowserProof } from "../../../src/shell/provider-authentication/contract";
import { UserId } from "../../../src/core/identity/contract";
import { DisclosureSnapshot } from "../../../src/core/consent/contract";
import { boundedJsonBody } from "../../http/operations";
import {
  prepareProvedBrowserPairingApproval,
  provePendingBrowserPairing,
} from "../../browser-login/operations";
import { webSignupDisclosure } from "../../../src/shell/consent/operations";
import type { ProviderCompletionRequest } from "../contract";
import { providerBodyPolicy, providerJson } from "./start";

const invalidStatus = 400;
const Attempt = Schema.Struct({
  id: Schema.String,
  issuer: Schema.String,
  subject: Schema.String,
  contact_email: Schema.NullOr(Schema.String),
  intent: Schema.Literals(["signup", "login"]),
  disclosure_json: Schema.NullOr(Schema.String),
  consent_at_ms: Schema.NullOr(Schema.Int),
});
const Credential = Schema.Struct({ user_id: UserId });
type CompletionContext = Readonly<{
  input: ProviderCompletionRequest;
  proof: typeof ProviderBrowserProof.Type;
  attempt: typeof Attempt.Type;
  current: number;
}>;
const commit =
  (context: CompletionContext) =>
  ({
    userId,
    statements,
    created,
  }: Readonly<{
    userId: UserId;
    statements: ReadonlyArray<D1PreparedStatement>;
    created: boolean;
  }>): Promise<void> => {
    const subject = { sql: "SELECT ? AS userId", params: [userId] };
    return context.input.db
      .batch([
        ...statements,
        prepareProvedBrowserPairingApproval({
          db: context.input.db,
          pairingId: context.proof.pairingId,
          subject,
          current: context.current,
        }),
        context.input.db
          .prepare(
            "INSERT INTO completed_provider_authentications(attempt_id,user_id,completed_at_ms,created_user) VALUES(?,?,?,?)"
          )
          .bind(context.attempt.id, userId, context.current, created ? 1 : 0),
      ])
      .then(() => undefined);
  };
const completeSignup = (
  context: CompletionContext
): Effect.Effect<Response, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const { attempt, current } = context;
    if (
      attempt.intent !== "signup" ||
      attempt.disclosure_json === null ||
      attempt.consent_at_ms === null
    ) {
      return providerJson({ body: { status: "invalid" }, status: invalidStatus });
    }
    const disclosure = yield* Schema.decodeEffect(Schema.fromJsonString(DisclosureSnapshot))(
      attempt.disclosure_json
    );
    if (disclosure.revision !== webSignupDisclosure().revision) {
      return providerJson({ body: { status: "invalid" }, status: invalidStatus });
    }
    return yield* Effect.tryPromise(() =>
      context.input.complete({
        attemptId: attempt.id,
        disclosure,
        acceptedAtMs: attempt.consent_at_ms ?? current,
        verifiedAtMs: current,
        commit: ({ userId, statements }) =>
          commit(context)({
            userId,
            created: true,
            statements: [
              ...statements,
              context.input.db
                .prepare(
                  "INSERT INTO provider_credentials(issuer,subject,user_id,contact_email,established_at_ms) VALUES(?,?,?,?,?)"
                )
                .bind(attempt.issuer, attempt.subject, userId, attempt.contact_email, current),
            ],
          }),
      })
    );
  });
export const completeProvider = (input: ProviderCompletionRequest): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const proof = yield* boundedJsonBody({
        request: input.request,
        policy: providerBodyPolicy,
        schema: ProviderBrowserProof,
      });
      if (Option.isNone(proof)) {
        return providerJson({ body: { status: "invalid" }, status: invalidStatus });
      }
      const pending = yield* provePendingBrowserPairing({ db: input.db, ...proof.value });
      if (Option.isNone(pending)) {
        return providerJson({ body: { status: "invalid" }, status: invalidStatus });
      }
      const current = yield* Clock.currentTimeMillis;
      const row = yield* Effect.tryPromise(() =>
        input.db
          .prepare(
            `SELECT id,issuer,subject,contact_email,intent,disclosure_json,consent_at_ms FROM provider_authentication_attempts WHERE pairing_id=? AND state='verified' AND expires_at_ms>?`
          )
          .bind(proof.value.pairingId, current)
          .first()
      );
      const attempt = yield* Schema.decodeUnknownEffect(Attempt)(row);
      const rawCredential = yield* Effect.tryPromise(() =>
        input.db
          .prepare("SELECT user_id FROM provider_credentials WHERE issuer=? AND subject=?")
          .bind(attempt.issuer, attempt.subject)
          .first()
      );
      const commitAttempt = commit({ input, proof: proof.value, attempt, current });
      if (rawCredential !== null) {
        const credential = yield* Schema.decodeUnknownEffect(Credential)(rawCredential);
        yield* Effect.tryPromise(() =>
          commitAttempt({ userId: credential.user_id, statements: [], created: false })
        );
        return providerJson({ body: { status: "approved" } });
      }
      return yield* completeSignup({ input, proof: proof.value, attempt, current });
    }).pipe(
      Effect.orElseSucceed(() =>
        providerJson({ body: { status: "invalid" }, status: invalidStatus })
      )
    )
  );
