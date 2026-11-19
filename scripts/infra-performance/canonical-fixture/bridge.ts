import { createInterface } from "node:readline/promises";
import { Effect, Redacted, Schema } from "effect";
import { installedOrigins } from "../../../apps/server/src/shell/browser-transport/contract";
import { signAcceptanceRequest } from "../../../apps/server/cloudflare/release-isolation/operations";
import {
  acceptanceLifetimeMs,
  acceptanceProofHeader,
} from "../../../apps/server/cloudflare/release-isolation/contract";
import {
  openTransactionReceipt,
  SealedTransactionReceipt,
  performanceReceiptPath,
} from "../../../apps/server/cloudflare/release-isolation/performance-receipt";
import { openPerformanceBrowser } from "../../../infra/cloudflare/native-acceptance";
import { closedRuntime } from "./closed-runtime";

const driver = async (): Promise<void> => {
  const secret = process.env.SMOKE_PROOF ?? "";
  const revision = process.env.FIDY_NATIVE_REVISION ?? "";
  if (secret.length < 32 || !/^[a-f0-9]{40}$/u.test(revision))
    throw new Error("Missing receipt authority");
  if (process.argv[2] === "verify") {
    const envelope = Schema.decodeUnknownSync(SealedTransactionReceipt)(await Bun.stdin.json());
    process.stdout.write(
      await openTransactionReceipt(
        secret,
        process.env.FIDY_NATIVE_FIXTURE_PUBLIC_KEY ?? "",
        envelope
      )
    );
    return;
  }
  const local = process.argv[2] === "rehearse";
  if (!local && process.argv[2] !== "hosted") throw new Error("Unknown mode");
  const runtime = local ? await closedRuntime(revision, secret) : undefined;
  const environment = {
    RELEASE_GIT_SHA: revision,
    SMOKE_PROOF: secret,
    NATIVE_STORAGE_ADMISSION: "closed",
    RECOVERY_ISOLATION: "isolated",
    BROWSER_ORIGIN: installedOrigins.acceptance.browser,
  };
  const transmit = async (request: Request): Promise<Response> => {
    if (!runtime) return fetch(request, { redirect: "manual", signal: AbortSignal.timeout(30000) });
    const result = await runtime.dispatchFetch(request.url, {
      method: request.method,
      headers: Object.fromEntries(request.headers),
      redirect: "manual",
      ...(request.body ? { body: await request.arrayBuffer() } : {}),
    });
    const raw = await result.arrayBuffer();
    return new Response(raw.byteLength ? raw : null, {
      status: result.status,
      headers: Object.fromEntries(result.headers),
    });
  };
  const send = (request: Request): Effect.Effect<Response, Error> =>
    Effect.tryPromise({
      try: () => transmit(request),
      catch: () => Error("Closed transport unavailable"),
    });
  const login = async (member: "performance-1" | "performance-2"): Promise<string> =>
    Redacted.value(
      await Effect.runPromise(
        openPerformanceBrowser({ revision, proof: Redacted.make(secret), send }, member)
      )
    );
  const retained = process.env.FIDY_BOUND_SESSION_FILE;
  const previous = retained
    ? Schema.decodeUnknownSync(Schema.Struct({ cookie: Schema.String, binding: Schema.String }))(
        await Bun.file(retained).json()
      )
    : undefined;
  const cookie = previous?.cookie ?? "__Host-fidy_session=" + (await login("performance-1"));
  const request = async (
    path: string,
    method: string,
    body: unknown,
    headers: Record<string, string>,
    signed = true
  ): Promise<Response> => {
    const req = new Request(installedOrigins.acceptance.api + path, {
      method,
      headers: {
        origin: installedOrigins.acceptance.browser,
        "content-type": "application/json",
        ...headers,
      },
      redirect: "manual",
      ...(body === null ? {} : { body: JSON.stringify(body) }),
    });
    if (signed)
      req.headers.set(
        acceptanceProofHeader,
        await Effect.runPromise(
          signAcceptanceRequest({
            request: req,
            boundary: "ingress",
            environment,
            deadline: Date.now() + acceptanceLifetimeMs,
          })
        )
      );
    return transmit(req);
  };
  try {
    const bindingOf = async (token: string): Promise<string> => {
      const reply = await request("/web/session/binding", "GET", null, { cookie: token });
      if (!reply.ok) throw Error("Session binding unavailable");
      return Schema.decodeUnknownSync(Schema.Struct({ binding: Schema.String }))(await reply.json())
        .binding;
    };
    const binding = await bindingOf(cookie);
    if (previous && previous.binding !== binding) throw Error("Previous mounted Session changed");
    process.stdout.write(JSON.stringify({ cookie, binding }) + "\n");
    const lines = createInterface({ input: process.stdin, terminal: false });
    for await (const line of lines) {
      const q = Schema.decodeUnknownSync(
        Schema.Struct({
          path: Schema.String,
          method: Schema.Literals(["POST", "GET"]),
          body: Schema.Json,
          control: Schema.String,
        })
      )(JSON.parse(line));
      if (
        ![
          "/transactions?limit=25",
          "/operations/atomic-batch",
          "/transactions/link",
          performanceReceiptPath,
        ].includes(q.path) &&
        !/^\/transactions\/[a-f0-9-]{36}$/u.test(q.path)
      )
        throw Error("Outside fixture transport");
      let headers = { cookie, "fidy-session-binding": binding };
      if (local && q.control === "foreign-session") {
        const foreign = "__Host-fidy_session=" + (await login("performance-2"));
        headers = { cookie: foreign, "fidy-session-binding": await bindingOf(foreign) };
      }
      if (local && q.control === "wrong-binding")
        headers["fidy-session-binding"] = "00000000-0000-4000-8000-000000000000";
      const reply = await request(q.path, q.method, q.body, headers, q.control !== "unsigned");
      const raw = await reply.text();
      process.stdout.write(
        JSON.stringify({ status: reply.status, data: reply.ok ? JSON.parse(raw) : null }) + "\n"
      );
    }
  } finally {
    if (runtime) await runtime.dispose();
  }
};
await driver().catch(() => {
  process.stderr.write("Closed native fixture transport stopped\n");
  process.exitCode = 1;
});
