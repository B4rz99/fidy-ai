import { ownerCheckUrl } from "./maintenance/contract";
import { newId } from "./secret-material/operations";
import { Clock, Effect } from "effect";
import { expect } from "vitest";
import type { Miniflare } from "miniflare";
import { browserOrigins, productionTopology } from "./runtime/contract";
import { native, nativeHostedPlatform, nativeUserPlatform } from "./user-store.test-fixture";

const bearerLength = 43;

const sessionLifetimeMs = 7776000000;

const freshSessionMs = 600000;

const idleSessionMs = 3600000;

const unauthorizedStatus = 401;

export const alice = {
  user: "10000000-0000-4000-8000-000000000051",
  session: "10000000-0000-4000-8000-000000000061",
  bearer: "1".repeat(bearerLength),
};

export const bob = {
  user: "10000000-0000-4000-8000-000000000052",
  session: "10000000-0000-4000-8000-000000000062",
  bearer: "2".repeat(bearerLength),
};

export const category = "10000000-0000-4000-8000-000000000016";

export const transaction = "10000000-0000-4000-8000-000000000088";

export const second = "10000000-0000-4000-8000-000000000089";

export const instant = 1_700_000_000_000;

type ServiceResponse = ReturnType<Awaited<ReturnType<Miniflare["getWorker"]>>["fetch"]>;

export const nativeIngress =
  (runtime: Miniflare) =>
  (url: string, init: RequestInit): ServiceResponse => {
    const request = new Request(url, init);

    return Promise.all([
      runtime.getWorker("financial-client"),
      request.body === null ? null : request.text(),
    ]).then(([client, body]) =>
      client.fetch("https://client.invalid/send", {
        method: "POST",
        body: JSON.stringify({
          url: request.url,
          method: request.method,
          headers: Object.fromEntries(request.headers),
          body,
        }),
      })
    );
  };

export const history = Effect.fn(function* (
  runtime: Miniflare,
  subject: typeof alice = alice,
  query: string = ""
) {
  return yield* native(() =>
    nativeIngress(runtime)(`https://${productionTopology.ingress.hostname}/transactions${query}`, {
      headers: {
        origin: browserOrigins.production,
        "Fidy-Session-Binding": subject.session,
        cookie: `__Host-fidy_session=${subject.bearer}`,
      },
    })
  );
});

export const receivedStatus = Effect.fn(function* (call: ReturnType<typeof history>) {
  const response = yield* call;
  yield* native(() => response.arrayBuffer());

  return response.status;
});

export const seed = Effect.fn(function* (
  runtime: Miniflare,
  subject: typeof alice,
  initialTransaction: boolean = true
) {
  const directory = yield* native(() =>
    runtime.unsafeGetDurableObjectStorage("core", "Directory", { name: "directory-v1" })
  );

  const local = yield* native(() =>
    runtime.unsafeGetDurableObjectStorage("core", "UserStore", { name: subject.user })
  );

  const digest = yield* native(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(subject.bearer))
  );

  const now = yield* Clock.currentTimeMillis;

  const exec = (
    ...args: Parameters<typeof local.exec>
  ): Effect.Effect<Awaited<ReturnType<typeof local.exec>>> => native(() => local.exec(...args));

  expect(yield* receivedStatus(history(runtime, subject))).toBe(unauthorizedStatus);
  yield* native(() =>
    directory.exec(
      "INSERT INTO session_routes VALUES (?,?,?,?,?)",
      digest,
      subject.user,
      subject.session,
      "route-" + subject.session,
      now + sessionLifetimeMs
    )
  );
  expect(yield* receivedStatus(history(runtime, subject))).toBe(unauthorizedStatus);
  yield* exec(
    "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES (?,'CO','es-CO','America/Bogota',?)",
    subject.user,
    now
  );
  yield* exec(
    "INSERT INTO web_sessions(id,pairing_id,user_id,token_digest,created_at_ms,fresh_until_ms,idle_expires_at_ms,hard_expires_at_ms) VALUES (?,?,?,?,?,?,?,?)",
    subject.session,
    "10000000-0000-4000-8000-000000000071",
    subject.user,
    digest,
    now,
    now + freshSessionMs,
    now + idleSessionMs,
    now + sessionLifetimeMs
  );
  yield* exec("INSERT INTO categories VALUES (?,'Otros',1)", category);

  if (initialTransaction) {
    yield* exec(
      "INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,occurred_at_ms,created_at_ms) VALUES (?,?,'9007199254740993.15','USD','outflow',?,?,?)",
      transaction,
      subject.user,
      category,
      instant,
      instant
    );
  }

  return { exec, digest, directory, now, local };
});

const nativeWorkCheck = (
  runtime: Miniflare,
  user: string
): Promise<{ status: number; repaired: string }> =>
  runtime
    .getDurableObjectNamespace("USER_STORE", "core")
    .then((namespace) => namespace.getByName(user).fetch(ownerCheckUrl, { method: "POST" }))
    .then((response) => ({
      status: response.status,
      repaired: response.headers.get("fidy-alarm-repaired") ?? "unreported",
    }));

const sendNativeRequest = (runtime: Miniflare, request: Request): Promise<Response> => {
  const headers = new Headers(request.headers);
  headers.set("cf-connecting-ip", "192.0.2.35");

  return (request.body === null ? Promise.resolve({}) : request.text().then((body) => ({ body })))
    .then((body) =>
      runtime.dispatchFetch(request.url, {
        method: request.method,
        headers: { ...Object.fromEntries(headers), connection: "close" },
        ...body,
      })
    )
    .then((response) =>
      response.text().then(
        (text) =>
          new Response(text, {
            status: response.status,
            headers: Object.fromEntries(response.headers),
          })
      )
    );
};

export const makeNativeTransactionJourney = Effect.fn(function* (
  ceiling?: string,
  platform: typeof nativeUserPlatform = nativeUserPlatform
) {
  const create = yield* platform;
  const runtime = yield* create(ceiling);
  const first = yield* seed(runtime, alice, false);
  const other = yield* seed(runtime, bob, false);
  yield* first.exec(
    "INSERT INTO categories VALUES (?,'Mercado',2)",
    "10000000-0000-4000-8000-000000000012"
  );

  const owner = (id: string): typeof first.local => {
    if (id === alice.user) return first.local;

    if (id === bob.user) return other.local;
    throw new Error("Unknown test User");
  };

  const exec = (
    ...args: Parameters<typeof first.local.exec>
  ): ReturnType<typeof first.local.exec> => first.local.exec(...args);

  const send = (request: Request): Promise<Response> => sendNativeRequest(runtime, request);

  const browser = (index: number, path = "/transactions"): Promise<Response> => {
    const subject = index === 0 ? alice : bob;

    return send(
      new Request(`https://${productionTopology.ingress.hostname}${path}`, {
        headers: {
          origin: browserOrigins.production,
          "Fidy-Session-Binding": subject.session,
          cookie: `__Host-fidy_session=${subject.bearer}`,
        },
      })
    );
  };

  return {
    runtime,
    owner,
    exec,
    send,
    browser,
    directory: first.directory,
    checkWork: (user: string): ReturnType<typeof nativeWorkCheck> => nativeWorkCheck(runtime, user),
  };
});

export const nativeTransactionJourney = makeNativeTransactionJourney();

export const nativeHostedTransactionJourney = makeNativeTransactionJourney(
  undefined,
  nativeHostedPlatform
);

const patPrefixLength = 4;

const shortIdLength = 8;

const patLifetime = 604800000;

export const seedNativePAT = Effect.fn(function* ({
  db,
  userId,
  token,
  scopes,
  current,
}: Readonly<{
  db: Effect.Success<typeof nativeTransactionJourney>;
  userId: string;
  token: string;
  scopes: ReadonlyArray<string>;
  current: number;
}>) {
  const id = newId();
  const shortId = token.slice(patPrefixLength, patPrefixLength + shortIdLength);

  const digestBytes = yield* native(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))
  );

  yield* native(() =>
    db
      .owner(userId)
      .exec(
        "INSERT INTO pats(id,user_id,short_id,bearer_digest,recipient_label,scopes_json,lifetime_days,created_at_ms,issued_at_ms,expires_at_ms,request_id) VALUES(?,?,?,?,'agent',?,7,?,?,?,?)",
        id,
        userId,
        shortId,
        digestBytes,
        JSON.stringify(scopes),
        current,
        current,
        current + patLifetime,
        id
      )
  );
  yield* native(() =>
    db.directory.exec(
      "INSERT INTO pat_routes VALUES (?,?,?,?,?)",
      shortId,
      userId,
      id,
      "route-" + id,
      current + patLifetime
    )
  );
});

export const nativeBrowserWrite =
  (db: Pick<Effect.Success<typeof nativeTransactionJourney>, "send">) =>
  (
    user: typeof alice,
    input: { path: string; method: string } & ({} | { body: unknown })
  ): Effect.Effect<Response> => {
    const init = {
      method: input.method,
      headers: {
        origin: browserOrigins.production,
        cookie: "__Host-fidy_session=" + user.bearer,
        "Fidy-Session-Binding": user.session,
        "content-type": "application/json",
      },
    };

    return native(() =>
      db.send(
        new Request(
          "https://api.fidyapp.com" + input.path,
          "body" in input ? { ...init, body: JSON.stringify(input.body) } : init
        )
      )
    );
  };
