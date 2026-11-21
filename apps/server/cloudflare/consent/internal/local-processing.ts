import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Data, Effect, Option, Result, Schema } from "effect";
import { DisclosureSnapshot } from "../../../src/core/consent/contract";
import { UserId } from "../../../src/core/identity/contract";
import {
  ProcessingAuthorization,
  ProcessingConsentRenewal,
  ProcessingConsentRenewalReceipt,
  ProcessingConsentWithdrawal,
} from "../../../src/shell/processing-consent/contract";
import {
  decodeProcessingConsentStatusRead,
  prepareProcessingConsentStatusRead,
} from "../../../src/shell/processing-consent/operations";
import { processingConsentTransport } from "../../../src/shell/processing-consent/runtime";
import type { WebSessionSubject } from "../../../src/shell/web-session/contract";
import {
  admitLocalRequest,
  canonicalAdmissionUnavailable,
  noAuthority,
  rateLimited,
} from "../../canonical-admission/operations";
import { RequestBodyPolicy } from "../../http/contract";
import { boundedJsonBody } from "../../http/operations";
import { withStoreCapacity } from "../../runtime/sqlite/operations";
import { newId } from "../../secret-material/operations";
import { readBoundWebSessionProof } from "../../web-session/operations";
import { consentResponse } from "./browser";

const ok = (body: unknown): Response =>
  Response.json(body, { headers: { "cache-control": "no-store" } });

const bodyPolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 1024,
  deadlineMilliseconds: 2000,
});

const badInput = 400;

const forbidden = 403;

const maximumAuthorizationTextLength = 32768;

const grantRow = Schema.Struct({
  reference: Schema.String,
  acceptedAtMs: Schema.Int,
  disclosure: Schema.fromJsonString(DisclosureSnapshot),
});

const receipt = Effect.fnUntraced(function* (subject: WebSessionSubject, current: number) {
  const sql = yield* SqliteClient;
  const query = prepareProcessingConsentStatusRead({ subject, current });

  return yield* decodeProcessingConsentStatusRead(yield* sql.unsafe(query.sql, query.params));
});

const granted = Effect.fnUntraced(function* (user: string) {
  const sql = yield* SqliteClient;

  const rows = yield* sql`SELECT id AS reference,occurred_at_ms AS acceptedAtMs,
    CASE WHEN length(disclosure_json)<=${maximumAuthorizationTextLength} THEN disclosure_json END AS disclosure
    FROM consent_history WHERE user_id=${user} AND record_type='processing_grant' LIMIT 2`;

  return yield* Schema.decodeUnknownEffect(Schema.Array(grantRow).check(Schema.isMaxLength(1)))(
    rows
  );
});

const auditDecision = Effect.fnUntraced(function* (
  subject: WebSessionSubject,
  current: number,
  operation: "consent.renew" | "consent.withdraw"
) {
  const sql = yield* SqliteClient;

  const changed =
    yield* sql`INSERT INTO audit_entries(record_type,id,user_id,session_id,operation,outcome,occurred_at_ms)
    VALUES('credential_call',${newId()},${subject.userId},${subject.id},${operation},'accepted',${current}) RETURNING id`;

  if (changed.length !== 1) return yield* Effect.fail("consent_audit_unavailable" as const);
});

const withdraw = Effect.fnUntraced(function* (subject: WebSessionSubject, current: number) {
  const previous = yield* receipt(subject, current);

  if (Option.isNone(previous)) return noAuthority();

  if (previous.value.status !== "Granted") return ok(previous.value);
  const sql = yield* SqliteClient;

  const updated =
    yield* sql`INSERT INTO consent_history(record_type,id,user_id,grant_record_id,session_id,occurred_at_ms)
    SELECT 'processing_withdrawal',${newId()},user_id,id,${subject.id},${current} FROM consent_history
    WHERE user_id=${subject.userId} AND record_type='processing_grant' RETURNING id`;

  if (updated.length !== 1) return yield* Effect.fail("withdrawal_unavailable" as const);
  yield* auditDecision(subject, current, "consent.withdraw");
  const settled = yield* receipt(subject, current);

  if (Option.isNone(settled) || settled.value.status !== "Revoked") {
    return yield* Effect.fail("withdrawal_unavailable" as const);
  }

  return ok(settled.value);
});

const matchesGrant = (
  grant: Option.Option<typeof grantRow.Type>,
  body: typeof ProcessingConsentRenewal.Type
): boolean =>
  Option.exists(
    grant,
    (saved) =>
      saved.reference === body.authorizationReference &&
      saved.disclosure.contentSha256 === body.disclosureSha256
  );

const renew = Effect.fnUntraced(function* (
  subject: WebSessionSubject,
  current: number,
  body: typeof ProcessingConsentRenewal.Type
) {
  const sql = yield* SqliteClient;
  const previous = yield* receipt(subject, current);

  if (Option.isNone(previous)) return noAuthority();
  const [grant] = yield* granted(subject.userId);

  if (!matchesGrant(Option.fromUndefinedOr(grant), body)) return consentResponse(forbidden);

  if (previous.value.status === "Revoked") {
    if (previous.value.withdrawal.reference !== body.withdrawalReference) {
      return consentResponse(forbidden);
    }

    const added =
      yield* sql`INSERT INTO consent_history(record_type,id,user_id,withdrawal_id,grant_record_id,session_id,disclosure_json,occurred_at_ms)
      SELECT 'processing_renewal',${newId()},user_id,${body.withdrawalReference},id,${subject.id},disclosure_json,${current}
      FROM consent_history WHERE user_id=${subject.userId} AND record_type='processing_grant' AND id=${body.authorizationReference} RETURNING id`;

    if (added.length !== 1) return yield* Effect.fail("renewal_unavailable" as const);
    yield* auditDecision(subject, current, "consent.renew");
  }

  const [row] =
    yield* sql`SELECT id AS reference, withdrawal_id AS withdrawalReference, occurred_at_ms AS acceptedAtMs
    FROM consent_history WHERE user_id=${subject.userId} AND record_type='processing_renewal' AND withdrawal_id=${body.withdrawalReference}
    AND grant_record_id=${body.authorizationReference}
    AND NOT EXISTS(SELECT 1 FROM consent_history newer WHERE newer.user_id=${subject.userId} AND newer.record_type='processing_withdrawal'
      AND newer.rowid>(SELECT rowid FROM consent_history WHERE id=${body.withdrawalReference}))`;

  if (row === undefined) return consentResponse(forbidden);

  return ok(
    yield* Schema.decodeUnknownEffect(ProcessingConsentRenewalReceipt)({
      status: "Granted",
      renewal: row,
    })
  );
});

type Decision =
  | { action: "status" | "authorization" | "withdraw" }
  | { action: "renew"; body: typeof ProcessingConsentRenewal.Type };

const readDecision = Effect.fnUntraced(function* (request: Request, action: string) {
  if (request.signal.aborted) return yield* Effect.fail("consent_request_aborted" as const);

  if (action === "status" || action === "authorization") return Option.some<Decision>({ action });
  const raw = yield* boundedJsonBody({ request, policy: bodyPolicy, schema: Schema.Unknown });
  const strict = { onExcessProperty: "error" } as const;

  if (action === "withdraw") {
    return Option.flatMap(
      raw,
      Schema.decodeUnknownOption(ProcessingConsentWithdrawal, strict)
    ).pipe(Option.map((): Decision => ({ action: "withdraw" })));
  }

  return Option.flatMap(raw, Schema.decodeUnknownOption(ProcessingConsentRenewal, strict)).pipe(
    Option.map((body): Decision => ({ action: "renew", body }))
  );
});

const observeDecision = Effect.fnUntraced(function* (
  decision: Decision,
  subject: WebSessionSubject,
  current: number
) {
  switch (decision.action) {
    case "withdraw":
      return yield* withdraw(subject, current);
    case "renew":
      return yield* renew(subject, current, decision.body);
    case "authorization": {
      const [authorization] = yield* granted(subject.userId);

      return ok(
        yield* Schema.decodeEffect(ProcessingAuthorization)({
          authorization: authorization ?? null,
        })
      );
    }

    case "status":
      return Option.match(yield* receipt(subject, current), { onNone: noAuthority, onSome: ok });
  }
});

class RetiredConsentProof extends Data.TaggedError("RetiredConsentProof")<{}> {}

type DecisionProof = { binding: string; digest: Uint8Array; signal: AbortSignal };

const decisionOwner = Effect.fnUntraced(function* (
  proof: DecisionProof,
  action: Decision["action"],
  current: number
) {
  if (proof.signal.aborted) return yield* Effect.fail("consent_request_aborted" as const);
  const sql = yield* SqliteClient;

  const [row] =
    yield* sql`SELECT user_id FROM web_sessions WHERE id=${proof.binding} AND token_digest=${proof.digest} AND revoked_at_ms IS NULL
    AND hard_expires_at_ms>${current} AND idle_expires_at_ms>${current} AND (${action}!='renew' OR fresh_until_ms>${current})
    AND NOT EXISTS(SELECT 1 FROM erasure_requests)`;

  return Schema.decodeUnknownOption(UserId)(row?.user_id);
});

const authorizedDecision = Effect.fnUntraced(function* (
  decision: Decision,
  proof: DecisionProof,
  owns: (id: string) => boolean
) {
  const current = yield* Clock.currentTimeMillis;
  const user = yield* decisionOwner(proof, decision.action, current);

  if (Option.isNone(user) || !owns(user.value)) return noAuthority();

  if ((yield* admitLocalRequest({ user: user.value, current })).length !== 1) return rateLimited();

  const response = yield* Effect.result(
    observeDecision(
      decision,
      { userId: user.value, id: proof.binding, digest: proof.digest },
      current
    )
  );

  const retained = yield* decisionOwner(proof, decision.action, yield* Clock.currentTimeMillis);

  if (!Option.contains(retained, user.value)) return yield* new RetiredConsentProof();

  return Result.isFailure(response) ? yield* Effect.fail(response.failure) : response.success;
});

const missingRoute = 404,
  wrongMethod = 405;

export const localProcessingConsent = Effect.fn(
  function* (request: Request, origin: string, owns: (id: string) => boolean) {
    const url = new URL(request.url);
    const transport = processingConsentTransport(url.pathname);

    if (Option.isNone(transport)) return consentResponse(missingRoute);

    if (request.method !== transport.value.method) return consentResponse(wrongMethod);

    if (request.headers.get("origin") !== origin || request.headers.has("authorization")) {
      return consentResponse(forbidden);
    }

    if (url.search !== "") return consentResponse(badInput);
    const proof = yield* Effect.tryPromise(() => readBoundWebSessionProof(request));

    if (Option.isNone(proof)) return noAuthority();
    const decision = yield* readDecision(request, transport.value.operation);

    if (Option.isNone(decision)) return consentResponse(badInput);

    return yield* authorizedDecision(
      decision.value,
      { ...proof.value, signal: request.signal },
      owns
    ).pipe(
      withStoreCapacity("required"),
      Effect.catchTag("RetiredConsentProof", () => Effect.succeed(noAuthority()))
    );
  },
  Effect.tapCause(() =>
    Effect.logWarning({
      component: "consent",
      operation: "localProcessingConsent",
      outcome: "unavailable",
    })
  ),
  Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable()))
);
