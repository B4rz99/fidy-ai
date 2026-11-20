import assert from "node:assert/strict";
import { join } from "node:path";
import { Effect } from "effect";
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
const origins = installedOrigins.acceptance;
const requestTimeoutMs = 30_000;
const success = 200;
const mutationIntervalMs = 750;
const allowedAsset = /^\/assets\/[a-zA-Z0-9_./-]+$/u;

const scopeOpen = (deadline: number): void => {
  assert.ok(Date.now() < deadline, "Native smoke lease expired");
};

const exposedResponse = (reply: Response): Response => {
  const headers = new Headers(reply.headers);
  for (const name of ["content-encoding", "content-length", acceptanceProofHeader]) {
    headers.delete(name);
  }
  return new Response(reply.body, { status: reply.status, headers });
};

const signedRequest = async (config: Smoke, incoming: Request): Promise<Request> => {
  const request = new Request(incoming);
  request.headers.set(
    acceptanceProofHeader,
    await Effect.runPromise(
      signAcceptanceRequest({
        request,
        boundary: "ingress",
        environment: {
          BROWSER_ORIGIN: origins.browser,
          RELEASE_GIT_SHA: config.native.revision,
          SMOKE_PROOF: process.env.SMOKE_PROOF,
          RECOVERY_ISOLATION: "isolated",
          NATIVE_STORAGE_ADMISSION: "closed",
        },
        deadline: Math.min(config.deadline, Date.now() + acceptanceLifetimeMs),
      })
    )
  );
  return request;
};

const nativeTransport = ({
  config,
  http,
}: {
  config: Smoke;
  http: typeof fetch;
}): {
  forward: (incoming: Request) => Promise<Response>;
  verifyReservation: () => void;
} => {
  const remaining = new Map(Object.entries(config.allowed));
  let preflights = 0;
  const forward = async (incoming: Request): Promise<Response> => {
    scopeOpen(config.deadline);
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
    const request = await signedRequest(config, incoming);
    scopeOpen(config.deadline);
    return exposedResponse(
      await http(request, {
        redirect: "error",
        signal: AbortSignal.timeout(requestTimeoutMs),
      })
    );
  };
  return {
    forward,
    verifyReservation: () => assert.ok([...remaining.values()].every((count) => count === 0)),
  };
};

const deployedWeb = async ({
  config,
  request,
  http,
}: {
  config: Smoke;
  request: Request;
  http: typeof fetch;
}): Promise<Response> => {
  scopeOpen(config.deadline);
  const url = new URL(request.url);
  assert.equal(url.origin, origins.browser);
  if (
    url.pathname !== "/app/transactions" &&
    url.pathname !== "/favicon.ico" &&
    !allowedAsset.test(url.pathname)
  ) {
    return new Response(null, { status: 404 });
  }
  return exposedResponse(
    await http(request.url, {
      redirect: "error",
      signal: AbortSignal.timeout(requestTimeoutMs),
    })
  );
};

export const runNativeSmoke = async ({
  config,
  http,
}: {
  config: Smoke;
  http: typeof fetch;
}): Promise<
  Readonly<{
    freshVisibleTransactions: true;
    nativeWebRevision: string;
    mutation: Awaited<ReturnType<typeof proveScopedCorrection>>;
  }>
> => {
  assert.equal(config.native.web.api, origins.api);
  assert.equal(config.native.web.browser, origins.browser);
  assert.match(config.native.revision, /^[a-f0-9]{40}$/u);
  scopeOpen(config.deadline);
  const metadata = await http(origins.browser + "/deployment-metadata.json", {
    redirect: "error",
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  assert.equal(metadata.status, success);
  const deployed = parseDeployment(await metadata.json());
  assert.equal(deployed.gitRevision, config.native.web.revision);
  assert.equal(deployed.contractDigest, config.native.web.contractDigest);
  const transport = nativeTransport({ config, http });
  await runBrowser({
    variant: "do",
    origins,
    cookie: config.native.session.cookie,
    expected: config.expected.history,
    workspace: config.expected.workspace,
    observations: 1,
    forward: transport.forward,
    forwardWeb: (request) => deployedWeb({ config, request, http }),
  });
  const mutation = await proveScopedCorrection(
    config.expected.history,
    async (method, path, body) => {
      await Bun.sleep(mutationIntervalMs);
      return transport.forward(
        new Request(origins.api + path, {
          method,
          headers: {
            cookie: config.native.session.cookie,
            origin: origins.browser,
            "fidy-session-binding": config.native.session.binding,
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
      );
    }
  );
  transport.verifyReservation();
  return { freshVisibleTransactions: true, nativeWebRevision: deployed.gitRevision, mutation };
};

if (import.meta.main) {
  try {
    const result = await runNativeSmoke({
      config: parseNativeSmoke(await Bun.stdin.json()),
      http: fetch,
    });
    await Bun.write(
      join(process.env.FIDY_DIAGNOSTIC_DIR ?? "", "smoke.json"),
      JSON.stringify(result)
    );
  } catch {
    process.stderr.write("Protected native Transactions correctness smoke failed\n");
    process.exitCode = 1;
  }
}
