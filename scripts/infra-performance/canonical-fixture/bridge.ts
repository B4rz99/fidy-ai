import { createInterface } from "node:readline/promises";
import { Effect, Redacted, Schema } from "effect";
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
import { openPerformanceBrowser } from "../../../infra/cloudflare/native-acceptance";

const api = installedOrigins.acceptance;
const minimumSecret = 32;
const session = Schema.Struct({ cookie: Schema.String, binding: Schema.String });
const command = Schema.Struct({
  path: Schema.String,
  method: Schema.Literals(["POST", "GET"]),
  body: Schema.Json,
  control: Schema.String,
});
type Command = typeof command.Type;
type Session = typeof session.Type;
type Transport = (request: Request) => Promise<Response>;
type Auth = { revision: string; secret: string };
const offer = (value: unknown): void => {
  process.stdout.write("FIDY_PRIVATE_RESPONSE " + JSON.stringify(value) + "\n");
};
const sessionHeaders = (value: Session): Record<string, string> => ({
  cookie: value.cookie,
  "fidy-session-binding": value.binding,
});
const transport =
  (runtime: Miniflare): Transport =>
  async (request) => {
    const reply = await runtime.dispatchFetch(request.url, {
      method: request.method,
      headers: { ...Object.fromEntries(request.headers), "cf-connecting-ip": "192.0.2.1" },
      redirect: "manual",
      ...(request.body ? { body: await request.arrayBuffer() } : {}),
    });
    const path = new URL(request.url).pathname;
    process.stderr.write(
      "Closed rehearsal " +
        (path.startsWith("/transactions/") ? "transaction" : path) +
        " " +
        reply.status +
        "\n"
    );
    if (!reply.ok) {
      process.stderr.write(
        "Closed stage isolation=" +
          String(reply.headers.has("x-fidy-recovery-isolation")) +
          " ingress=" +
          reply.headers.get("x-rehearsal-ingress") +
          " core=" +
          reply.headers.get("x-rehearsal-core") +
          " status=" +
          reply.status +
          "\n"
      );
    }
    const bytes = await reply.arrayBuffer();
    return new Response(bytes.byteLength ? bytes : null, {
      status: reply.status,
      headers: Object.fromEntries(reply.headers),
    });
  };
type Client = {
  request: (input: Command, headers: Record<string, string>) => Promise<Response>;
  login: (member: "performance-1" | "performance-2") => Promise<string>;
  bind: (token: string) => Promise<Session>;
};
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
const client = (auth: Auth, send: Transport): Client => {
  const environment = environmentOf(auth);
  const request = async (input: Command, headers: Record<string, string>): Promise<Response> => {
    const outgoing = new Request(api.api + input.path, {
      method: input.method,
      headers: { origin: api.browser, "content-type": "application/json", ...headers },
      redirect: "manual",
      ...(input.body === null ? {} : { body: JSON.stringify(input.body) }),
    });
    if (input.control !== "unsigned") {
      outgoing.headers.set(
        acceptanceProofHeader,
        await Effect.runPromise(
          signAcceptanceRequest({
            request: outgoing,
            boundary: "ingress",
            environment,
            deadline: Date.now() + acceptanceLifetimeMs,
          })
        )
      );
    }
    return send(outgoing);
  };
  const login = async (member: "performance-1" | "performance-2"): Promise<string> =>
    "__Host-fidy_session=" +
    Redacted.value(
      await Effect.runPromise(
        openPerformanceBrowser(
          {
            revision: auth.revision,
            proof: Redacted.make(auth.secret),
            send: (req) =>
              Effect.tryPromise({
                try: () => send(req),
                catch: () => Error("Closed transport unavailable"),
              }),
          },
          member
        )
      )
    );
  const bind = async (cookie: string): Promise<Session> => {
    const reply = await request(
      { path: "/web/session/binding", method: "GET", body: null, control: "" },
      { cookie }
    );
    if (!reply.ok) throw Error("Native Session binding unavailable");
    const { binding } = Schema.decodeUnknownSync(Schema.Struct({ binding: Schema.String }))(
      await reply.json()
    );
    return { cookie, binding };
  };
  return { request, login, bind };
};
const start = async (service: ReturnType<typeof client>): Promise<Session> => {
  const retained = process.env.FIDY_BOUND_SESSION_FILE;
  if (!retained) return service.bind(await service.login("performance-1"));
  const previous = Schema.decodeUnknownSync(session)(await Bun.file(retained).json());
  const active = await service.bind(previous.cookie);
  if (active.binding !== previous.binding) throw Error("Previous mounted Session changed");
  return active;
};
const allowed = (item: Command): boolean =>
  item.method === "GET"
    ? item.path === "/transactions?limit=25" || /^\/transactions\/[a-f0-9-]{36}$/u.test(item.path)
    : ["/operations/atomic-batch", "/transactions/link", performanceReceiptPath].includes(
        item.path
      );
const execute = async (item: Command, active: Session, service: Client): Promise<void> => {
  if (!allowed(item)) {
    throw Error("Outside fixture transport");
  }
  let headers = sessionHeaders(active);
  if (item.control === "foreign-session") {
    headers = sessionHeaders(await service.bind(await service.login("performance-2")));
  }
  if (item.control === "wrong-binding") {
    headers["fidy-session-binding"] = "00000000-0000-4000-8000-000000000000";
  }
  const reply = await service.request(item, headers);
  const raw = await reply.text();
  offer({
    status: reply.status,
    data: reply.ok ? Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(raw) : null,
  });
};
const authority = (): Auth => {
  const auth = {
    secret: process.env.SMOKE_PROOF ?? "",
    revision: process.env.FIDY_NATIVE_REVISION ?? "",
  };
  if (auth.secret.length < minimumSecret || !/^[a-f0-9]{40}$/u.test(auth.revision)) {
    throw Error("Missing receipt authority");
  }
  return auth;
};
export type FixtureSession = Session;
export type FixtureClient = Client;
export type RehearsalHooks = (service: Client) => Promise<(active: Session) => Promise<void>>;
export const serveFixture = async (runtime: Miniflare, hooks?: RehearsalHooks): Promise<void> => {
  const auth = authority();
  try {
    const service = client(auth, transport(runtime));
    const finish = await hooks?.(service);
    const active = await start(service);
    offer(active);
    for await (const line of createInterface({ input: process.stdin, terminal: false })) {
      const item = Schema.decodeUnknownSync(Schema.fromJsonString(command))(line);
      await execute(item, active, service);
    }
    await finish?.(active);
  } finally {
    await runtime.dispose();
  }
};
const main = async (): Promise<void> => {
  if (process.argv[2] === "verify") {
    const auth = authority();
    const envelope = Schema.decodeUnknownSync(SealedTransactionReceipt)(await Bun.stdin.json());
    process.stdout.write(
      await Effect.runPromise(
        openTransactionReceipt({
          secret: auth.secret,
          publicKey: process.env.FIDY_NATIVE_FIXTURE_PUBLIC_KEY ?? "",
          value: envelope,
        })
      )
    );
    return;
  }
  process.stderr.write("Native fixture bridge admits offline verification only\n");
  process.exitCode = 1;
};
if (import.meta.main) {
  await main().catch(() => {
    process.stderr.write("Closed native fixture transport stopped\n");
    process.exitCode = 1;
  });
}
