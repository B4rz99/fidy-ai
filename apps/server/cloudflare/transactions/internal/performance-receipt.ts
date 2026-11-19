import { Clock, Effect, Option, Schema } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Hex } from "effect/encoding";
import { localPreparationSubject } from "../../canonical-admission/operations";
import { canonicalOperation } from "../../routing/operations";
import {
  ReceiptRequest,
  receiptAdmitted,
  sealTransactionReceipt,
} from "../../release-isolation/operations";
import type {
  AcceptanceEnvironment,
  AcceptanceWindowBindings,
} from "../../release-isolation/contract";
import { boundedJsonBody } from "../../http/operations";
import { RequestBodyPolicy } from "../../http/contract";

const policy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 256,
  deadlineMilliseconds: 2000,
});
const expectedCount = 8;
const epoch = 1794916800000;
const minuteMs = 60000;
const uuid = Schema.String.check(Schema.isUUID());
const Capture = Schema.Struct({
  id: uuid,
  transactionId: uuid,
  kind: Schema.Literal("manual"),
  serviceMarket: Schema.Literal("CO"),
  locale: Schema.Literal("es-CO"),
  timeZone: Schema.Literal("America/Bogota"),
  interpretationRevision: Schema.Literal("manual-v1"),
  createdAtMs: Schema.Int,
  decisions: Schema.String,
  amount: Schema.Literal("1000"),
  currency: Schema.Literals(["COP", "USD"]),
  direction: Schema.Literal("outflow"),
  counterparty: Schema.String,
  categoryId: uuid,
  occurred: Schema.Int,
  revision: Schema.Literal(0),
  notes: Schema.Null,
});
const Link = Schema.Struct({ first: uuid, second: uuid, visible: uuid, decidedAtMs: Schema.Int });
const denied = (): Response =>
  new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
const fixtureRow = (row: typeof Capture.Type, ordinal: number): boolean => {
  const purchase = ordinal === 1 ? 0 : ordinal;
  const category = purchase % 3 === 0 ? 1 : (purchase % 15) + 2;
  const decisions = Schema.decodeUnknownOption(
    Schema.fromJsonString(Schema.Record(Schema.String, Schema.Boolean))
  )(row.decisions);
  return (
    row.currency === (purchase % 2 === 0 ? "COP" : "USD") &&
    row.counterparty === "Evaluación " + purchase &&
    row.categoryId === "10000000-0000-4000-8000-" + String(category).padStart(12, "0") &&
    row.occurred === epoch - purchase * minuteMs &&
    Option.isSome(decisions) &&
    Object.keys(decisions.value).sort().join(",") ===
      "categoryId,counterparty,direction,money,occurredAt" &&
    Object.values(decisions.value).every((value) => value)
  );
};
const readEvidence = Effect.fn(function* (user: string, revision: string, binding: string) {
  const sql = yield* SqliteClient;
  const subject = "fidy-acceptance-" + revision + "-performance-1";
  const proof = yield* sql`SELECT 1 FROM provider_credentials p
    WHERE p.user_id=${user} AND p.issuer='https://accounts.google.com' AND p.subject=${subject}
    AND (SELECT count(*) FROM transactions WHERE user_id=${user})=8
    AND (SELECT count(*) FROM source_attestations WHERE user_id=${user})=8
    AND EXISTS(SELECT 1 FROM audit_entries WHERE user_id=${user} AND session_id=${binding}
      AND operation='transactions.linkTransactions' AND outcome='success')
    AND EXISTS(SELECT 1 FROM audit_entries WHERE user_id=${user} AND session_id=${binding}
      AND operation='transactions.getTransaction' AND outcome='success')`;
  if (proof.length !== 1) return Option.none();
  const rows =
    yield* sql`SELECT s.id,s.transaction_id AS transactionId,s.kind,s.service_market AS serviceMarket,
    s.locale,s.time_zone AS timeZone,s.interpretation_revision AS interpretationRevision,s.created_at_ms AS createdAtMs,
    t.user_decisions AS decisions,t.amount,t.currency,t.direction,t.counterparty,t.category_id AS categoryId,
    t.occurred_at_ms AS occurred,t.revision,t.notes FROM source_attestations s JOIN transactions t
    ON t.user_id=s.user_id AND t.id=s.transaction_id AND t.created_at_ms=s.created_at_ms
    WHERE s.user_id=${user} AND t.deleted_at_ms IS NULL ORDER BY t.occurred_at_ms DESC,t.id LIMIT 9`;
  const capture = yield* Schema.decodeUnknownEffect(Schema.Array(Capture))(rows);
  if (
    capture.length !== expectedCount ||
    !capture.every(fixtureRow) ||
    new Set(capture.map((r) => r.transactionId)).size !== expectedCount
  )
    return Option.none();
  const links = yield* Schema.decodeUnknownEffect(Schema.Array(Link))(
    yield* sql`SELECT first_transaction_id AS first,
    second_transaction_id AS second,visible_transaction_id AS visible,decided_at_ms AS decidedAtMs
    FROM transaction_reconciliation_decisions WHERE user_id=${user} AND state='linked' LIMIT 2`
  );
  const link = links[0],
    pair = capture.slice(0, 2).map((r) => r.transactionId);
  if (
    links.length !== 1 ||
    link === undefined ||
    !pair.includes(link.first) ||
    !pair.includes(link.second) ||
    !pair.includes(link.visible)
  )
    return Option.none();
  return Option.some({
    capture: capture.map(
      ({
        id,
        transactionId,
        kind,
        serviceMarket,
        locale,
        timeZone,
        interpretationRevision,
        createdAtMs,
        decisions,
      }) => ({
        id,
        transactionId,
        kind,
        serviceMarket,
        locale,
        timeZone,
        interpretationRevision,
        createdAtMs,
        decisions,
      })
    ),
    links,
  });
});
export const ownPerformanceReceipt = Effect.fn(function* (
  request: Request,
  environment: AcceptanceEnvironment &
    AcceptanceWindowBindings & { NATIVE_FIXTURE_SIGNING_KEY?: string },
  owns: (id: string) => boolean
) {
  const now = yield* Clock.currentTimeMillis;
  const binding = request.headers.get("fidy-session-binding");
  if (
    !binding ||
    !environment.SMOKE_BUCKET ||
    !environment.SMOKE_PROOF ||
    !environment.NATIVE_FIXTURE_SIGNING_KEY ||
    !(yield* receiptAdmitted(request, environment, "core", now))
  )
    return denied();
  const command = yield* boundedJsonBody({ request, policy, schema: ReceiptRequest });
  const operation = canonicalOperation({ method: "GET", path: "/transactions" });
  if (Option.isNone(command) || Option.isNone(operation)) return denied();
  const user = yield* localPreparationSubject(request, owns, operation.value);
  if (Option.isNone(user)) return denied();
  const evidence = yield* readEvidence(user.value, environment.RELEASE_GIT_SHA, binding);
  if (Option.isNone(evidence)) return denied();
  const digest = yield* Effect.tryPromise(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(binding))
  );
  const coordinates = {
    ...command.value,
    nativeRevision: environment.RELEASE_GIT_SHA,
    member: "performance-1" as const,
    sessionBindingSha256: Hex.encode(new Uint8Array(digest)),
  };
  const data = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(evidence.value);
  const secret = environment.SMOKE_PROOF,
    signing = environment.NATIVE_FIXTURE_SIGNING_KEY,
    bucket = environment.SMOKE_BUCKET;
  const box = yield* Effect.tryPromise(() =>
    sealTransactionReceipt(secret, signing, coordinates, data)
  );
  const key =
    "_release-smoke/" + environment.RELEASE_GIT_SHA + "/acceptance/transactions/performance-1";
  const stored = yield* Effect.tryPromise(() =>
    bucket.put(key, command.value.resourcePrefix, { onlyIf: { etagDoesNotMatch: "*" } })
  );
  return stored ? Response.json(box, { headers: { "cache-control": "no-store" } }) : denied();
}, Effect.orElseSucceed(denied));
