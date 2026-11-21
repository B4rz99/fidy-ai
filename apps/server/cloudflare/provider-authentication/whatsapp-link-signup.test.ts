import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { NodeFileSystem } from "@effect/platform-node";
import type { Miniflare } from "miniflare";
import { expect } from "vitest";
import { browser, chatWith, signedChat } from "../browser-bootstrap.test-fixture";
import { native, nativeBrowserPlatform } from "../user-store.test-fixture";
import { webSignupDisclosure } from "../../src/shell/consent/operations";
import { UserId } from "../../src/core/identity/contract";

const caller = "CO.Original";

const complete = "/web/providers/google/complete";

const start = "/web/providers/google/start";

type ChatChange = Partial<Parameters<typeof chatWith>[1]>;

const refusedChange =
  (
    runtime: Miniflare,
    text: string
  ): ((change: ChatChange) => Effect.Effect<boolean, Schema.SchemaError>) =>
  (change) =>
    chatWith(runtime, { caller, text, ...change }).pipe(
      Effect.tap((refused) => native(() => refused.arrayBuffer())),
      Effect.map(({ ok }) => ok)
    );

const refusedAdmission = (
  runtime: Miniflare,
  directory: Awaited<ReturnType<Miniflare["unsafeGetDurableObjectStorage"]>>,
  limitedCaller: string
): ((admission: readonly [string, number]) => Effect.Effect<number, Schema.SchemaError>) =>
  Effect.fnUntraced(function* ([scope, limit]) {
    yield* native(() =>
      directory.exec(
        "WITH RECURSIVE n(i) AS(VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<?) INSERT INTO bootstrap_admissions(scope,expires_at_ms) SELECT ?,4102444800000 FROM n",
        limit,
        scope
      )
    );
    const refused = yield* signedChat(runtime, "Hola", limitedCaller);
    yield* native(() => refused.arrayBuffer());
    yield* native(() => directory.exec("DELETE FROM bootstrap_admissions WHERE scope=?", scope));

    return refused.status;
  });

const Review = Schema.Struct({ confirmationText: Schema.String, associationCode: Schema.String });

const invitation = Effect.fn(function* (
  runtime: Effect.Success<ReturnType<Effect.Success<typeof nativeBrowserPlatform>>>,
  source: string
) {
  const first = yield* signedChat(runtime, "Hola", source);
  expect(first.status).toBe(200);
  yield* native(() => first.arrayBuffer());

  const directory = yield* native(() =>
    runtime.unsafeGetDurableObjectStorage("core", "Directory", { name: "directory-v1" })
  );

  const [record] = yield* Schema.decodeUnknownEffect(
    Schema.Array(Schema.Struct({ id: Schema.String }))
  )(
    yield* native(() => directory.exec("SELECT id FROM whatsapp_invitations WHERE bsuid=?", source))
  );

  if (record === undefined) return yield* Effect.die("Missing invitation");

  return { id: record.id, directory };
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "keeps the invitation private to one pairing and requires exact reviewed text from its source and endpoint",
    () =>
      Effect.gen(function* () {
        const runtime = yield* (yield* nativeBrowserPlatform)();
        const { id, directory } = yield* invitation(runtime, caller);
        const again = yield* invitation(runtime, caller);
        expect(again.id).toBe(id);
        const context = browser(runtime);
        const actual = yield* context.verified("whatsapp", id);
        const review = yield* Schema.decodeUnknownEffect(Review)(actual.review);
        const different = yield* context.pair;

        const unknown = yield* context.post(start, {
          ...different,
          intent: "signup",
          consentRevision: webSignupDisclosure().revision,
          handoffReference: "00000000-0000-4000-8000-000000000001",
        });

        expect(unknown.status).toBe(400);
        yield* native(() => unknown.arrayBuffer());
        expect(
          yield* native(() =>
            directory.exec(
              "SELECT count(*) AS n FROM provider_attempts WHERE pairing_id=?",
              different.pairingId
            )
          )
        ).toEqual([{ n: 0 }]);

        const takeover = yield* context.post(start, {
          ...different,
          intent: "signup",
          consentRevision: webSignupDisclosure().revision,
          handoffReference: id,
        });

        expect(takeover.status).toBe(400);
        yield* native(() => takeover.arrayBuffer());

        const before = yield* context.post(complete, {
          ...actual.proof,
          associationCode: review.associationCode,
        });

        expect(before.status).toBe(400);
        yield* native(() => before.arrayBuffer());
        yield* Effect.sleep("1100 millis");

        expect(
          yield* Effect.forEach(
            [
              { text: " " + review.confirmationText },
              { text: review.confirmationText + " " },
              { text: review.confirmationText.replace("Google", "Microsoft") },
              { caller: "CO.Other" },
              { endpoint: "999999999999999" },
              { occurredMs: 1 },
              { secret: "incorrect" },
            ],
            refusedChange(runtime, review.confirmationText)
          )
        ).toEqual([false, false, false, false, false, false, false]);

        const declined = yield* signedChat(
          runtime,
          review.confirmationText.replace(/^Vincular /u, "No vincular "),
          caller
        );

        expect(declined.status).toBe(200);
        yield* native(() => declined.arrayBuffer());
        const status = yield* context.post("/web/providers/google/status", actual.proof);
        expect(yield* native(() => status.json())).toEqual({ status: "rejected" });

        const denied = yield* context.post(complete, {
          ...actual.proof,
          associationCode: review.associationCode,
        });

        expect(denied.status).toBe(400);
        yield* native(() => denied.arrayBuffer());
        expect(
          yield* native(() => directory.exec("SELECT count(*) AS n FROM whatsapp_routes"))
        ).toEqual([{ n: 0 }]);
      })
  );
  test.effect(
    "links an existing provider User once with no second enrollment, then verifies the established caller before Browser Login approval",
    () =>
      Effect.gen(function* () {
        const runtime = yield* (yield* nativeBrowserPlatform)();
        const context = browser(runtime);
        const existing = yield* context.verified("existing");
        const created = yield* context.post(complete, existing.proof);
        expect(yield* native(() => created.json())).toMatchObject({ status: "created" });
        const { id, directory } = yield* invitation(runtime, caller);
        const flow = yield* context.verified("existing", id);
        const review = yield* Schema.decodeUnknownEffect(Review)(flow.review);
        yield* Effect.sleep("1100 millis");
        const accepted = yield* signedChat(runtime, review.confirmationText, caller);
        expect(accepted.status).toBe(200);
        yield* native(() => accepted.arrayBuffer());

        const [user] = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ user_id: UserId }))
        )(yield* native(() => directory.exec("SELECT user_id FROM provider_routes")));

        if (user === undefined) return yield* Effect.die("Missing association");

        const store = yield* native(() =>
          runtime.unsafeGetDurableObjectStorage("core", "UserStore", { name: user.user_id })
        );

        yield* native(() =>
          store.exec(
            "CREATE TRIGGER interrupt_link BEFORE UPDATE OF outcome ON browser_handoffs WHEN NEW.outcome='committed' BEGIN SELECT RAISE(IGNORE); END"
          )
        );

        const interrupted = yield* context.post(complete, {
          ...flow.proof,
          associationCode: review.associationCode,
        });

        expect(interrupted.status).toBe(503);
        yield* native(() => interrupted.arrayBuffer());
        expect(yield* native(() => store.exec("SELECT whatsapp_bsuid FROM users"))).toEqual([
          { whatsapp_bsuid: null },
        ]);
        expect(
          yield* native(() => directory.exec("SELECT established FROM whatsapp_routes"))
        ).toEqual([{ established: 0 }]);
        yield* native(() => store.exec("DROP TRIGGER interrupt_link"));

        const linked = yield* context.post(complete, {
          ...flow.proof,
          associationCode: review.associationCode,
        });

        expect(yield* native(() => linked.json())).toEqual({
          status: "approved",
          whatsappReturnUrl: "https://wa.me/12056871742",
        });
        expect(
          yield* native(() =>
            store.exec(
              "SELECT (SELECT count(*) FROM consent_history) AS consent,(SELECT revision FROM backup_recovery_credentials) AS recovery,(SELECT whatsapp_bsuid FROM users) AS caller"
            )
          )
        ).toEqual([{ consent: 1, recovery: 1, caller }]);
        const otherCaller = "CO.Replacement";
        const otherInvitation = yield* invitation(runtime, otherCaller);
        const other = yield* context.verified("existing", otherInvitation.id);
        const otherReview = yield* Schema.decodeUnknownEffect(Review)(other.review);
        yield* Effect.sleep("1100 millis");
        const confirmation = yield* signedChat(runtime, otherReview.confirmationText, otherCaller);
        expect(confirmation.status).toBe(200);
        yield* native(() => confirmation.arrayBuffer());

        const conflict = yield* context.post(complete, {
          ...other.proof,
          associationCode: otherReview.associationCode,
        });

        expect(conflict.status).toBe(400);
        yield* native(() => conflict.arrayBuffer());
        expect(yield* native(() => store.exec("SELECT whatsapp_bsuid FROM users"))).toEqual([
          { whatsapp_bsuid: caller },
        ]);
        const newPair = yield* context.post("/web/pairings", {});

        const pairing = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            publicCode: Schema.String,
            pairingId: Schema.String,
            privateVerifier: Schema.String,
          })
        )(yield* native(() => newPair.json()));

        const text = "Aprueba el código de inicio de sesión " + pairing.publicCode;
        const wrong = yield* signedChat(runtime, text, "CO.Foreign");
        expect(wrong.ok).toBe(false);
        yield* native(() => wrong.arrayBuffer());
        const approved = yield* signedChat(runtime, text, caller);
        expect(approved.status).toBe(200);
        yield* native(() => approved.arrayBuffer());
        const redeem = yield* context.post("/web/pairings/redeem", pairing);
        expect(redeem.headers.get("set-cookie")).toContain("__Host-fidy_session=");
        yield* native(() => redeem.arrayBuffer());
      })
  );
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "supersedes old account reviews and refuses a late or expired handoff before creating any User",
    () =>
      Effect.gen(function* () {
        const runtime = yield* (yield* nativeBrowserPlatform)();
        const context = browser(runtime);
        const { id, directory } = yield* invitation(runtime, caller);
        const flow = yield* context.verified("first", id);
        const original = yield* Schema.decodeUnknownEffect(Review)(flow.review);

        const replacement = yield* context.post(start, {
          ...flow.proof,
          intent: "signup",
          consentRevision: webSignupDisclosure().revision,
          handoffReference: id,
        });

        const cookie = replacement.headers.get("set-cookie")?.split(";")[0] ?? "";

        const authorized = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ authorizationUrl: Schema.String })
        )(yield* native(() => replacement.json()));

        const url = new URL(authorized.authorizationUrl);
        const callback = new URL("/providers/google/callback", context.api);
        callback.search = new URLSearchParams({
          state: url.searchParams.get("state") ?? "",
          code: (url.searchParams.get("nonce") ?? "") + ".second.valid",
        }).toString();

        const response = yield* native(() =>
          runtime.dispatchFetch(callback.href, {
            headers: { ...context.headers, cookie },
            redirect: "manual",
          })
        );

        yield* native(() => response.arrayBuffer());
        const updated = yield* context.post("/web/providers/google/status", flow.proof);

        const review = yield* Schema.decodeUnknownEffect(Review)(
          yield* native(() => updated.json())
        );

        expect(review.associationCode).not.toBe(original.associationCode);
        const late = yield* signedChat(runtime, original.confirmationText, caller);
        expect(late.ok).toBe(false);
        yield* native(() => late.arrayBuffer());
        yield* native(() =>
          directory.exec("UPDATE whatsapp_invitations SET expires_at_ms=0 WHERE id=?", id)
        );

        const denied = yield* context.post(complete, {
          ...flow.proof,
          associationCode: review.associationCode,
        });

        expect(denied.status).toBe(400);
        yield* native(() => denied.arrayBuffer());
        expect(
          yield* native(() => directory.exec("SELECT count(*) AS n FROM provider_routes"))
        ).toEqual([{ n: 0 }]);
      })
  );
  test.effect("refuses invitation egress when source, spend or storage admission fails", () =>
    Effect.gen(function* () {
      const runtime = yield* (yield* nativeBrowserPlatform)();
      yield* browser(runtime).pair;

      const directory = yield* native(() =>
        runtime.unsafeGetDurableObjectStorage("core", "Directory", { name: "directory-v1" })
      );

      const caller = "CO.Limited";

      expect(
        yield* Effect.forEach(
          [
            ["wa:9:portfolio" + caller, 6],
            ["whatsapp-sends", 1000],
          ] as const,
          refusedAdmission(runtime, directory, caller)
        )
      ).toEqual([429, 429]);

      yield* native(() =>
        directory.exec(
          "CREATE TRIGGER refuse_invitation BEFORE INSERT ON whatsapp_invitations BEGIN SELECT RAISE(ABORT,'offline'); END"
        )
      );
      const offline = yield* signedChat(runtime, "Hola", caller);
      expect(offline.status).toBe(503);
      yield* native(() => offline.arrayBuffer());
      expect(
        yield* native(() => directory.exec("SELECT count(*) AS n FROM whatsapp_invitations"))
      ).toEqual([{ n: 0 }]);
    })
  );
  test.effect(
    "holds an ambiguous invitation send until its original expiry and removes stale unbound chat evidence in bounded work",
    () =>
      Effect.gen(function* () {
        const runtime = yield* (yield* nativeBrowserPlatform)();
        const source = "CO.Uncertain";

        const first = yield* chatWith(runtime, {
          text: "Hola",
          caller: source,
          phone: "573001234598",
        });

        expect(first.status).toBe(503);
        yield* native(() => first.arrayBuffer());

        const repeat = yield* chatWith(runtime, {
          text: "Hola",
          caller: source,
          phone: "573001234598",
        });

        expect(repeat.status).toBe(200);
        yield* native(() => repeat.arrayBuffer());

        const directory = yield* native(() =>
          runtime.unsafeGetDurableObjectStorage("core", "Directory", { name: "directory-v1" })
        );

        expect(
          yield* native(() =>
            directory.exec("SELECT count(*) AS n FROM whatsapp_invitations WHERE bsuid=?", source)
          )
        ).toEqual([{ n: 1 }]);
        yield* native(() =>
          directory.exec("UPDATE whatsapp_invitations SET expires_at_ms=0 WHERE bsuid=?", source)
        );
        yield* invitation(runtime, "CO.Retained");
        expect(
          yield* native(() => directory.exec("SELECT bsuid FROM whatsapp_invitations"))
        ).toEqual([{ bsuid: "CO.Retained" }]);
      })
  );
});
