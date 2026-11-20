import { createInterface } from "node:readline/promises";
import { Effect, Redacted, Schema } from "effect";
import { performanceCohortBrowser } from "../../../infra/cloudflare/native-acceptance";
import { performanceReceiptPath } from "../../../apps/server/cloudflare/release-isolation/contract";
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
const io = <A>(run: () => Promise<A>): Effect.Effect<A, Error> =>
  Effect.tryPromise({ try: run, catch: () => Error("Private cohort transport unavailable") });
const upstream = Schema.Struct({
  status: Schema.Int,
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.String,
});
// This executable has no network transport. Every protected request returns to the parent
// for its release, lease, request-count and origin checks before the parent sends it.
const relay =
  (read: Read): Transport =>
  (request) =>
    io(async () => {
      output({
        exchange: {
          url: request.url,
          method: request.method,
          headers: Object.fromEntries(request.headers),
          body: request.body === null ? null : await request.text(),
        },
      });
      const reply = Schema.decodeSync(Schema.fromJsonString(upstream))(await read());
      return new Response(reply.body || null, { status: reply.status, headers: reply.headers });
    });

const fixturePath = (method: string, path: string): boolean =>
  method === "GET"
    ? path === "/transactions?limit=25" || /^\/transactions\/[a-f0-9-]{36}$/u.test(path)
    : ["/operations/atomic-batch", "/transactions/link", performanceReceiptPath].includes(path);

type CohortBrowser = ReturnType<typeof performanceCohortBrowser>;
type Item = typeof command.Type;
type Local = (action: string) => Promise<unknown>;
const unavailable: Local = () => Promise.reject(Error("Unknown cohort action"));
const headersOf = (item: Item): Record<string, string> => {
  if (!item.cookie || !item.binding) throw Error("Missing mounted Session");
  return { cookie: item.cookie, "fidy-session-binding": item.binding };
};
const canonical = async (port: CohortBrowser, item: Item): Promise<unknown> => {
  if (!item.method || !item.path || !fixturePath(item.method, item.path)) {
    throw Error("Unknown fixture operation");
  }
  const reply = await Effect.runPromise(
    port.call(item.path, {
      method: item.method,
      headers: {
        ...headersOf(item),
        origin: installedOrigins.acceptance.browser,
        "content-type": "application/json",
      },
      ...(item.body == null ? {} : { body: JSON.stringify(item.body) }),
    })
  );
  return { status: reply.status, data: reply.ok ? await reply.json() : null };
};
const dispatch = (port: CohortBrowser, local: Local): ((item: Item) => Promise<unknown>) => {
  const actions = new Map<string, (item: Item) => Promise<unknown>>([
    ["login", (): Promise<unknown> => Effect.runPromise(port.open("login"))],
    ["register", (): Promise<unknown> => Effect.runPromise(port.open("signup"))],
    ["survivors", (): Promise<unknown> => Effect.runPromise(port.survivors())],
    [
      "before-signup",
      (): Promise<unknown> => Effect.runPromise(port.beforeSignup().pipe(Effect.as(true))),
    ],
    ["renew", (): Promise<unknown> => Effect.runPromise(port.renew().pipe(Effect.as(true)))],
    ["refused", (): Promise<unknown> => Effect.runPromise(port.refused())],
    ["erase", (item: Item): Promise<unknown> => Effect.runPromise(port.erase(headersOf(item)))],
    [
      "denied",
      (item: Item): Promise<unknown> =>
        Effect.runPromise(port.denied(headersOf(item)).pipe(Effect.as(true))),
    ],
    ["canonical", (item: Item): Promise<unknown> => canonical(port, item)],
  ]);
  return (item) => actions.get(item.action)?.(item) ?? local(item.action);
};
export const serveCohort = async (
  { revision, secret }: { revision: string; secret: string },
  network: (read: Read) => Transport = relay,
  local: Local = unavailable
): Promise<void> => {
  const lines = createInterface({ input: process.stdin, terminal: false });
  const iterator = lines[Symbol.asyncIterator]();
  const read = async (): Promise<string> => (await iterator.next()).value ?? "";
  const apply = dispatch(
    performanceCohortBrowser({ revision, proof: Redacted.make(secret), send: network(read) }),
    local
  );
  const next = async (): Promise<void> => {
    const line = await read();
    if (line === "") return;
    output(await apply(Schema.decodeSync(Schema.fromJsonString(command))(line)));
    return next();
  };
  try {
    await next();
  } finally {
    lines.close();
  }
};
if (import.meta.main) {
  const secret = process.env.SMOKE_PROOF ?? "";
  const revision = process.env.FIDY_NATIVE_REVISION ?? "";
  const minimumSecret = 32;
  if (secret.length < minimumSecret || !/^[a-f0-9]{40}$/u.test(revision)) {
    process.exitCode = 1;
  } else {
    await serveCohort({ revision, secret }).catch(() => {
      process.stderr.write("Closed cohort command refused\n");
      process.exitCode = 1;
    });
  }
}
