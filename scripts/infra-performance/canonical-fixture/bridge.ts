import { createInterface } from "node:readline/promises";
import { Clock, Config, Data, Effect, Redacted, Schema, Stream } from "effect";
import type { Miniflare } from "miniflare";
import { installedOrigins } from "../../../apps/server/src/shell/browser-transport/contract";
import {
  openTransactionReceipt,
  signAcceptanceRequest,
} from "../../../apps/server/cloudflare/release-isolation/operations";
import {
  SealedTransactionReceipt,
  acceptanceLifetimeMs,
  acceptanceProofHeader,
  performanceReceiptPath,
} from "../../../apps/server/cloudflare/release-isolation/contract";
import { TransactionListResponse } from "../../../apps/server/src/shell/transactions/contract";
import { openPerformanceBrowser } from "../../../infra/cloudflare/native-acceptance";

const api = installedOrigins.acceptance;
const minimumSecret = 32;
const caseIntervalMs = 1000;
const session = Schema.Struct({ cookie: Schema.String, binding: Schema.String });
const mountedManifest = Schema.Struct({
  history: Schema.toEncoded(Schema.toCodecJson(TransactionListResponse)),
  workspace: Schema.Struct({ profile: Schema.Json, review: Schema.Json }),
});
const command = Schema.Struct({
  path: Schema.String,
  method: Schema.Literals(["POST", "GET"]),
  body: Schema.Json,
  control: Schema.String,
});
type Command = typeof command.Type;
type Session = typeof session.Type;
class FixtureTransportError extends Data.TaggedError("FixtureTransportError") {}
type Transport = (request: Request) => Effect.Effect<Response, FixtureTransportError>;
const io = <A>(run: () => Promise<A>): Effect.Effect<A, FixtureTransportError> =>
  Effect.tryPromise({ try: run, catch: () => new FixtureTransportError() });
type Auth = { revision: string; secret: string };
const offer = (value: unknown): void => {
  process.stdout.write("FIDY_PRIVATE_RESPONSE " + JSON.stringify(value) + "\n");
};
const sessionHeaders = (value: Session): Record<string, string> => ({
  cookie: value.cookie,
  "fidy-session-binding": value.binding,
});
export const transport = (runtime: Miniflare): Transport =>
  Effect.fnUntraced(function* (request: Request) {
    const body = request.body === null ? undefined : yield* io(() => request.arrayBuffer());
    const reply = yield* io(() =>
      runtime.dispatchFetch(request.url, {
        method: request.method,
        headers: { ...Object.fromEntries(request.headers), "cf-connecting-ip": "192.0.2.1" },
        redirect: "manual",
        ...(body === undefined ? {} : { body }),
      })
    );
    const bytes = yield* io(() => reply.arrayBuffer());
    return new Response(bytes.byteLength > 0 ? bytes : null, {
      status: reply.status,
      headers: Object.fromEntries(reply.headers),
    });
  });
const environmentOf = (
  auth: Auth
): {
  RELEASE_GIT_SHA: string;
  SMOKE_PROOF: string;
  NATIVE_STORAGE_ADMISSION: string;
  RECOVERY_ISOLATION: string;
  BROWSER_ORIGIN: string;
} => ({
  RELEASE_GIT_SHA: auth.revision,
  SMOKE_PROOF: auth.secret,
  NATIVE_STORAGE_ADMISSION: "closed",
  RECOVERY_ISOLATION: "isolated",
  BROWSER_ORIGIN: api.browser,
});
type Client = {
  request: (input: Command, headers: Record<string, string>) => Effect.Effect<Response, Error>;
  login: (member: "performance-1" | "performance-2") => Effect.Effect<string, Error>;
  bind: (cookie: string) => Effect.Effect<Session, Error>;
};
const client = (auth: Auth, send: Transport): Client => {
  const environment = environmentOf(auth);
  const request = Effect.fnUntraced(function* (input: Command, headers: Record<string, string>) {
    const outgoing = new Request(api.api + input.path, {
      method: input.method,
      headers: { origin: api.browser, "content-type": "application/json", ...headers },
      redirect: "manual",
      ...(input.body === null
        ? {}
        : { body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(input.body) }),
    });
    if (input.control !== "unsigned") {
      outgoing.headers.set(
        acceptanceProofHeader,
        yield* signAcceptanceRequest({
          request: outgoing,
          boundary: "ingress",
          environment,
          deadline: (yield* Clock.currentTimeMillis) + acceptanceLifetimeMs,
        })
      );
    }
    return yield* send(outgoing);
  });
  const login = Effect.fnUntraced(function* (member: "performance-1" | "performance-2") {
    const token = yield* openPerformanceBrowser(
      { revision: auth.revision, proof: Redacted.make(auth.secret), send },
      member
    );
    return "__Host-fidy_session=" + Redacted.value(token);
  });
  const bind = Effect.fnUntraced(function* (cookie: string) {
    const reply = yield* request(
      { path: "/web/session/binding", method: "GET", body: null, control: "" },
      { cookie }
    );
    if (!reply.ok) return yield* new FixtureTransportError();
    const data = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ binding: Schema.NonEmptyString })
    )(yield* io(() => reply.json()));
    return { cookie, binding: data.binding };
  });
  return { request, login, bind };
};

const start = Effect.fnUntraced(function* (service: Client) {
  const retained = yield* Config.String("FIDY_BOUND_SESSION_FILE").pipe(Config.withDefault(""));
  if (retained === "") return yield* service.bind(yield* service.login("performance-1"));
  const previous = yield* Schema.decodeUnknownEffect(session)(
    yield* io(() => Bun.file(retained).json())
  );
  const active = yield* service.bind(previous.cookie);
  if (active.binding !== previous.binding) return yield* new FixtureTransportError();
  return active;
});
const allowed = (item: Command): boolean =>
  item.method === "GET"
    ? [
        "/user",
        "/ingestion/review-workspace?limit=0&status=pending",
        "/transactions?limit=25",
      ].includes(item.path) || /^\/transactions\/[a-f0-9-]{36}$/u.test(item.path)
    : ["/operations/atomic-batch", "/transactions/link", performanceReceiptPath].includes(
        item.path
      );
const execute = Effect.fnUntraced(function* (item: Command, active: Session, service: Client) {
  if (!allowed(item)) return yield* new FixtureTransportError();
  const mounted =
    item.control === "foreign-session"
      ? yield* service.bind(yield* service.login("performance-2"))
      : active;
  const headers = sessionHeaders(mounted);
  if (item.control === "wrong-binding") {
    headers["fidy-session-binding"] = "00000000-0000-4000-8000-000000000000";
  }
  const reply = yield* service.request(item, headers);
  const raw = yield* io(() => reply.text());
  const data = reply.ok
    ? yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(raw)
    : null;
  offer({ status: reply.status, data });
});
const authority = Effect.gen(function* () {
  const secret = Redacted.value(yield* Config.Redacted("SMOKE_PROOF"));
  const revision = yield* Config.String("FIDY_NATIVE_REVISION");
  if (secret.length < minimumSecret || !/^[a-f0-9]{40}$/u.test(revision)) {
    return yield* new FixtureTransportError();
  }
  return { secret, revision };
});
const nativeMeters = async (runtime: Miniflare): Promise<unknown> => {
  const core = await runtime.getWorker("core");
  const sql: unknown = await (await core.fetch("https://offline.invalid/native-row-counts")).json();
  const r2 = Object.fromEntries(
    await Promise.all(
      ["core", "ingress", "closed-provider"].map(async (name) => {
        const worker = await runtime.getWorker(name);
        const counters: unknown = await (
          await worker.fetch("https://offline.invalid/r2-counts")
        ).json();
        return [name, counters] as const;
      })
    )
  );
  return { sql, r2 };
};
const signedForward = async (
  runtime: Miniflare
): Promise<(request: Request) => Promise<Response>> => {
  const environment = environmentOf(await Effect.runPromise(authority));
  const forward = async (request: Request): Promise<Response> => {
    request.headers.set(
      acceptanceProofHeader,
      await Effect.runPromise(
        signAcceptanceRequest({
          request,
          boundary: "ingress",
          environment,
          deadline: Date.now() + acceptanceLifetimeMs,
        })
      )
    );
    return Effect.runPromise(transport(runtime)(request));
  };
  return forward;
};
const runMountedWorkspace = (
  runtime: Miniflare,
  active: Session
): Effect.Effect<void, FixtureTransportError> =>
  io(async () => {
    const { runBrowser } = await import("../hosted-browser/captured-profile.mjs");
    const manifest: unknown = await Bun.file(
      process.env.FIDY_DIAGNOSTIC_DIR + "/native/fixture/manifest.json"
    ).json();
    if (!Schema.is(mountedManifest)(manifest)) throw new FixtureTransportError();
    const forward = await signedForward(runtime);
    const before = await nativeMeters(runtime);
    await runBrowser({
      variant: "do",
      origins: api,
      cookie: active.cookie,
      expected: manifest.history,
      workspace: manifest.workspace,
      forward,
    });
    const afterReads = await nativeMeters(runtime);
    const { proveScopedCorrection } = await import("../hosted-browser/scoped-correction.mjs");
    const mutation = await proveScopedCorrection(
      manifest.history,
      async (method: string, path: string, body?: unknown) => {
        await Bun.sleep(caseIntervalMs);
        return forward(
          new Request(api.api + path, {
            method,
            headers: {
              origin: api.browser,
              ...sessionHeaders(active),
              "content-type": "application/json",
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          })
        );
      }
    );
    await Bun.write(
      process.env.FIDY_DIAGNOSTIC_DIR + "/ordinary-native-mutation.json",
      JSON.stringify(mutation)
    );
    await Bun.write(
      process.env.FIDY_DIAGNOSTIC_DIR + "/ordinary-native-accounting.json",
      JSON.stringify({ before, afterReads, afterMutations: await nativeMeters(runtime) })
    );
    offer({ status: 200 });
  });
export const serveFixture = Effect.fn(function* (runtime: Miniflare) {
  const service = client(yield* authority, transport(runtime));
  const active = yield* start(service);
  offer(active);
  const lines = createInterface({ input: process.stdin, terminal: false });
  yield* Stream.fromAsyncIterable(lines, () => new FixtureTransportError()).pipe(
    Stream.runForEach((line) =>
      Schema.decodeEffect(Schema.fromJsonString(command))(line).pipe(
        Effect.flatMap((item) => {
          if (item.control !== "mounted-workspace") return execute(item, active, service);
          return runMountedWorkspace(runtime, active);
        })
      )
    ),
    Effect.ensuring(Effect.sync(() => lines.close()))
  );
});
const verify = Effect.gen(function* () {
  const auth = yield* authority;
  const key = yield* Config.String("FIDY_NATIVE_FIXTURE_PUBLIC_KEY");
  const value = yield* Schema.decodeUnknownEffect(SealedTransactionReceipt)(
    yield* io(() => Bun.stdin.json())
  );
  process.stdout.write(
    yield* openTransactionReceipt({ secret: auth.secret, publicKey: key, value })
  );
});
if (import.meta.main) {
  if (process.argv[2] === "verify") {
    await Effect.runPromise(verify).catch(() => {
      process.stderr.write("Closed native fixture transport stopped\n");
      process.exitCode = 1;
    });
  } else {
    process.stderr.write("Native fixture bridge admits offline verification only\n");
    process.exitCode = 1;
  }
}
