import { handoffCancelUrl } from "./contract";
import { browser, signedChat } from "../browser-bootstrap.test-fixture";
import { native, nativeBrowserPlatform } from "../user-store.test-fixture";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Schema } from "effect";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import { browserOrigins, productionTopology } from "../runtime/contract";

import { webSignupDisclosure } from "../../src/shell/consent/operations";
import { ProviderBrowserProof } from "../../src/shell/provider-authentication/contract";

const readBody = (response: Pick<Response, "json">): Effect.Effect<unknown> =>
  native(() => response.json());

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect("starts and polls a browser-private pairing without a User", () =>
    Effect.gen(function* () {
      const create = yield* nativeBrowserPlatform;
      const runtime = yield* create();

      const send = (
        path: string,
        payload: unknown
      ): ReturnType<ReturnType<typeof browser>["post"]> =>
        native(() =>
          runtime.dispatchFetch(`https://${productionTopology.ingress.hostname}${path}`, {
            method: "POST",
            headers: {
              origin: browserOrigins.production,
              "content-type": "application/json",
              "CF-Connecting-IP": "192.0.2.1",
              connection: "close",
            },
            body: JSON.stringify(payload),
          })
        );

      const started = yield* send("/web/pairings", {});
      expect(started.status).toBe(200);

      const proof = yield* Schema.decodeUnknownEffect(ProviderBrowserProof)(
        yield* native(() => started.json())
      );

      const independent = yield* send("/web/pairings", {});

      const unbound = yield* Schema.decodeUnknownEffect(ProviderBrowserProof)(
        yield* native(() => independent.json())
      );

      const pending = yield* send("/web/pairings/redeem", unbound);
      expect(pending.status).toBe(202);
      expect(pending.headers.get("set-cookie")).toBeNull();

      const initiated = yield* send("/web/providers/google/start", {
        ...proof,
        intent: "signup",
        consentRevision: webSignupDisclosure().revision,
      });

      expect(initiated.status).toBe(200);

      const directory = yield* native(() =>
        runtime.unsafeGetDurableObjectStorage("core", "Directory", { name: "directory-v1" })
      );

      yield* native(() =>
        directory.exec(
          "UPDATE provider_attempts SET state='verified',issuer=?,subject=? WHERE pairing_id=?",
          "https://accounts.google.com",
          "example-subject",
          proof.pairingId
        )
      );
      const complete = yield* send("/web/providers/google/complete", proof);
      expect(complete.status).toBe(200);
      expect(complete.headers.get("set-cookie")).toBeNull();
      expect(
        Schema.is(
          Schema.Struct({ status: Schema.Literal("created"), backupRecoveryCode: Schema.String })
        )(yield* native(() => complete.json()))
      ).toBe(true);
      const repeat = yield* send("/web/providers/google/complete", proof);
      expect(yield* native(() => repeat.json())).toEqual({ status: "approved" });

      const sessions = yield* Effect.all(
        [send("/web/pairings/redeem", proof), send("/web/pairings/redeem", proof)],
        { concurrency: 2 }
      );

      expect(
        sessions.map((response) => response.status).sort((left, right) => left - right)
      ).toEqual([200, 400]);

      const cookie =
        sessions
          .find((response) => response.status === 200)
          ?.headers.get("set-cookie")
          ?.split(";")[0] ?? "";

      const mounted = yield* native(() =>
        runtime.dispatchFetch(
          `https://${productionTopology.ingress.hostname}/web/session/binding`,
          { headers: { origin: browserOrigins.production, cookie } }
        )
      );

      expect(mounted.status).toBe(200);

      const { binding } = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ binding: Schema.String })
      )(yield* native(() => mounted.json()));

      const current = yield* native(() =>
        runtime.dispatchFetch(
          `https://${productionTopology.ingress.hostname}/web/session/binding?context=transactions`,
          {
            headers: {
              origin: browserOrigins.production,
              "Fidy-Session-Binding": binding,
              cookie,
              connection: "close",
            },
          }
        )
      );

      expect(yield* native(() => current.json())).toMatchObject({
        binding,
        initial: {
          status: "Granted",
          profile: { data: { serviceMarket: "CO" } },
          transactions: { page: { data: [] } },
        },
      });

      const [registration] = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ user_id: Schema.String }))
      )(
        yield* native(() =>
          directory.exec("SELECT user_id FROM provider_routes WHERE established=1")
        )
      );

      if (registration === undefined) return yield* Effect.die("Missing established User");

      const owner = yield* native(() =>
        runtime.unsafeGetDurableObjectStorage("core", "UserStore", { name: registration.user_id })
      );

      expect(
        yield* native(() =>
          owner.exec(
            "SELECT record_type,operation,session_id FROM audit_entries ORDER BY record_type"
          )
        )
      ).toEqual([
        { record_type: "identity_read", operation: null, session_id: binding },
        {
          record_type: "session_call",
          operation: "transactions.listTransactions",
          session_id: binding,
        },
      ]);
      expect(
        yield* native(() =>
          owner.exec(
            "SELECT lifetime_registered,trial_started_at_ms=created_at_ms AS starts_at_signup,trial_ends_at_ms-trial_started_at_ms AS duration FROM users"
          )
        )
      ).toEqual([{ lifetime_registered: 1, starts_at_signup: 1, duration: 604800000 }]);

      const logout = yield* native(() =>
        runtime.dispatchFetch(`https://${productionTopology.ingress.hostname}/web/session/logout`, {
          method: "POST",
          headers: {
            origin: browserOrigins.production,
            "Fidy-Session-Binding": binding,
            cookie,
            "content-type": "application/json",
            connection: "close",
          },
          body: "{}",
        })
      );

      expect(logout.status).toBe(204);
      yield* native(() => logout.arrayBuffer());

      const mountedAgain = yield* native(() =>
        runtime.dispatchFetch(
          `https://${productionTopology.ingress.hostname}/web/session/binding`,
          { headers: { origin: browserOrigins.production, cookie, connection: "close" } }
        )
      );

      expect(yield* native(() => mountedAgain.json())).toEqual({ binding: null });
    })
  );
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "serializes independently verified first signups, preserves pairing order and consumes each private proof only at its own User",
    () =>
      Effect.gen(function* () {
        const runtime = yield* (yield* nativeBrowserPlatform)();
        const { verified, post } = browser(runtime);
        const older = yield* verified("same-subject");
        const later = yield* verified("same-subject");
        const foreign = yield* verified("different-subject");

        const complete = (proof: typeof ProviderBrowserProof.Type): ReturnType<typeof post> =>
          post("/web/providers/google/complete", proof);

        const replay = (proof: typeof ProviderBrowserProof.Type): ReturnType<typeof post> =>
          post("/web/pairings/redeem", proof);

        const result = yield* Effect.all([complete(older.proof), complete(later.proof)], {
          concurrency: 2,
        });

        const bodies = yield* Effect.forEach(result, readBody);
        expect(
          bodies.filter(Schema.is(Schema.Struct({ status: Schema.Literal("created") })))
        ).toHaveLength(1);
        const retried = yield* complete(later.proof);
        expect(retried.status).toBe(200);
        yield* native(() => retried.arrayBuffer());
        const other = yield* complete(foreign.proof);
        expect(other.status).toBe(200);
        yield* native(() => other.arrayBuffer());

        const refused = yield* replay({
          ...foreign.proof,
          privateVerifier: later.proof.privateVerifier,
        });

        expect(refused.status).toBe(400);
        yield* native(() => refused.arrayBuffer());
        const superseded = yield* replay(older.proof);
        expect(superseded.status).toBe(400);
        yield* native(() => superseded.arrayBuffer());
        const redeemed = yield* replay(later.proof);
        expect(redeemed.status).toBe(200);
        yield* native(() => redeemed.arrayBuffer());
        const expired = yield* replay(later.proof);
        expect(expired.status).toBe(400);
        yield* native(() => expired.arrayBuffer());
      })
  );
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "requires the original authenticated WhatsApp caller and the browser's exact reviewed confirmation before signup",
    () =>
      Effect.gen(function* () {
        const runtime = yield* (yield* nativeBrowserPlatform)();
        const { verified, post } = browser(runtime);
        const caller = "CO.Person1";
        const invitationResponse = yield* signedChat(runtime, "Hola", caller);
        expect(invitationResponse.status).toBe(200);
        yield* native(() => invitationResponse.arrayBuffer());

        const directory = yield* native(() =>
          runtime.unsafeGetDurableObjectStorage("core", "Directory", { name: "directory-v1" })
        );

        const [invitation] = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ id: Schema.String }))
        )(yield* native(() => directory.exec("SELECT id FROM whatsapp_invitations")));

        if (invitation === undefined) return yield* Effect.die("Missing signed invitation");
        const flow = yield* verified("chat-user", invitation.id);

        const review = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ associationCode: Schema.String, confirmationText: Schema.String })
        )(flow.review);

        const submit = (): ReturnType<typeof post> =>
          post("/web/providers/google/complete", {
            ...flow.proof,
            associationCode: review.associationCode,
          });

        expect((yield* submit()).status).toBe(400);
        const extraSpace = yield* signedChat(runtime, " " + review.confirmationText, caller);
        expect(extraSpace.status).toBe(409);
        yield* native(() => extraSpace.arrayBuffer());
        const rejected = yield* signedChat(runtime, review.confirmationText, "CO.Foreign1");
        expect(rejected.status).toBe(409);
        yield* native(() => rejected.arrayBuffer());
        yield* Effect.sleep("1100 millis");
        const accepted = yield* signedChat(runtime, review.confirmationText, caller);
        expect(accepted.status).toBe(200);
        yield* native(() => accepted.arrayBuffer());
        const completed = yield* submit();
        expect(yield* native(() => completed.json())).toMatchObject({
          status: "created",
          whatsappReturnUrl: "https://wa.me/12056871742",
        });
        expect(
          yield* native(() => directory.exec("SELECT established,bsuid FROM whatsapp_routes"))
        ).toEqual([{ established: 1, bsuid: caller }]);
      })
  );
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "fences an exact uncommitted reservation before releasing uniqueness and recovers a committed registration after a lost reply",
    () =>
      Effect.gen(function* () {
        const runtime = yield* (yield* nativeBrowserPlatform)();
        const { verified, post } = browser(runtime);
        const { proof, attempt } = yield* verified("interrupted-subject");

        const directory = yield* native(() =>
          runtime.unsafeGetDurableObjectStorage("core", "Directory", { name: "directory-v1" })
        );

        const owner = yield* native(() => runtime.getDurableObjectNamespace("DIRECTORY", "core"));

        const complete = (): ReturnType<typeof post> =>
          post("/web/providers/google/complete", proof);

        yield* native(() =>
          directory.exec(
            "CREATE TRIGGER lose_recovery BEFORE INSERT ON recovery_routes BEGIN SELECT RAISE(ABORT,'unavailable'); END"
          )
        );
        const interrupted = yield* complete();
        expect(interrupted.status).toBe(503);
        yield* native(() => interrupted.arrayBuffer());

        const [reserved] = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ user_id: Schema.String }))
        )(yield* native(() => directory.exec("SELECT user_id FROM provider_routes")));

        if (reserved === undefined) return yield* Effect.die("Missing reservation");

        const store = yield* native(() =>
          runtime.unsafeGetDurableObjectStorage("core", "UserStore", { name: reserved.user_id })
        );

        expect(yield* native(() => store.exec("SELECT count(*) AS n FROM users"))).toEqual([
          { n: 0 },
        ]);
        const competing = yield* verified("interrupted-subject");
        const blocked = yield* post("/web/providers/google/complete", competing.proof);
        expect(blocked.status).toBe(503);
        yield* native(() => blocked.arrayBuffer());

        const cancel = yield* native(() =>
          owner.getByName("directory-v1").fetch(handoffCancelUrl, { method: "POST", body: attempt })
        );

        expect(yield* native(() => cancel.json())).toEqual({ outcome: "cancelled" });
        yield* native(() => directory.exec("DROP TRIGGER lose_recovery"));
        const late = yield* complete();
        expect(late.status).toBe(400);
        yield* native(() => late.arrayBuffer());
        yield* native(() =>
          directory.exec(
            "CREATE TRIGGER lose_ack BEFORE UPDATE OF established ON provider_routes BEGIN SELECT RAISE(ABORT,'lost'); END"
          )
        );
        const lost = yield* post("/web/providers/google/complete", competing.proof);
        expect(lost.status).toBe(503);
        yield* native(() => lost.arrayBuffer());
        yield* native(() => directory.exec("DROP TRIGGER lose_ack"));

        const outcome = yield* native(() =>
          owner.getByName("directory-v1").fetch(handoffCancelUrl, {
            method: "POST",
            body: competing.attempt,
          })
        );

        expect(yield* native(() => outcome.json())).toEqual({ outcome: "committed" });
        expect(
          yield* native(() =>
            directory.exec(
              "SELECT acknowledged FROM provider_attempts WHERE id=?",
              competing.attempt
            )
          )
        ).toEqual([{ acknowledged: 1 }]);
        const retry = yield* post("/web/providers/google/complete", competing.proof);
        expect(yield* native(() => retry.json())).toEqual({ status: "approved" });
        expect(
          yield* native(() =>
            directory.exec("SELECT count(*) AS n FROM provider_routes WHERE established=1")
          )
        ).toEqual([{ n: 1 }]);
        expect(yield* native(() => store.exec("SELECT count(*) AS n FROM users"))).toEqual([
          { n: 0 },
        ]);
      })
  );
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "serializes a pending completion racing its exact cancellation at the reserved User",
    () =>
      Effect.gen(function* () {
        const runtime = yield* (yield* nativeBrowserPlatform)();
        const { verified, post } = browser(runtime);
        const { proof, attempt } = yield* verified("cancel-race");

        const directory = yield* native(() =>
          runtime.unsafeGetDurableObjectStorage("core", "Directory", { name: "directory-v1" })
        );

        const ns = yield* native(() => runtime.getDurableObjectNamespace("DIRECTORY", "core"));
        yield* native(() =>
          directory.exec(
            "CREATE TRIGGER hold BEFORE INSERT ON recovery_routes BEGIN SELECT RAISE(ABORT,'park'); END"
          )
        );
        const parked = yield* post("/web/providers/google/complete", proof);
        expect(parked.status).toBe(503);
        yield* native(() => parked.arrayBuffer());

        const [owner] = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ user_id: Schema.String }))
        )(yield* native(() => directory.exec("SELECT user_id FROM provider_routes")));

        if (owner === undefined) return yield* Effect.die("Missing reservation");
        const users = yield* native(() => runtime.getDurableObjectNamespace("USER_STORE", "core"));

        const foreign = yield* native(() =>
          users
            .getByName("10000000-0000-4000-8000-000000000099")
            .fetch("https://user.invalid/bootstrap/complete", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ ...proof, id: attempt }),
            })
        );

        expect(foreign.status).toBe(400);
        yield* native(() => foreign.arrayBuffer());
        yield* native(() => directory.exec("DROP TRIGGER hold"));

        const [completion, cancellation] = yield* Effect.all(
          [
            post("/web/providers/google/complete", proof),
            native(() =>
              ns
                .getByName("directory-v1")
                .fetch(handoffCancelUrl, { method: "POST", body: attempt })
            ),
          ],
          { concurrency: 2 }
        );

        const terminal = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ outcome: Schema.Literals(["committed", "cancelled"]) })
        )(yield* native(() => cancellation.json()));

        yield* native(() => completion.arrayBuffer());

        const local = yield* native(() =>
          runtime.unsafeGetDurableObjectStorage("core", "UserStore", { name: owner.user_id })
        );

        const active = terminal.outcome === "committed";
        expect(yield* native(() => local.exec("SELECT outcome FROM browser_handoffs"))).toEqual([
          terminal,
        ]);
        expect(yield* native(() => local.exec("SELECT count(*) AS n FROM users"))).toEqual([
          { n: active ? 1 : 0 },
        ]);
        const retry = yield* post("/web/providers/google/complete", proof);
        expect(retry.status).toBe(active ? 200 : 400);
        yield* native(() => retry.arrayBuffer());
        expect(
          yield* native(() => directory.exec("SELECT count(*) AS n FROM provider_routes"))
        ).toEqual([{ n: active ? 1 : 0 }]);
      })
  );
});
