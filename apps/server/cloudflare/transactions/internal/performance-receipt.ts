import {
  PerformanceAccountingRequest,
  ReceiptRequest,
  acceptanceProviderRevision,
  performanceAccountingMember,
  performanceReceiptMarker,
  performanceReceiptMember,
} from "../../release-isolation/contract";
import { Clock, Effect, Option, type PlatformError, Schema } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Hex } from "effect/encoding";
import { localPreparationSubject } from "../../canonical-admission/operations";
import { canonicalOperation } from "../../routing/operations";
import {
  performanceEvidenceAdmitted,
  sealTransactionReceipt,
  signPerformanceAccounting,
  verifyIssuedCapture,
} from "../../release-isolation/operations";
import type {
  AcceptanceEnvironment,
  AcceptanceWindowBindings,
  PerformanceMember,
  SealedTransactionReceipt,
} from "../../release-isolation/contract";
import { boundedJsonBody } from "../../http/operations";
import { RequestBodyPolicy } from "../../http/contract";
import { digestBytes } from "../../secret-material/operations";

const policy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 256,
  deadlineMilliseconds: 2000,
});

const accountingPolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 50_000,
  deadlineMilliseconds: 2000,
});

const expectedCount = 8;

const maximumAccountingGroups = 16;

const maximumAccountingRows = 256;

const maximumOperationLength = 96;

const maximumOutcomeLength = 32;

const nonnegative = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const AccountingRows = Schema.Array(
  Schema.Struct({
    operation: Schema.String.check(Schema.isMaxLength(maximumOperationLength)),
    outcome: Schema.String.check(Schema.isMaxLength(maximumOutcomeLength)),
    count: nonnegative,
  })
);

const AccountingTotals = Schema.Tuple([
  Schema.Struct({
    canonicalUnits: nonnegative,
    allowanceRows: nonnegative,
    receipts: nonnegative,
  }),
]);

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

const performanceSubject = (revision: string, member: PerformanceMember): string =>
  "fidy-acceptance-" + revision + "-" + member;

const readEvidence = Effect.fn(function* (input: {
  user: string;
  revision: string;
  member: PerformanceMember;
  binding: string;
}) {
  const { user, revision, member, binding } = input;
  const sql = yield* SqliteClient;
  const subject = performanceSubject(revision, member);

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

type FixtureCredentials = {
  secret: string;
  privateKey: string;
  bucket: Pick<R2Bucket, "get" | "put">;
  member: PerformanceMember;
};

const credentials = (
  env: FixtureEnvironment,
  request: Request
): Option.Option<FixtureCredentials> => {
  const selected = env.NATIVE_FIXTURE_MEMBER;

  const member = Option.filter(
    Option.orElse(performanceReceiptMember(request), () => performanceAccountingMember(request)),
    (value) =>
      selected === undefined
        ? value === "performance-1"
        : selected === "performance-2" && value === selected
  );

  return Option.isSome(member) &&
    env.SMOKE_PROOF !== undefined &&
    env.SMOKE_PROOF !== "" &&
    env.NATIVE_FIXTURE_SIGNING_KEY !== undefined &&
    env.NATIVE_FIXTURE_SIGNING_KEY !== "" &&
    env.SMOKE_BUCKET !== undefined
    ? Option.some({
        secret: env.SMOKE_PROOF,
        privateKey: env.NATIVE_FIXTURE_SIGNING_KEY,
        bucket: env.SMOKE_BUCKET,
        member: member.value,
      })
    : Option.none();
};

const boundUser = Effect.fn(function* (request: Request, owns: (user: string) => boolean) {
  const operation = canonicalOperation({ method: "GET", path: "/transactions" });

  return Option.isSome(operation)
    ? yield* localPreparationSubject(request, owns, operation.value)
    : Option.none();
});

const fingerprint = (text: string): Effect.Effect<string, PlatformError.PlatformError> =>
  digestBytes(new TextEncoder().encode(text)).pipe(Effect.map(Hex.encode));

const accountingSnapshot = Effect.fn(function* (input: {
  request: Request;
  owns: (user: string) => boolean;
  binding: string;
  providerSubject: string;
}) {
  const sql = yield* SqliteClient;

  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const user = yield* boundUser(input.request, input.owns);

      if (Option.isNone(user)) return Option.none();

      const disposable = yield* sql`SELECT 1 FROM provider_credentials WHERE user_id=${user.value}
        AND issuer='https://accounts.google.com' AND subject=${input.providerSubject}`;

      if (disposable.length !== 1) return Option.none();

      const groups = yield* Schema.decodeUnknownEffect(AccountingRows)(
        yield* sql`SELECT operation,outcome,count(*) AS count
          FROM (SELECT operation,outcome FROM audit_entries WHERE user_id=${user.value}
            AND session_id=${input.binding} AND operation IS NOT NULL LIMIT ${maximumAccountingRows + 1})
          GROUP BY operation,outcome ORDER BY operation,outcome LIMIT ${maximumAccountingGroups + 1}`
      );

      const [totals] = yield* Schema.decodeUnknownEffect(AccountingTotals)(
        yield* sql`SELECT coalesce(sum(units),0) AS canonicalUnits,count(*) AS allowanceRows,
          (SELECT count(*) FROM (SELECT 1 FROM canonical_request_receipts WHERE user_id=${user.value}
            LIMIT ${maximumAccountingRows + 1})) AS receipts
          FROM (SELECT units FROM commercial_allowance_consumptions WHERE user_id=${user.value}
            AND allowance='canonical_call' LIMIT ${maximumAccountingRows + 1})`
      );

      if (
        groups.length > maximumAccountingGroups ||
        groups.reduce((count, group) => count + group.count, 0) > maximumAccountingRows ||
        totals.allowanceRows > maximumAccountingRows ||
        totals.receipts > maximumAccountingRows
      ) {
        return Option.none();
      }

      return Option.some({
        audit: groups.map(({ operation, outcome, count }) => [operation, outcome, count] as const),
        canonicalUnits: totals.canonicalUnits,
        receipts: totals.receipts,
      });
    })
  );
});

const captureMarkerMatches = Effect.fn(function* (input: {
  capture: typeof SealedTransactionReceipt.Type;
  environment: FixtureEnvironment;
  binding: string;
  signer: FixtureCredentials;
}) {
  const { capture, environment, binding, signer } = input;
  const { nativeRevision, member, resourcePrefix, sessionBindingSha256 } = capture;

  if (nativeRevision !== environment.RELEASE_GIT_SHA || member !== signer.member) return false;
  const boundDigest = yield* fingerprint(binding);

  if (
    boundDigest !== sessionBindingSha256 ||
    !(yield* verifyIssuedCapture(signer.privateKey, capture))
  ) {
    return false;
  }

  const marker = yield* Effect.tryPromise(() =>
    signer.bucket.get(performanceReceiptMarker(capture))
  );

  if (marker === null || marker.size !== resourcePrefix.length) return false;

  return (yield* Effect.tryPromise(() => marker.text())) === resourcePrefix;
});

const json = Schema.fromJsonString(Schema.Json);

const witnessAccounting = Effect.fn(function* (input: {
  request: Request;
  environment: FixtureEnvironment;
  owns: (user: string) => boolean;
  binding: string;
  signer: FixtureCredentials;
}) {
  const { request, environment, owns, binding, signer } = input;

  const command = yield* boundedJsonBody({
    request,
    policy: accountingPolicy,
    schema: PerformanceAccountingRequest,
  });

  if (Option.isNone(command)) return denied();
  const { phase, capture } = command.value;

  if (!(yield* captureMarkerMatches({ capture, environment, binding, signer }))) return denied();

  const { nativeRevision, member, resourcePrefix, nativeManifestDigest, sessionBindingSha256 } =
    capture;

  const snapshot = yield* accountingSnapshot({
    request,
    owns,
    binding,
    providerSubject: performanceSubject(acceptanceProviderRevision(environment), member),
  });

  if (Option.isNone(snapshot)) return denied();

  const nativeReceiptDigest = yield* fingerprint(
    yield* Schema.encodeEffect(json)({
      iv: capture.iv,
      member,
      nativeManifestDigest,
      nativeRevision,
      resourcePrefix,
      sealed: capture.sealed,
      sessionBindingSha256,
      signature: capture.signature,
    })
  );

  const { audit, canonicalUnits, receipts } = snapshot.value;

  const statement = [
    "fidy-2259-native-accounting-v1",
    nativeRevision,
    member,
    resourcePrefix,
    nativeReceiptDigest,
    sessionBindingSha256,
    phase,
    audit,
    canonicalUnits,
    receipts,
  ] as const;

  const signature = yield* signPerformanceAccounting({
    privateKey: signer.privateKey,
    statement: yield* Schema.encodeEffect(json)(statement),
  });

  return Response.json({ statement, signature }, { headers: { "cache-control": "no-store" } });
});

const issueOnce = Effect.fnUntraced(function* (input: {
  bucket: Pick<R2Bucket, "put">;
  receipt: typeof SealedTransactionReceipt.Type;
}) {
  const { resourcePrefix } = input.receipt;
  const key = performanceReceiptMarker(input.receipt);

  const stored = yield* Effect.tryPromise(() =>
    input.bucket.put(key, resourcePrefix, { onlyIf: { etagDoesNotMatch: "*" } })
  );

  return stored === null
    ? denied()
    : Response.json(input.receipt, { headers: { "cache-control": "no-store" } });
});

const offerCapture = Effect.fn(function* (input: {
  request: Request;
  environment: FixtureEnvironment;
  owns: (user: string) => boolean;
  binding: string;
  signer: FixtureCredentials;
}) {
  const { request, environment, owns, binding, signer } = input;
  const command = yield* boundedJsonBody({ request, policy, schema: ReceiptRequest });

  if (Option.isNone(command)) return denied();
  const user = yield* boundUser(request, owns);

  if (Option.isNone(user)) return denied();
  const { secret, privateKey, bucket, member } = signer;

  const evidence = yield* readEvidence({
    user: user.value,
    revision: acceptanceProviderRevision(environment),
    member,
    binding,
  });

  if (Option.isNone(evidence)) return denied();
  const sessionBindingSha256 = yield* fingerprint(binding);

  const coordinates = {
    ...command.value,
    nativeRevision: environment.RELEASE_GIT_SHA,
    member,
    sessionBindingSha256,
  };

  const data = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(evidence.value);
  const box = yield* sealTransactionReceipt({ secret, privateKey, coordinates, data });

  return yield* issueOnce({ bucket, receipt: box });
});

export const ownPerformanceEvidence = Effect.fn(
  function* (request: Request, environment: FixtureEnvironment, owns: (id: string) => boolean) {
    const now = yield* Clock.currentTimeMillis;
    const binding = request.headers.get("fidy-session-binding") ?? "";
    const signer = credentials(environment, request);

    if (
      binding === "" ||
      Option.isNone(signer) ||
      !(yield* performanceEvidenceAdmitted({ request, environment, boundary: "core", now }))
    ) {
      return denied();
    }

    if (Option.isSome(performanceAccountingMember(request))) {
      return yield* witnessAccounting({
        request,
        environment,
        owns,
        binding,
        signer: signer.value,
      });
    }

    return yield* offerCapture({ request, environment, owns, binding, signer: signer.value });
  },
  Effect.tapError(Effect.logDebug),
  Effect.orElseSucceed(denied)
);
