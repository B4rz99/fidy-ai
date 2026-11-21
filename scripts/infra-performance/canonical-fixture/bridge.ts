import { createInterface } from "node:readline/promises";
import { BunRuntime } from "@effect/platform-bun";
import { Clock, Config, Data, Effect, Redacted, Schema, Stream } from "effect";
import type { Miniflare } from "miniflare";
import { installedOrigins } from "../../../apps/server/src/shell/browser-transport/contract";
import {
  openTransactionReceipt,
  signAcceptanceRequest,
} from "../../../apps/server/cloudflare/release-isolation/operations";
import {
  type PerformanceMember,
  SealedTransactionReceipt,
  acceptanceLifetimeMs,
  acceptanceProofHeader,
  performanceReceiptPaths,
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

type FixtureEnvironment = Readonly<{
  RELEASE_GIT_SHA: string;
  SMOKE_PROOF: string;
  NATIVE_STORAGE_ADMISSION: string;
  RECOVERY_ISOLATION: string;
  BROWSER_ORIGIN: string;
}>;

type SessionHeaders = { cookie: string; "fidy-session-binding": string };

const sessionHeaders = (value: Session): SessionHeaders => ({
  cookie: value.cookie,
  "fidy-session-binding": value.binding,
});

export const transport = (runtime: Miniflare): Transport =>
  Effect.fnUntraced(function* (request: Request) {
    const body = request.body === null ? undefined : yield* io(() => request.arrayBuffer());

    const headers = { ...Object.fromEntries(request.headers), "cf-connecting-ip": "192.0.2.1" };

    const reply = yield* io(() =>
      body === undefined
        ? runtime.dispatchFetch(request.url, {
            method: request.method,
            headers,
            redirect: "manual",
          })
        : runtime.dispatchFetch(request.url, {
            method: request.method,
            headers,
            redirect: "manual",
            body,
          })
    );

    const bytes = yield* io(() => reply.arrayBuffer());

    return new Response(bytes.byteLength > 0 ? bytes : null, {
      status: reply.status,
      headers: Object.fromEntries(reply.headers),
    });
  });

const environmentOf = (auth: Auth): FixtureEnvironment => ({
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
    const init: RequestInit = {
      method: input.method,
      headers: { origin: api.browser, "content-type": "application/json", ...headers },
      redirect: "manual",
    };

    if (input.body !== null) {
      init.body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(input.body);
    }

    const outgoing = new Request(api.api + input.path, init);

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

const start = Effect.fnUntraced(function* (service: Client, member: PerformanceMember) {
  const retained = yield* Config.String("FIDY_BOUND_SESSION_FILE").pipe(Config.withDefault(""));

  if (retained === "") return yield* service.bind(yield* service.login(member));

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
    : [
        "/operations/atomic-batch",
        "/transactions/link",
        ...Object.values(performanceReceiptPaths),
      ].includes(item.path);

const execute = Effect.fnUntraced(function* (
  item: Command,
  service: Client,
  { active, member }: { active: Session; member: PerformanceMember }
) {
  if (!allowed(item)) return yield* new FixtureTransportError();

  const mounted =
    item.control === "foreign-session"
      ? yield* service.bind(
          yield* service.login(member === "performance-1" ? "performance-2" : "performance-1")
        )
      : active;

  const headers = sessionHeaders(mounted);

  if (item.control === "wrong-binding") {
    headers["fidy-session-binding"] = "00000000-0000-4000-8000-000000000000";
  }

  const reply = yield* service.request(item, headers);

  const data = reply.ok
    ? yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(yield* io(() => reply.text()))
    : yield* io(() => reply.body?.cancel() ?? Promise.resolve()).pipe(Effect.as(null));

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

const nativeMeters = Effect.fnUntraced(function* (runtime: Miniflare) {
  const read = Effect.fnUntraced(function* (name: string, path: string) {
    const worker = yield* io(() => runtime.getWorker(name));
    const response = yield* io(() => worker.fetch("https://offline.invalid/" + path));

    if (!response.ok) return yield* new FixtureTransportError();

    const counters: unknown = yield* io(() => response.json());

    return counters;
  });

  const sql = yield* read("core", "native-row-counts");

  const counters = yield* Effect.forEach(
    ["core", "ingress", "closed-provider"],
    (name) => read(name, "r2-counts").pipe(Effect.map((value) => [name, value] as const)),
    { concurrency: 3 }
  );

  return { sql, r2: Object.fromEntries(counters) };
});

const signedForward = Effect.fnUntraced(function* (runtime: Miniflare) {
  const environment = environmentOf(yield* authority);
  const send = transport(runtime);

  return Effect.fnUntraced(function* (request: Request) {
    request.headers.set(
      acceptanceProofHeader,
      yield* signAcceptanceRequest({
        request,
        boundary: "ingress",
        environment,
        deadline: (yield* Clock.currentTimeMillis) + acceptanceLifetimeMs,
      })
    );

    return yield* send(request);
  });
});

const runMountedWorkspace = Effect.fnUntraced(function* (runtime: Miniflare, active: Session) {
  const { runBrowser } = yield* io(() => import("../hosted-browser/captured-profile.mjs"));
  const directory = yield* Config.String("FIDY_DIAGNOSTIC_DIR");

  const manifest: unknown = yield* io(() =>
    Bun.file(directory + "/native/fixture/manifest.json").json()
  );

  if (!Schema.is(mountedManifest)(manifest)) return yield* new FixtureTransportError();
  const run = Effect.runPromiseWith(yield* Effect.context());
  const forward = yield* signedForward(runtime);
  const before = yield* nativeMeters(runtime);
  yield* io(() =>
    runBrowser({
      origins: api,
      cookie: active.cookie,
      expected: manifest.history,
      workspace: manifest.workspace,
      forward: (request) => run(forward(request)),
    })
  );
  const afterReads = yield* nativeMeters(runtime);

  const { proveScopedCorrection } = yield* io(
    () => import("../hosted-browser/scoped-correction.mjs")
  );

  const mutate = Effect.fnUntraced(function* (method: string, path: string, body?: unknown) {
    yield* Effect.sleep(caseIntervalMs);

    const init: RequestInit = {
      method,
      headers: {
        origin: api.browser,
        ...sessionHeaders(active),
        "content-type": "application/json",
      },
    };

    if (body !== undefined) {
      init.body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(body);
    }

    return yield* forward(new Request(api.api + path, init));
  });

  const mutation = yield* io(() =>
    proveScopedCorrection(manifest.history, (method, path, body) => run(mutate(method, path, body)))
  );

  const afterMutations = yield* nativeMeters(runtime);
  yield* io(() =>
    Bun.write(directory + "/ordinary-native-mutation.json", JSON.stringify(mutation))
  );
  yield* io(() =>
    Bun.write(
      directory + "/ordinary-native-accounting.json",
      JSON.stringify({
        before,
        afterReads,
        afterMutations,
      })
    )
  );
  offer({ status: 200 });
});

const emptyReceiptMarkers = Effect.fnUntraced(function* (runtime: Miniflare, revision: string) {
  const bucket = yield* io(() => runtime.getR2Bucket("SMOKE_BUCKET", "core"));
  const root = "_release-smoke/" + revision + "/acceptance/transactions/";

  const observed = yield* Effect.forEach(Object.keys(performanceReceiptPaths), (member) =>
    io(() => bucket.head(root + member))
  );

  return observed.every((object) => object === null);
});

export const serveFixture = Effect.fn(function* (runtime: Miniflare, member: PerformanceMember) {
  const auth = yield* authority;
  const service = client(auth, transport(runtime));
  const active = yield* start(service, member);
  offer(active);
  const lines = createInterface({ input: process.stdin, terminal: false });
  yield* Stream.fromAsyncIterable(lines, () => new FixtureTransportError()).pipe(
    Stream.runForEach(
      Effect.fnUntraced(function* (line) {
        const item = yield* Schema.decodeEffect(Schema.fromJsonString(command))(line);

        if (item.control === "mounted-workspace") yield* runMountedWorkspace(runtime, active);
        else if (item.control === "receipt-markers") {
          offer({ clear: yield* emptyReceiptMarkers(runtime, auth.revision) });
        } else yield* execute(item, service, { active, member });
      })
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
    BunRuntime.runMain(
      verify.pipe(
        Effect.catchCause(() =>
          Effect.sync(() => {
            process.stderr.write("Closed native fixture transport stopped\n");
            process.exitCode = 1;
          })
        )
      )
    );
  } else {
    process.stderr.write("Native fixture bridge admits offline verification only\n");
    process.exitCode = 1;
  }
}
