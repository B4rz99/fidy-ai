#!/usr/bin/env bun
import {
  Cause,
  Clock,
  DateTime,
  Effect,
  Exit,
  Layer,
  Option,
  Redacted,
  Result,
  Schema,
  Stream,
} from "effect";
import { BunCrypto, BunFileSystem } from "@effect/platform-bun";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import type { HttpClientResponse } from "effect/http";
import { parseArgs } from "node:util";
import {
  VerificationFailure,
  attempt,
  command,
  encodeJson,
  privateDirectory,
  query,
  readScope,
  requireCheck,
  snapshot,
  writeJson,
} from "./production-fixture";
import type { ApprovedScope, FixtureSnapshot } from "./production-fixture";
import { approveNativeLogin, productionBrowser, revokeConnections } from "./production-browser";
import { checkObservation, startObservation, verifyProvenance } from "./production-observation";
import type { Browser } from "@playwright/test";
import type { Observation } from "./production-observation";
import { nativeCredential, nativeLogin, nativeLogout, nativeTools } from "./production-native";
import type { NativeHost } from "./production-native";
import { validateCatalog } from "./production-catalog";
import { disposeBudget } from "./production-cleanup";

const GRANT_MAX_MS = 604_800_000;
const GRANT_MIN_MS = 604_740_000;
const CLEANUP_RESERVE = 10;
const UNAUTHORIZED = 401;
const BAD_REQUEST = 400;
const CLAUDE_READS = 20;
const CODEX_READS = 10;
const EXPIRY_MARGIN_MS = 2_000;
const MAX_EXPIRY_WAIT_MS = 610_000;
const WAIT_TICK_MS = 30_000;
const MINUTE_MS = 60_000;
const HOSTS = ["claude", "codex"] as const;
const report = (phase: string): Effect.Effect<void> =>
  Effect.sync(() => {
    process.stdout.write(encodeJson({ phase }) + "\n");
  });
const Connections = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    scopes_json: Schema.String,
    approved_at_ms: Schema.Finite,
    expires_at_ms: Schema.Finite,
  })
);
const connections = Effect.fn(function* (scope: ApprovedScope) {
  const rows = yield* query(
    scope,
    `SELECT id,scopes_json,approved_at_ms,expires_at_ms FROM oauth_connections WHERE user_id='${scope.fixtureUserId}' AND revoked_at_ms IS NULL ORDER BY id;`
  );
  return yield* Schema.decodeUnknownEffect(Connections)(rows).pipe(
    Effect.mapError(() => new VerificationFailure({ message: "Connection metadata invalid" }))
  );
});
const validateConnections = Effect.fn(function* (scope: ApprovedScope) {
  const grants = yield* connections(scope);
  yield* requireCheck(grants.length === 2, "Expected two synthetic native connections");
  for (const grant of grants) {
    yield* requireCheck(
      grant.scopes_json === '["read","write"]',
      "OAuth permission narrowing did not persist"
    );
    const lifetime = grant.expires_at_ms - grant.approved_at_ms;
    yield* requireCheck(
      lifetime > GRANT_MIN_MS && lifetime <= GRANT_MAX_MS,
      "Seven-day connection lifetime did not persist"
    );
  }
  return grants;
});
const validatePinnedHosts = Effect.fn(function* (scope: ApprovedScope) {
  for (const [host, version] of [
    ["claude", "2.1.289"],
    ["codex", "0.160.0"],
  ] as const) {
    const actual = yield* command([scope.binaries[host], "--version"], process.cwd());
    yield* requireCheck(
      actual.includes(version),
      "Native host version differs from the verified pin"
    );
  }
});
const budgetAdmission = Effect.fn(function* (scope: ApprovedScope, observation: Observation) {
  yield* requireCheck(
    observation.failures.length === 0,
    observation.failures[0] ?? "Worker observation prevented further work"
  );
  yield* requireCheck(
    observation.ingressRequests() < scope.maximumRequests - CLEANUP_RESERVE,
    "Observed request budget prevented further work"
  );
});
const verifyCancellation = (
  before: FixtureSnapshot,
  after: FixtureSnapshot
): Effect.Effect<void, VerificationFailure> =>
  requireCheck(
    after.budgets === before.budgets &&
      after.deletedBudgets === before.deletedBudgets &&
      after.rejectedDeletions === before.rejectedDeletions + 1,
    "Cancellation changed Budget state or accepted deletion Audit"
  );
const validateRefreshRefusal = Effect.fn(function* (status: number, body: unknown) {
  const result = yield* Schema.decodeUnknownEffect(Schema.Struct({ error: Schema.String }))(
    body
  ).pipe(
    Effect.mapError(() => new VerificationFailure({ message: "Refresh refusal was invalid" }))
  );
  yield* requireCheck(
    status === BAD_REQUEST && result.error === "invalid_grant",
    "Revoked native refresh token was not refused"
  );

  return result;
});
const REFUSAL_BODY_LIMIT = 4_096;
const boundedRefusalBody = Effect.fn(function* (response: HttpClientResponse.HttpClientResponse) {
  let bytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks = yield* Stream.runCollect(
    response.stream.pipe(
      Stream.mapEffect((chunk) => {
        bytes += chunk.byteLength;
        return requireCheck(
          bytes <= REFUSAL_BODY_LIMIT,
          "Refresh refusal exceeded response bound"
        ).pipe(
          Effect.andThen(
            Effect.try({
              try: () => decoder.decode(chunk, { stream: true }),
              catch: () => new VerificationFailure({ message: "Refresh refusal encoding invalid" }),
            })
          )
        );
      })
    )
  ).pipe(
    Effect.mapError(
      () => new VerificationFailure({ message: "Cannot read bounded refresh refusal" })
    )
  );
  const end = yield* Effect.try({
    try: () => decoder.decode(),
    catch: () => new VerificationFailure({ message: "Refresh refusal encoding invalid" }),
  });
  return yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Struct({ error: Schema.String })))(
    chunks.join("") + end
  ).pipe(Effect.mapError(() => new VerificationFailure({ message: "Refresh refusal invalid" })));
});
const refusedCredentials = Effect.fn(function* (host: NativeHost, binary: string, root: string) {
  const token = yield* nativeCredential(host, binary, root);
  const now = yield* Clock.currentTimeMillis;
  yield* requireCheck(
    token.expiresAt > now,
    "Refusal probe requires an otherwise unexpired native access token"
  );
  const client = yield* HttpClient.HttpClient;
  const tool = yield* HttpClient.withScope(client)
    .execute(
      HttpClientRequest.post("https://api.fidyapp.com/mcp").pipe(
        HttpClientRequest.setHeaders({
          Authorization: `Bearer ${Redacted.value(token.accessToken)}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": host === "claude" ? "2026-07-28" : "2025-11-25",
        }),
        HttpClientRequest.bodyText(
          encodeJson({
            jsonrpc: "2.0",
            id: "revoked-fixture",
            method: "tools/call",
            params: { name: "categories.listCategories", arguments: {} },
          }),
          "application/json"
        )
      )
    )
    .pipe(
      Effect.mapError(
        () => new VerificationFailure({ message: "Post-revocation MCP probe failed" })
      )
    );
  yield* requireCheck(tool.status === UNAUTHORIZED, "Revoked native access token was not refused");
  const refresh = yield* HttpClient.withScope(client)
    .execute(
      HttpClientRequest.post("https://api.fidyapp.com/oauth/token").pipe(
        HttpClientRequest.bodyText(
          new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: Redacted.value(token.refreshToken),
            client_id: token.clientId,
          }).toString(),
          "application/x-www-form-urlencoded"
        )
      )
    )
    .pipe(
      Effect.mapError(
        () => new VerificationFailure({ message: "Post-revocation refresh probe failed" })
      )
    );
  const body = yield* boundedRefusalBody(refresh);
  const result = yield* validateRefreshRefusal(refresh.status, body);
  return { toolStatus: tool.status, refreshStatus: refresh.status, refreshError: result.error };
});

const cleanNativeProfiles = Effect.fn(function* (scope: ApprovedScope, root: string) {
  const results = [];
  for (const host of HOSTS) {
    results.push(
      yield* Effect.exit(
        Effect.gen(function* () {
          if (
            yield* attempt("Cannot inspect private native profile", () =>
              Bun.file(
                `${root}/${host}-profile/${host === "claude" ? ".claude.json" : "config.toml"}`
              ).exists()
            )
          ) {
            yield* nativeLogout(host, scope.binaries[host], root);
          }
        })
      )
    );
  }
  yield* requireCheck(results.every(Exit.isSuccess), "Native profile logout failed");
});
type ProofContext = {
  readonly scope: ApprovedScope;
  readonly root: string;
  readonly browser: Browser;
  readonly observation: Observation;
  readonly before: FixtureSnapshot;
  readonly started: number;
};
const hostJourney = Effect.fn(function* (context: ProofContext, host: NativeHost) {
  const { scope, root, browser, observation } = context;
  yield* budgetAdmission(scope, observation);
  yield* report(`${host}: native OAuth`);
  yield* Effect.all(
    [
      nativeLogin(host, scope.binaries[host], root),
      approveNativeLogin({ scope, browser, root, host }),
    ],
    { concurrency: 2 }
  );
  yield* report(`${host}: canonical journey`);
  yield* nativeTools(host, scope.binaries[host], root, "journey", scope.namespace);
  yield* validateCatalog(root, host);
  const beforeCancel = yield* snapshot(scope);
  yield* requireCheck(
    beforeCancel.budgets === 1,
    "Native journey did not create exactly one disposable Budget"
  );
  yield* report(`${host}: cancellation`);
  yield* nativeTools(host, scope.binaries[host], root, "cancel", scope.namespace);
  yield* verifyCancellation(beforeCancel, yield* snapshot(scope));
  yield* report(`${host}: confirmed cleanup`);
  yield* nativeTools(host, scope.binaries[host], root, "accept", scope.namespace);
  const afterDelete = yield* snapshot(scope);
  yield* requireCheck(
    afterDelete.budgets === 0 && afterDelete.deletedBudgets === beforeCancel.deletedBudgets + 1,
    "Native confirmed deletion did not reconcile Budget state and Audit"
  );
  yield* budgetAdmission(scope, observation);
  yield* report(`${host}: repeated reads`);
  yield* nativeTools(host, scope.binaries[host], root, "repeat", scope.namespace);
  return {
    nativeOAuth: true,
    restrictedCatalog: true,
    journey: true,
    cancellation: true,
    acceptedDeletion: true,
    repeatedReads: host === "claude" ? CLAUDE_READS : CODEX_READS,
  };
});
const naturalRefresh = Effect.fn(function* (context: ProofContext) {
  const { scope, root, observation } = context;
  const grants = yield* validateConnections(scope);
  const refreshBaseline = yield* snapshot(scope);
  const credentials = yield* Effect.all(
    HOSTS.map((host) => nativeCredential(host, scope.binaries[host], root)),
    { concurrency: 1 }
  );
  const expiry = Math.max(...credentials.map((token) => token.expiresAt)) + EXPIRY_MARGIN_MS;
  let now = yield* Clock.currentTimeMillis;
  yield* requireCheck(
    expiry - now < MAX_EXPIRY_WAIT_MS,
    "Unexpected access-token expiry; refusing an unbounded wait"
  );
  yield* report("Waiting for natural ten-minute access expiry");
  while (now < expiry) {
    yield* Effect.sleep(Math.min(WAIT_TICK_MS, expiry - now));
    yield* budgetAdmission(scope, observation);
    now = yield* Clock.currentTimeMillis;
    yield* report("Natural refresh wait in progress");
  }
  for (const host of HOSTS) {
    yield* report(`${host}: natural refresh`);
    yield* nativeTools(host, scope.binaries[host], root, "refresh", scope.namespace);
  }
  yield* requireCheck(
    (yield* snapshot(scope)).refreshEvents === refreshBaseline.refreshEvents + 2,
    "Expected one natural refresh event per native client"
  );
  yield* requireCheck(
    encodeJson(yield* connections(scope)) === encodeJson(grants),
    "Native refresh extended or changed approved connection authority"
  );
});
type HostProof = Effect.Success<ReturnType<typeof hostJourney>>;
type HostProofs = Readonly<{ claude: HostProof; codex: HostProof }>;
const finishProof = Effect.fn(function* (context: ProofContext, hosts: HostProofs) {
  const { scope, root, browser, observation, before, started } = context;
  yield* report("First-party revocation and refusal checks");
  yield* revokeConnections(scope, browser);
  const refusal = {
    claude: yield* refusedCredentials("claude", scope.binaries.claude, root).pipe(Effect.scoped),
    codex: yield* refusedCredentials("codex", scope.binaries.codex, root).pipe(Effect.scoped),
  };
  yield* Effect.sleep("3 seconds");
  yield* checkObservation(scope, observation);
  const after = yield* snapshot(scope);
  yield* requireCheck(
    after.activeConnections === 0 && after.activeBrowsers === 0 && after.budgets === 0,
    "Synthetic cleanup is incomplete"
  );
  yield* requireCheck(
    after.transactions === before.transactions + 4 &&
      after.createdTransactions === before.createdTransactions + 4 &&
      after.createdBudgets === before.createdBudgets + 2 &&
      after.deletedBudgets === before.deletedBudgets + 2,
    "Canonical journey effects or accepted Audit differ from the expected synthetic workload"
  );
  const ended = yield* Clock.currentTimeMillis;
  yield* requireCheck(
    ended - started <= scope.windowMinutes * MINUTE_MS,
    "Production proving window exceeded"
  );
  yield* verifyProvenance(scope);
  return {
    verifiedAt: DateTime.formatIso(yield* DateTime.now),
    revision: scope.revision,
    versions: { core: scope.coreVersion, ingress: scope.ingressVersion },
    hosts,
    naturalRefresh: true,
    postRevocation: refusal,
    platform: {
      observedIngressRequests: observation.ingressRequests(),
      coreMcp: observation.rows.filter((row) => row.surface === "core" && row.route === "/mcp"),
      oauthMcpCpuLimitTerminations: 0,
      scheduledCpuLimitTerminations: observation.rows.filter(
        (row) => row.eventKind === "scheduled" && row.outcome === "exceededCpu"
      ).length,
    },
    cleanup: {
      activeConnections: after.activeConnections,
      activeBrowsers: after.activeBrowsers,
      budgets: after.budgets,
      syntheticTransactionsAdded: 4,
    },
    limitations: [
      "Synthetic pairing approval does not verify identity or email delivery.",
      "Natural absolute seven-day expiry is covered locally, not waited for here.",
      "Canned loopback model; no paid inference; only named native versions and canonical operations.",
      "Worker tails observe the request budget conservatively; they are not a server-side rate limiter.",
    ],
  };
});
const cleanupProof = Effect.fn(function* (context: ProofContext) {
  const { scope, root, browser } = context;
  const results = [];
  for (const host of HOSTS) {
    results.push(yield* Effect.exit(disposeBudget(context, host)));
  }
  results.push(
    yield* Effect.exit(
      Effect.gen(function* () {
        if ((yield* snapshot(scope)).activeConnections > 0) {
          yield* revokeConnections(scope, browser);
        }
      })
    )
  );
  results.push(yield* Effect.exit(cleanNativeProfiles(scope, root)));
  results.push(
    yield* Effect.exit(
      Effect.gen(function* () {
        const final = yield* snapshot(scope);
        yield* requireCheck(
          final.activeConnections === 0 && final.activeBrowsers === 0 && final.budgets === 0,
          "Synthetic cleanup inventory was not empty"
        );
      })
    )
  );
  yield* requireCheck(
    results.every(Exit.isSuccess),
    "Synthetic cleanup failed; review fixture state before rerunning"
  );
});
const reportFailedObservation = (observation: Observation): Effect.Effect<void> =>
  Effect.sync(() => {
    process.stderr.write(
      encodeJson({
        phase: "failed platform observations",
        observations: observation.rows.filter((row) => row.route !== "other"),
        failures: observation.failures,
      }) + "\n"
    );
  });
const runProof = Effect.fn(function* (scope: ApprovedScope) {
  yield* verifyProvenance(scope);
  yield* validatePinnedHosts(scope);
  const before = yield* snapshot(scope);
  yield* requireCheck(
    before.users === 1 &&
      before.synthetic === 1 &&
      before.activeConnections === 0 &&
      before.activeBrowsers === 0 &&
      before.budgets === 0,
    "Synthetic fixture inventory is not isolated and clean"
  );
  const started = yield* Clock.currentTimeMillis;
  const root = yield* privateDirectory;
  const browser = yield* productionBrowser;
  const observation = yield* startObservation(scope);
  const context = { scope, root, browser, observation, before, started };
  const work = Effect.gen(function* () {
    const hosts: HostProofs = {
      claude: yield* hostJourney(context, "claude"),
      codex: yield* hostJourney(context, "codex"),
    };
    yield* naturalRefresh(context);
    return yield* finishProof(context, hosts);
  });
  return yield* work.pipe(
    Effect.tapCause(() => reportFailedObservation(observation)),
    Effect.ensuring(cleanupProof(context).pipe(Effect.orDie))
  );
});
const main = Effect.gen(function* () {
  const { values } = parseArgs({
    options: {
      scope: { type: "string" },
      output: { type: "string", default: "mcp-production-evidence.json" },
      "validate-only": { type: "boolean", default: false },
    },
  });
  yield* requireCheck(
    values.scope !== undefined,
    "Provide --scope with an approved synthetic verification scope"
  );
  const scope = yield* readScope(values.scope ?? "");
  if (values["validate-only"]) {
    return;
  }
  yield* writeJson(values.output, { passed: false, phase: "running", revision: scope.revision });
  const evidence = yield* runProof(scope).pipe(
    Effect.timeout("30 minutes"),
    Effect.scoped,
    Effect.tapCause(() =>
      writeJson(values.output, { passed: false, phase: "failed", revision: scope.revision })
    )
  );
  yield* writeJson(values.output, {
    ...evidence,
    passed: true,
    nativeLogoutsPassed: true,
    privateProfilesRemoved: true,
  });
  yield* report("Production MCP checks passed");
});
const result = await Effect.runPromiseExit(
  main.pipe(
    Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    Effect.provide(Layer.mergeAll(BunCrypto.layer, BunFileSystem.layer, FetchHttpClient.layer))
  )
);
if (Exit.isFailure(result)) {
  const error = Cause.findError(result.cause);
  const message = Result.match(error, {
    onFailure: () =>
      "Verification interrupted or failed during cleanup; inspect synthetic fixture before rerunning",
    onSuccess: (error) =>
      error._tag === "NativeProofError"
        ? `Native ${error.host} verification failed during ${error.phase}: ${error.reason}${Option.match(error.diagnostics, { onNone: () => "", onSome: (details) => " " + encodeJson(details) })}`
        : error.message,
  });
  process.stderr.write(message + "\n");
  process.exitCode = 1;
}
