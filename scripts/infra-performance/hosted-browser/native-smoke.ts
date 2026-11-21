import assert from "node:assert/strict";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Clock, Config, Data, Effect, Path, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { installedOrigins } from "../../../apps/server/src/shell/browser-transport/contract";
import {
  acceptanceLifetimeMs,
  acceptanceProofHeader,
} from "../../../apps/server/cloudflare/release-isolation/contract";
import { signAcceptanceRequest } from "../../../apps/server/cloudflare/release-isolation/operations";
import { runBrowser } from "./captured-profile.mjs";
import { parseDeployment, parseNativeSmoke } from "./contracts";
import { proveScopedCorrection } from "./scoped-correction.mjs";

type Smoke = ReturnType<typeof parseNativeSmoke>;

type Send = (request: string | Request, init: RequestInit) => Promise<Response>;

const origins = installedOrigins.acceptance;

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const requestTimeoutMs = 30_000;

const success = 200;

const mutationIntervalMs = 750;

const allowedAsset = /^\/assets\/[a-zA-Z0-9_./-]+$/u;

class NativeSmokeFailure extends Data.TaggedError("NativeSmokeFailure") {}

const fromBrowser = <A>(launch: () => Promise<A>): Effect.Effect<A, NativeSmokeFailure> =>
  Effect.tryPromise({ try: launch, catch: () => new NativeSmokeFailure() });

const scopeOpen = Effect.fnUntraced(function* (deadline: number) {
  assert.ok((yield* Clock.currentTimeMillis) < deadline, "Native smoke lease expired");
});

const exposedResponse = (reply: Response): Response => {
  const headers = new Headers(reply.headers);

  for (const name of ["content-encoding", "content-length", acceptanceProofHeader]) {
    headers.delete(name);
  }

  return new Response(reply.body, { status: reply.status, headers });
};

const signedRequest = Effect.fnUntraced(function* (
  config: Smoke,
  incoming: Request,
  proof: string
) {
  const request = new Request(incoming);
  request.headers.set(
    acceptanceProofHeader,
    yield* signAcceptanceRequest({
      request,
      boundary: "ingress",
      environment: {
        BROWSER_ORIGIN: origins.browser,
        RELEASE_GIT_SHA: config.native.revision,
        SMOKE_PROOF: proof,
        RECOVERY_ISOLATION: "isolated",
        NATIVE_STORAGE_ADMISSION: "closed",
      },
      deadline: Math.min(config.deadline, (yield* Clock.currentTimeMillis) + acceptanceLifetimeMs),
    })
  );

  return request;
});

type Transport = {
  forward: (
    incoming: Request
  ) => Effect.Effect<Response, Effect.Error<ReturnType<typeof signedRequest>> | NativeSmokeFailure>;
  verifyReservation: () => void;
};

const nativeTransport = (config: Smoke, send: Send, proof: string): Transport => {
  const remaining = new Map(Object.entries(config.allowed));
  let preflights = 0;

  const forward = Effect.fnUntraced(function* (incoming: Request) {
    yield* scopeOpen(config.deadline);
    const url = new URL(incoming.url);
    assert.equal(url.origin, origins.api);
    assert.equal(incoming.headers.get("origin"), origins.browser);
    const preflight = incoming.method === "OPTIONS";

    const method = preflight
      ? incoming.headers.get("access-control-request-method")
      : incoming.method;

    const route = method + " " + url.pathname + url.search;
    const available = remaining.get(route) ?? 0;
    assert.ok(available > 0, "Unreserved native smoke request");

    if (preflight) {
      assert.equal(method, "GET");
      assert.ok(++preflights <= config.maximumPreflights, "Native preflight reservation exhausted");
    } else {
      assert.equal(incoming.headers.get("cookie"), config.native.session.cookie);

      if (url.pathname !== "/web/session/binding") {
        assert.equal(incoming.headers.get("fidy-session-binding"), config.native.session.binding);
      }

      remaining.set(route, available - 1);
    }

    const request = yield* signedRequest(config, incoming, proof);
    yield* scopeOpen(config.deadline);

    return exposedResponse(yield* requestDeployed(send, request));
  });

  return {
    forward,
    verifyReservation: (): void => assert.ok([...remaining.values()].every((count) => count === 0)),
  };
};

const requestDeployed = (
  send: Send,
  request: string | Request
): Effect.Effect<Response, NativeSmokeFailure> =>
  fromBrowser(() =>
    send(request, {
      redirect: "error",
      signal: AbortSignal.timeout(requestTimeoutMs),
    })
  );

const deployedWeb = Effect.fnUntraced(function* (config: Smoke, request: Request, send: Send) {
  yield* scopeOpen(config.deadline);
  const url = new URL(request.url);
  assert.equal(url.origin, origins.browser);

  if (
    url.pathname !== "/app/transactions" &&
    url.pathname !== "/favicon.ico" &&
    !allowedAsset.test(url.pathname)
  ) {
    return new Response(null, { status: 404 });
  }

  return exposedResponse(yield* requestDeployed(send, request.url));
});

export const runNativeSmoke = Effect.fnUntraced(function* (config: Smoke) {
  const send = yield* FetchHttpClient.Fetch;
  const proof = yield* Config.String("SMOKE_PROOF");
  assert.equal(config.native.web.api, origins.api);
  assert.equal(config.native.web.browser, origins.browser);
  assert.match(config.native.revision, /^[a-f0-9]{40}$/u);
  yield* scopeOpen(config.deadline);
  const metadata = yield* requestDeployed(send, origins.browser + "/deployment-metadata.json");
  assert.equal(metadata.status, success);
  const deployed = parseDeployment(yield* fromBrowser<unknown>(() => metadata.json()));
  assert.equal(deployed.gitRevision, config.native.web.revision);
  assert.equal(deployed.contractDigest, config.native.web.contractDigest);
  const transport = nativeTransport(config, send, proof);
  const run = Effect.runPromiseWith(yield* Effect.context<never>());
  yield* fromBrowser(() =>
    runBrowser({
      origins,
      cookie: config.native.session.cookie,
      expected: config.expected.history,
      workspace: config.expected.workspace,
      observations: 1,
      forward: (request) => run(transport.forward(request)),
      forwardWeb: (request) => run(deployedWeb(config, request, send)),
    })
  );

  const correct = Effect.fnUntraced(function* (method: string, path: string, body: unknown) {
    yield* Effect.sleep(mutationIntervalMs);

    const init: RequestInit = {
      method,
      headers: {
        cookie: config.native.session.cookie,
        origin: origins.browser,
        "fidy-session-binding": config.native.session.binding,
        "content-type": "application/json",
      },
    };

    if (body !== undefined) init.body = yield* encodeJson(body);

    return yield* transport.forward(new Request(origins.api + path, init));
  });

  const mutation = yield* fromBrowser(() =>
    proveScopedCorrection(config.expected.history, (method, path, body) =>
      run(correct(method, path, body))
    )
  );

  transport.verifyReservation();

  return { freshVisibleTransactions: true, nativeWebRevision: deployed.gitRevision, mutation };
});

if (import.meta.main) {
  const run = Effect.gen(function* () {
    const directory = yield* Config.String("FIDY_DIAGNOSTIC_DIR");
    const path = yield* Path.Path;
    const input: unknown = yield* fromBrowser(() => Bun.stdin.json());
    const config = parseNativeSmoke(input);
    const result = yield* runNativeSmoke(config);
    const evidence = yield* encodeJson(result);
    yield* fromBrowser(() => Bun.write(path.join(directory, "smoke.json"), evidence));
  });

  BunRuntime.runMain(
    run.pipe(
      Effect.catchCause(() =>
        Effect.sync(() => {
          process.stderr.write("Protected native Transactions correctness smoke failed\n");
          process.exitCode = 1;
        })
      ),
      Effect.provide(BunServices.layer)
    )
  );
}
