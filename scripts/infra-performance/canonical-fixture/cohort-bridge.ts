import { createInterface } from "node:readline/promises";
import { BunRuntime } from "@effect/platform-bun";
import { Config, Data, Effect, Redacted, Schema } from "effect";
import { performanceCohortBrowser } from "../../../infra/cloudflare/native-acceptance";
import {
  type PerformanceMember,
  performanceReceiptPaths,
} from "../../../apps/server/cloudflare/release-isolation/contract";
import { installedOrigins } from "../../../apps/server/src/shell/browser-transport/contract";

type Transport = Parameters<typeof performanceCohortBrowser>[0]["send"];

type Read = () => Promise<string>;

const output = (value: unknown): void => {
  process.stdout.write("FIDY_PRIVATE_RESPONSE " + JSON.stringify(value) + "\n");
};

const command = Schema.Struct({
  action: Schema.String,
  path: Schema.optional(Schema.String),
  method: Schema.optional(Schema.Literals(["GET", "POST"])),
  body: Schema.optional(Schema.Json),
  cookie: Schema.optional(Schema.String),
  binding: Schema.optional(Schema.String),
});

class CohortTransportError extends Data.TaggedError("CohortTransportError") {}

const io = <A>(run: () => Promise<A>): Effect.Effect<A, CohortTransportError> =>
  Effect.tryPromise({ try: run, catch: () => new CohortTransportError() });

const upstream = Schema.Struct({
  status: Schema.Int,
  headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
  body: Schema.String,
});

const relay = (read: Read): Transport =>
  Effect.fnUntraced(function* (request: Request) {
    output({
      exchange: {
        url: request.url,
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body: request.body === null ? null : yield* io(() => request.text()),
      },
    });
    const reply = yield* Schema.decodeEffect(Schema.fromJsonString(upstream))(yield* io(read));
    const headers = new Headers();

    for (const [key, value] of reply.headers) headers.append(key, value);

    return new Response(reply.body === "" ? null : reply.body, {
      status: reply.status,
      headers,
    });
  });

type Browser = ReturnType<typeof performanceCohortBrowser>;

export type CohortCommand = typeof command.Type;

type Item = CohortCommand;

type Local = (item: Item) => Effect.Effect<unknown, Error>;

type Action = (item: Item) => Effect.Effect<unknown, Error>;

const unavailable: Local = () => Effect.fail(new CohortTransportError());

const fixturePath = (method: string, path: string, member: PerformanceMember): boolean =>
  method === "GET"
    ? [
        "/user",
        "/transactions?limit=25",
        "/ingestion/review-workspace?limit=0&status=pending",
      ].includes(path) || /^\/transactions\/[a-f0-9-]{36}$/u.test(path)
    : ["/operations/atomic-batch", "/transactions/link", performanceReceiptPaths[member]].includes(
        path
      );

const headersOf = Effect.fnUntraced(function* (item: Item) {
  if (item.cookie === undefined || item.binding === undefined) {
    return yield* new CohortTransportError();
  }

  return { cookie: item.cookie, "fidy-session-binding": item.binding };
});

const canonical = Effect.fnUntraced(function* (
  port: Browser,
  item: Item,
  member: PerformanceMember
) {
  if (
    item.method === undefined ||
    item.path === undefined ||
    !fixturePath(item.method, item.path, member)
  ) {
    return yield* new CohortTransportError();
  }

  const requestInit = {
    method: item.method,
    headers: {
      ...(yield* headersOf(item)),
      origin: installedOrigins.acceptance.browser,
      "content-type": "application/json",
    },
  };

  const reply = yield* item.body == null
    ? port.call(item.path, requestInit)
    : port.call(item.path, {
        ...requestInit,
        body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(item.body),
      });

  return { status: reply.status, data: reply.ok ? yield* io(() => reply.json()) : null };
});

const dispatch = (port: Browser, local: Local, member: PerformanceMember): Action => {
  const actionEntries: ReadonlyArray<readonly [string, Action]> = [
    ["login", () => port.open("login")],
    ["cleanup-login", () => port.open("login").pipe(Effect.orElseSucceed(() => null))],
    ["register", () => port.open("signup")],
    ["survivors", () => port.survivors()],
    ["before-signup", () => port.beforeSignup().pipe(Effect.as(true))],
    ["renew", () => port.renew().pipe(Effect.as(true))],
    ["refused", () => port.refused()],
    ["erase", (item) => headersOf(item).pipe(Effect.flatMap(port.erase))],
    ["denied", (item) => headersOf(item).pipe(Effect.flatMap(port.denied), Effect.as(true))],
    ["canonical", (item) => canonical(port, item, member)],
  ];

  const actions = new Map(actionEntries);

  return (item) => {
    const action = actions.get(item.action);

    return action === undefined ? local(item) : action(item);
  };
};

export const cohortAuthority = Effect.gen(function* () {
  const secret = Redacted.value(yield* Config.Redacted("SMOKE_PROOF"));
  const revision = yield* Config.String("FIDY_NATIVE_REVISION");
  const minimumSecret = 32;

  if (secret.length < minimumSecret || !/^[a-f0-9]{40}$/u.test(revision)) {
    return yield* new CohortTransportError();
  }

  const member = yield* Config.Literals(
    ["performance-1", "performance-2"],
    "FIDY_BOUND_FIXTURE_MEMBER"
  ).pipe(Config.withDefault("performance-1"));

  return { revision, secret, member };
});

export const serveCohort = Effect.fn(function* (
  auth: { revision: string; secret: string; member: PerformanceMember },
  network: (read: Read) => Transport = relay,
  local: Local = unavailable
) {
  const lines = createInterface({ input: process.stdin, terminal: false });
  const iterator = lines[Symbol.asyncIterator]();

  const read: Read = () =>
    iterator.next().then((value) => (value.done === true ? "" : value.value));

  const apply = dispatch(
    performanceCohortBrowser({
      revision: auth.revision,
      proof: Redacted.make(auth.secret),
      send: network(read),
      member: auth.member,
    }),
    local,
    auth.member
  );

  yield* Effect.gen(function* () {
    const line = yield* io(read);

    if (line === "") return false;
    output(yield* apply(yield* Schema.decodeEffect(Schema.fromJsonString(command))(line)));

    return true;
  }).pipe(
    Effect.repeat({ while: (continued) => continued }),
    Effect.ensuring(Effect.sync(() => lines.close()))
  );
});

if (import.meta.main) {
  BunRuntime.runMain(
    cohortAuthority.pipe(
      Effect.flatMap((auth) => serveCohort(auth)),
      Effect.catchCause(() =>
        Effect.sync(() => {
          process.stderr.write("Closed cohort command refused\n");
          process.exitCode = 1;
        })
      )
    )
  );
}
