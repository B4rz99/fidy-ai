import { Effect, Schedule, Schema } from "effect";
import { ownerCheckUrl } from "../maintenance/contract";
import type { Miniflare } from "miniflare";
import { expect } from "vitest";
import { browser } from "../browser-bootstrap.test-fixture";
import { native, nativeLoginPlatform } from "../user-store.test-fixture";
import { NativeLoginEmailWork, loginDeliverUrl } from "./contract";
import { alice, seed } from "../financial-user-store.test-fixture";

type Owner = Effect.Success<ReturnType<typeof seed>>;

type Proof = { pairingId: string; privateVerifier: string };

type Mail = Effect.Effect<ReadonlyArray<string>, Schema.SchemaError>;

type Post = ReturnType<typeof browser>["post"];

type Mailbox = Readonly<{
  owner: Owner;
  start: (proof: Proof, email?: string) => ReturnType<Post>;
  pairing: () => Effect.Effect<Proof, Schema.SchemaError>;
  post: Post;
  logs: Array<string>;
  runtime: Miniflare;
  address: string;
  inbox: (recipient?: string) => Mail;
  delivered: Mail;
  awaitMail: (recipient?: string) => Mail;
  deliver: (work: typeof NativeLoginEmailWork.Type) => Effect.Effect<number>;
  work: () => Effect.Effect<typeof NativeLoginEmailWork.Type, Schema.SchemaError>;
  directory: Owner["exec"];
  hold: ReturnType<Owner["exec"]>;
  checkOwner: Effect.Effect<number>;
}>;

const providerMailbox = Effect.fn(function* (runtime: Miniflare, address: string) {
  const { FIXTURE_PROVIDER } = yield* native(() =>
    runtime.getBindings<{ FIXTURE_PROVIDER: Fetcher }>("core")
  );

  const inbox = (recipient = address): Effect.Effect<ReadonlyArray<string>, Schema.SchemaError> =>
    native(() =>
      FIXTURE_PROVIDER.fetch("https://mailbox.fixture.invalid/?to=" + encodeURIComponent(recipient))
    ).pipe(
      Effect.tap((reply) => Effect.sync(() => expect(reply.ok).toBe(true))),
      Effect.flatMap((reply) => native(() => reply.json())),
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.String)))
    );

  const awaitMail = (recipient = address): ReturnType<typeof inbox> =>
    inbox(recipient).pipe(
      Effect.repeat({
        until: (letters) => letters.length > 0,
        times: 36,
        schedule: Schedule.spaced("100 millis"),
      })
    );

  return { inbox, awaitMail, delivered: awaitMail() };
});

const establishedMailbox = Effect.fn(function* (runtime: Miniflare, address: string) {
  const owner = yield* seed(runtime, alice, false);
  yield* owner.exec(
    "INSERT INTO verified_email_credentials VALUES(?,?,1,?)",
    alice.user,
    address,
    owner.now
  );
  yield* native(() =>
    owner.directory.exec(
      "INSERT INTO verified_email_routes VALUES(?,?,?,1)",
      address,
      alice.user,
      alice.session
    )
  );

  return owner;
});

export const loginMailbox = Effect.fn(function* (address: string) {
  const logs: string[] = [];
  const runtime = yield* (yield* nativeLoginPlatform)("1000000000", logs);
  const owner = yield* establishedMailbox(runtime, address);
  const { post, pair } = browser(runtime);
  const pairing = (): ReturnType<Mailbox["pairing"]> => pair;

  const start = (
    proof: { pairingId: string; privateVerifier: string },
    email = address
  ): ReturnType<typeof post> => post("/web/email/authentication/start", { ...proof, email });

  const namespace = yield* native(() => runtime.getDurableObjectNamespace("USER_STORE", "core"));
  const user = namespace.getByName(alice.user);

  const deliver = (work: typeof NativeLoginEmailWork.Type): Effect.Effect<number> =>
    native(() =>
      user
        .fetch(loginDeliverUrl, { method: "POST", body: JSON.stringify(work) })
        .then((reply) => reply.status)
    );

  const work = (): Effect.Effect<typeof NativeLoginEmailWork.Type, Schema.SchemaError> =>
    owner.exec("SELECT work_id AS id FROM login_email_proofs").pipe(
      Effect.flatMap((rows) =>
        Schema.decodeUnknownEffect(NativeLoginEmailWork)({
          kind: "browser-pairing-email",
          version: 2,
          userId: alice.user,
          id: rows[0]?.id,
        })
      )
    );

  const directory = (
    ...args: Parameters<typeof owner.directory.exec>
  ): ReturnType<typeof owner.exec> => native(() => owner.directory.exec(...args));

  const hold = owner.exec(
    "CREATE TRIGGER hold_queue_offer AFTER INSERT ON login_email_proofs BEGIN UPDATE login_email_proofs SET offer_at_ms=expires_at_ms; END"
  );

  const mailbox: Mailbox = {
    ...(yield* providerMailbox(runtime, address)),
    owner,
    start,
    pairing,
    post,
    logs,
    runtime,
    address,
    deliver,
    work,
    directory,
    hold,
    checkOwner: native(() =>
      user.fetch(ownerCheckUrl, { method: "POST" }).then((reply) => reply.status)
    ),
  };

  return mailbox;
});
