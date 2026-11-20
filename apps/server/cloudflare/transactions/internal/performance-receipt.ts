import { ReceiptRequest, acceptanceProviderRevision } from "../../release-isolation/contract";
import { Clock, Effect, Option, Schema } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Hex } from "effect/encoding";
import { localPreparationSubject } from "../../canonical-admission/operations";
import { canonicalOperation } from "../../routing/operations";
import { receiptAdmitted, sealTransactionReceipt } from "../../release-isolation/operations";
import type {
  AcceptanceEnvironment,
  AcceptanceWindowBindings,
  SealedTransactionReceipt,
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
const decisionsMatch = (raw: string): boolean => {
  const value = Schema.decodeOption(
    Schema.fromJsonString(Schema.Record(Schema.String, Schema.Boolean))
  )(raw);
  return (
    Option.isSome(value) &&
    Object.keys(value.value).sort().join(",") ===
      "categoryId,counterparty,direction,money,occurredAt" &&
    Object.values(value.value).every((flag) => flag)
  );
};
const fixtureRow = (row: typeof Capture.Type, ordinal: number): boolean => {
  const purchase = ordinal === 1 ? 0 : ordinal,
    category = purchase % 3 === 0 ? 1 : purchase + 2,
    uuidDigits = 12;
  return (
    row.currency === (purchase % 2 === 0 ? "COP" : "USD") &&
    row.counterparty === "Evaluación " + purchase &&
    row.categoryId === "10000000-0000-4000-8000-" + String(category).padStart(uuidDigits, "0") &&
    row.occurred === epoch - purchase * minuteMs &&
    decisionsMatch(row.decisions)
  );
};
const linkedOriginals = (
  links: ReadonlyArray<typeof Link.Type>,
  capture: ReadonlyArray<typeof Capture.Type>
): boolean => {
  const pair = capture.slice(0, 2).map((row) => row.transactionId),
    link = links[0];
  return (
    links.length === 1 &&
    link !== undefined &&
    [link.first, link.second, link.visible].every((id) => pair.includes(id))
  );
};
const readEvidence = Effect.fn(function* (user: string, revision: string, binding: string) {
  const sql = yield* SqliteClient;
  const subject = "fidy-acceptance-" + revision + "-performance-1";
  const proof = yield* sql`SELECT 1 FROM provider_credentials p
    WHERE p.user_id=${user} AND p.issuer='https://accounts.google.com' AND p.subject=${subject}
    AND (SELECT count(*) FROM transactions WHERE user_id=${user})=8
    AND (SELECT count(*) FROM source_attestations WHERE user_id=${user})=8
    AND (SELECT count(*) FROM audit_entries WHERE user_id=${user} AND session_id=${binding}
      AND operation='transactions.createTransaction' AND outcome='success')=8
    AND (SELECT count(*) FROM audit_entries WHERE user_id=${user} AND session_id=${binding}
      AND operation='transactions.linkTransactions' AND outcome='success')=1
    AND (SELECT count(*) FROM audit_entries WHERE user_id=${user} AND session_id=${binding}
      AND operation='transactions.getTransaction' AND outcome='success')>=8`;
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
    new Set(capture.map((row) => row.transactionId)).size !== expectedCount
  ) {
    return Option.none();
  }
  const links = yield* Schema.decodeUnknownEffect(Schema.Array(Link))(
    yield* sql`SELECT first_transaction_id AS first,
    second_transaction_id AS second,visible_transaction_id AS visible,decided_at_ms AS decidedAtMs
    FROM transaction_reconciliation_decisions WHERE user_id=${user} AND state='linked' LIMIT 2`
  );
  if (!linkedOriginals(links, capture)) return Option.none();
  return Option.some({ capture, links });
});
type FixtureEnvironment = AcceptanceEnvironment &
  AcceptanceWindowBindings &
  Partial<Readonly<{ NATIVE_FIXTURE_SIGNING_KEY: string }>>;
const credentials = (
  env: FixtureEnvironment
): Option.Option<{ secret: string; privateKey: string; bucket: Pick<R2Bucket, "get" | "put"> }> =>
  env.SMOKE_PROOF !== undefined &&
  env.SMOKE_PROOF !== "" &&
  env.NATIVE_FIXTURE_SIGNING_KEY !== undefined &&
  env.NATIVE_FIXTURE_SIGNING_KEY !== "" &&
  env.SMOKE_BUCKET !== undefined
    ? Option.some({
        secret: env.SMOKE_PROOF,
        privateKey: env.NATIVE_FIXTURE_SIGNING_KEY,
        bucket: env.SMOKE_BUCKET,
      })
    : Option.none();
const boundUser = Effect.fn(function* (request: Request, owns: (user: string) => boolean) {
  const operation = canonicalOperation({ method: "GET", path: "/transactions" });
  return Option.isSome(operation)
    ? yield* localPreparationSubject(request, owns, operation.value)
    : Option.none();
});
const issueOnce = Effect.fnUntraced(function* (input: {
  bucket: Pick<R2Bucket, "put">;
  revision: string;
  prefix: string;
  receipt: typeof SealedTransactionReceipt.Type;
}) {
  const key = "_release-smoke/" + input.revision + "/acceptance/transactions/performance-1";
  const stored = yield* Effect.tryPromise(() =>
    input.bucket.put(key, input.prefix, { onlyIf: { etagDoesNotMatch: "*" } })
  );
  return stored === null
    ? denied()
    : Response.json(input.receipt, { headers: { "cache-control": "no-store" } });
});
export const ownPerformanceReceipt = Effect.fn(function* (
  request: Request,
  environment: AcceptanceEnvironment &
    AcceptanceWindowBindings &
    Partial<Readonly<{ NATIVE_FIXTURE_SIGNING_KEY: string }>>,
  owns: (id: string) => boolean
) {
  const now = yield* Clock.currentTimeMillis;
  const binding = request.headers.get("fidy-session-binding") ?? "";
  const signer = credentials(environment);
  if (
    binding === "" ||
    Option.isNone(signer) ||
    !(yield* receiptAdmitted({ request, environment, boundary: "core", now }))
  ) {
    return denied();
  }
  const command = yield* boundedJsonBody({ request, policy, schema: ReceiptRequest });
  if (Option.isNone(command)) return denied();
  const user = yield* boundUser(request, owns);
  if (Option.isNone(user)) return denied();
  const evidence = yield* readEvidence(
    user.value,
    acceptanceProviderRevision(environment),
    binding
  );
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
  const { secret, privateKey, bucket } = signer.value;
  const box = yield* sealTransactionReceipt({ secret, privateKey, coordinates, data });
  return yield* issueOnce({
    bucket,
    revision: coordinates.nativeRevision,
    prefix: coordinates.resourcePrefix,
    receipt: box,
  });
}, Effect.orElseSucceed(denied));
