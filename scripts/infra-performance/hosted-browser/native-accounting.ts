import { isDeepStrictEqual } from "node:util";
import { Clock, Config, Data, Effect, ManagedRuntime, Schema } from "effect";
import { FetchHttpClient, HttpBody, HttpClient, HttpClientRequest } from "effect/http";
import { installedOrigins } from "../../../apps/server/src/shell/browser-transport/contract";
import { signAcceptanceRequest } from "../../../apps/server/cloudflare/release-isolation/operations";
import {
  SealedTransactionReceipt,
  acceptanceLifetimeMs,
  acceptanceProofHeader,
} from "../../../apps/server/cloudflare/release-isolation/contract";

const Phase = Schema.Literals(["before", "after"]);

const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));

const Count = Schema.Natural;

const AuditGroup = Schema.Tuple([Schema.NonEmptyString, Schema.NonEmptyString, Count]);

const Snapshot = Schema.Struct({
  groups: Schema.Array(AuditGroup),
  canonicalUnits: Count,
  receipts: Count,
});

const Report = Schema.Struct({
  statement: Schema.Tuple([
    Schema.Literal("fidy-2259-native-accounting-v1"),
    SealedTransactionReceipt.fields.nativeRevision,
    SealedTransactionReceipt.fields.member,
    SealedTransactionReceipt.fields.resourcePrefix,
    Sha256,
    Sha256,
    Phase,
    Snapshot.fields.groups,
    Count,
    Count,
  ]),
  signature: SealedTransactionReceipt.fields.signature,
});

const Scope = Schema.Struct({
  phase: Phase,
  capture: SealedTransactionReceipt,
  captureDigest: Sha256,
  cookie: Schema.String.check(Schema.isPattern(/^__Host-fidy_session=[^;]+$/u)),
  binding: Schema.NonEmptyString,
  deadline: Schema.Int,
});

type Scope = typeof Scope.Type;

const origins = installedOrigins.acceptance;

const canonical = Schema.encodeSync(Schema.fromJsonString(Schema.Json));

const maximumGroups = 16;

const maximumBytes = 8192;

const requestTimeout = 15000;

const successStatus = 200;

const algorithm = { name: "ECDSA", namedCurve: "P-256" };

const digest = (binding: string): string =>
  new Bun.CryptoHasher("sha256").update(binding).digest("hex");

class AccountingCryptographyError extends Data.TaggedError("AccountingCryptographyError") {}

const cryptoOperation = <A>(run: () => Promise<A>): Effect.Effect<A, AccountingCryptographyError> =>
  Effect.tryPromise({ try: run, catch: () => new AccountingCryptographyError() });

export const verifyAccounting = Effect.fn("verifyAccounting")(function* ({
  scope,
  text,
  publicKey,
}: {
  scope: Pick<Scope, "phase" | "capture" | "captureDigest" | "binding">;
  text: string;
  publicKey: string;
}) {
  const { statement, signature } = yield* Schema.decodeEffect(Schema.fromJsonString(Report))(text);
  const [, , , , , , , groups, canonicalUnits, receipts] = statement;

  const expected = [
    "fidy-2259-native-accounting-v1",
    scope.capture.nativeRevision,
    scope.capture.member,
    scope.capture.resourcePrefix,
    scope.captureDigest,
    digest(scope.binding),
    scope.phase,
  ];

  if (
    !isDeepStrictEqual(statement.slice(0, expected.length), expected) ||
    scope.capture.sessionBindingSha256 !== expected[5] ||
    groups.length > maximumGroups
  ) {
    return yield* Effect.fail(Error("Native accounting witness scope differs"));
  }

  const key = yield* cryptoOperation(() =>
    crypto.subtle.importKey("spki", Buffer.from(publicKey, "hex"), algorithm, false, ["verify"])
  );

  const signatureMatches = yield* cryptoOperation(() =>
    crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      Buffer.from(signature, "hex"),
      new TextEncoder().encode(canonical(statement))
    )
  );

  if (!signatureMatches) {
    return yield* Effect.fail(Error("Native accounting witness signature differs"));
  }

  return { groups, canonicalUnits, receipts };
});

const snapshot = Effect.fn("nativeAccountingSnapshot")(function* (scope: Scope) {
  const now = yield* Clock.currentTimeMillis;
  const deadline = Math.min(scope.deadline, now + acceptanceLifetimeMs);

  if (deadline <= now) return yield* Effect.fail(Error("Native accounting lease expired"));
  const url = new URL("/internal/release-smoke", origins.api);
  url.searchParams.set("acceptance", "transaction-accounting");
  url.searchParams.set("cohort", "performance");
  url.searchParams.set("ordinal", scope.capture.member === "performance-1" ? "1" : "2");
  const payload = canonical({ phase: scope.phase, capture: scope.capture });

  const headers = {
    cookie: scope.cookie,
    origin: origins.browser,
    "fidy-session-binding": scope.binding,
    "content-type": "application/json",
  };

  const request = new Request(url.href, {
    method: "POST",
    redirect: "error",
    headers,
    body: payload,
  });

  const proof = yield* signAcceptanceRequest({
    request,
    boundary: "ingress",
    environment: {
      BROWSER_ORIGIN: origins.browser,
      RELEASE_GIT_SHA: scope.capture.nativeRevision,
      SMOKE_PROOF: yield* Config.String("SMOKE_PROOF"),
      RECOVERY_ISOLATION: "isolated",
      NATIVE_STORAGE_ADMISSION: "closed",
    },
    deadline,
  });

  const remaining = Math.min(deadline - (yield* Clock.currentTimeMillis), requestTimeout);

  if (remaining <= 0) {
    return yield* Effect.fail(Error("Native accounting lease expired before dispatch"));
  }

  const client = yield* HttpClient.HttpClient;

  const response = yield* client
    .execute(
      HttpClientRequest.post(url.href, {
        headers: { ...headers, [acceptanceProofHeader]: proof },
        body: HttpBody.text(payload, "application/json"),
      })
    )
    .pipe(Effect.timeout(remaining));

  if (response.status !== successStatus) {
    return yield* Effect.fail(Error("Native accounting witness refused"));
  }

  const bytes = yield* response.arrayBuffer.pipe(Effect.timeout(remaining));

  if (bytes.byteLength > maximumBytes) {
    return yield* Effect.fail(Error("Native accounting witness exceeds bound"));
  }

  return yield* verifyAccounting({
    scope,
    text: new TextDecoder().decode(bytes),
    publicKey: yield* Config.String("FIDY_NATIVE_FIXTURE_PUBLIC_KEY"),
  });
});

export const nativeAccountingSnapshot = Effect.fn(function* (input: unknown) {
  return yield* snapshot(yield* Schema.decodeUnknownEffect(Scope)(input));
});

if (import.meta.main) {
  const runtime = ManagedRuntime.make(FetchHttpClient.layer);

  try {
    const input: unknown = await Bun.stdin.json();

    const proof = await runtime.runPromise(
      nativeAccountingSnapshot(input).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" })
      )
    );

    process.stdout.write(canonical(proof));
  } catch {
    process.stderr.write("Protected native accounting witness failed\n");
    process.exitCode = 1;
  } finally {
    await runtime.dispose();
  }
}
