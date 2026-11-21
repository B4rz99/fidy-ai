import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Array as Arr, Effect, Schema } from "effect";
import { expect } from "vitest";
import { browser } from "../browser-bootstrap.test-fixture";
import { loginMailbox } from "./native-login.test-fixture";
import { alice } from "../financial-user-store.test-fixture";
import { native } from "../user-store.test-fixture";

const deliveredProof = Effect.fn(function* () {
  const setup = yield* loginMailbox("person@example.test");
  const proof = yield* setup.pairing();
  expect((yield* setup.start(proof)).status).toBe(202);

  const code = yield* Schema.decodeUnknownEffect(Schema.String)(
    (yield* setup.delivered)[0]?.split("\n\n")[1]
  );

  const verify = (submitted: string): ReturnType<typeof setup.post> =>
    setup.post("/web/email/authentication/complete", { ...proof, combinedCode: submitted });

  return { ...setup, proof, code, verify };
});

type Delivered = Effect.Success<ReturnType<typeof deliveredProof>>;

const refuseIncorrectVerifiers = (
  post: Delivered["post"]
): ((target: Delivered["proof"]) => Effect.Effect<void>) =>
  Effect.fnUntraced(function* (target) {
    const refused = yield* Effect.forEach(Arr.range(0, 4), () =>
      post("/web/pairings/redeem", { ...target, privateVerifier: "X".repeat(43) })
    );

    expect(refused.map((reply) => [reply.status, reply.headers.get("set-cookie")])).toEqual([
      [400, null],
      [400, null],
      [400, null],
      [400, null],
      [400, null],
    ]);
    expect((yield* post("/web/pairings/redeem", target)).status).toBe(400);
  });

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "five incorrect private verifiers close pending and approved pairings at their respective owners",
    () =>
      Effect.gen(function* () {
        const { runtime, owner, directory, proof, code, verify, post } = yield* deliveredProof();
        expect((yield* verify(code)).status).toBe(200);
        const unbound = yield* browser(runtime).pair;

        yield* Effect.forEach([unbound, proof], refuseIncorrectVerifiers(post), { discard: true });

        expect(
          yield* directory(
            "SELECT wrong_attempts,user_id FROM browser_pairings WHERE id=?",
            unbound.pairingId
          )
        ).toEqual([{ wrong_attempts: 5, user_id: null }]);
        expect(
          yield* owner.exec(
            "SELECT wrong_attempts,state FROM browser_handoffs WHERE pairing_id=?",
            proof.pairingId
          )
        ).toEqual([{ wrong_attempts: 5, state: "invalidated" }]);
        expect(
          yield* owner.exec("SELECT id FROM web_sessions WHERE pairing_id=?", proof.pairingId)
        ).toEqual([]);
      })
  );

  test.effect.each(["RAISE(ABORT,'fixture')", "RAISE(IGNORE)"])(
    "one redemption issues a fresh bearer after a refused session insert using %s",
    (refusal) =>
      Effect.gen(function* () {
        const { runtime, owner, directory, proof, code, verify } = yield* deliveredProof();
        expect((yield* verify(code)).status).toBe(200);
        const { api, headers } = browser(runtime);

        const redeem = (): Effect.Effect<Awaited<ReturnType<typeof runtime.dispatchFetch>>> =>
          native(() =>
            runtime.dispatchFetch(api + "/web/pairings/redeem", {
              method: "POST",
              headers: { ...headers, cookie: "__Host-fidy_session=" + alice.bearer },
              body: JSON.stringify(proof),
            })
          );

        yield* owner.exec(
          "CREATE TRIGGER refuse_session BEFORE INSERT ON web_sessions BEGIN SELECT " +
            refusal +
            "; END"
        );
        const unavailable = yield* redeem();
        expect(unavailable.status).toBe(503);
        expect(unavailable.headers.get("set-cookie")).toBeNull();
        expect(
          yield* owner.exec(
            "SELECT state FROM browser_handoffs WHERE pairing_id=?",
            proof.pairingId
          )
        ).toEqual([{ state: "ready" }]);

        const issued = owner.exec(
          "SELECT id FROM web_sessions WHERE pairing_id=?",
          proof.pairingId
        );

        expect(yield* issued).toEqual([]);
        expect(
          yield* directory(
            "SELECT session_id FROM session_routes WHERE session_id<>?",
            alice.session
          )
        ).toEqual([]);
        yield* owner.exec("DROP TRIGGER refuse_session");
        const replies = yield* Effect.all([redeem(), redeem()], { concurrency: 2 });
        expect(replies.map((reply) => reply.status).sort((left, right) => left - right)).toEqual([
          200, 400,
        ]);

        const cookie =
          replies.find((reply) => reply.status === 200)?.headers.get("set-cookie") ?? "";

        expect(cookie).toContain("Secure; HttpOnly; SameSite=Lax");
        expect(cookie).not.toContain(alice.bearer);

        const session = yield* native(() =>
          runtime.dispatchFetch(api + "/web/session/binding", {
            headers: { ...headers, cookie: cookie.split(";")[0] ?? "" },
          })
        );

        const { binding } = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ binding: Schema.String })
        )(yield* native(() => session.json()));

        expect(binding).not.toBe(alice.session);
        expect(yield* issued).toEqual([{ id: binding }]);
        const replay = yield* redeem();
        expect(replay.status).toBe(400);
        expect(replay.headers.get("set-cookie")).toBeNull();
      })
  );

  test.effect(
    "retains the activated session route after its UserStore commit acknowledgement is lost",
    () =>
      Effect.gen(function* () {
        const { owner, directory, proof, code, verify, post } = yield* deliveredProof();
        expect((yield* verify(code)).status).toBe(200);
        yield* owner.exec("CREATE TABLE lose_session_commit_ack(marker INTEGER)");
        const lost = yield* post("/web/pairings/redeem", proof);
        expect(lost.status).toBe(503);
        expect(lost.headers.get("set-cookie")).toBeNull();

        const [session] = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ id: Schema.String, digest: Schema.String }))
        )(
          yield* owner.exec(
            "SELECT s.id,hex(s.token_digest) AS digest FROM browser_handoffs h JOIN web_sessions s ON s.id=h.claim_id WHERE h.pairing_id=? AND h.state='consumed'",
            proof.pairingId
          )
        );

        if (session === undefined) return yield* Effect.die("Missing committed session");
        expect(
          yield* directory(
            "SELECT session_id AS id,hex(token_digest) AS digest FROM session_routes WHERE session_id=?",
            session.id
          )
        ).toEqual([session]);
        const replay = yield* post("/web/pairings/redeem", proof);
        expect(replay.status).toBe(400);
        expect(replay.headers.get("set-cookie")).toBeNull();
        expect(
          yield* owner.exec("SELECT id FROM web_sessions WHERE pairing_id=?", proof.pairingId)
        ).toEqual([{ id: session.id }]);
      })
  );
  test.effect(
    "cancels only the provisional claim after the Directory loses its registration reply",
    () =>
      Effect.gen(function* () {
        const { owner, directory, proof, code, verify, post } = yield* deliveredProof();
        expect((yield* verify(code)).status).toBe(200);
        yield* directory("CREATE TABLE lose_registration_ack(marker INTEGER)");
        const lost = yield* post("/web/pairings/redeem", proof);
        expect(lost.status).toBe(503);
        expect(lost.headers.get("set-cookie")).toBeNull();
        expect(
          yield* owner.exec(
            "SELECT state,claim_id FROM browser_handoffs WHERE pairing_id=?",
            proof.pairingId
          )
        ).toEqual([{ state: "ready", claim_id: null }]);
        expect(yield* directory("SELECT session_id FROM session_routes")).toEqual([
          { session_id: alice.session },
        ]);
        const retry = yield* post("/web/pairings/redeem", proof);
        expect(retry.status).toBe(200);
        expect(retry.headers.get("set-cookie")).toContain("__Host-fidy_session=");
      })
  );
  test.effect("preserves another User's reservation when a generated session route conflicts", () =>
    Effect.gen(function* () {
      const { owner, directory, proof, code, verify, post } = yield* deliveredProof();
      expect((yield* verify(code)).status).toBe(200);
      yield* directory(
        "CREATE TRIGGER competing_reservation BEFORE INSERT ON session_routes WHEN NEW.reservation_id<>'other' BEGIN INSERT INTO session_routes VALUES(NEW.token_digest,'another-user','another-session','other',NEW.hard_expires_at_ms); END"
      );
      const refused = yield* post("/web/pairings/redeem", proof);
      expect(refused.status).toBe(503);
      expect(refused.headers.get("set-cookie")).toBeNull();
      expect(
        yield* owner.exec(
          "SELECT state,claim_id FROM browser_handoffs WHERE pairing_id=?",
          proof.pairingId
        )
      ).toEqual([{ state: "ready", claim_id: null }]);
      expect(
        yield* directory(
          "SELECT user_id,session_id FROM session_routes WHERE reservation_id='other'"
        )
      ).toEqual([{ user_id: "another-user", session_id: "another-session" }]);
      yield* directory("DROP TRIGGER competing_reservation");
      expect((yield* post("/web/pairings/redeem", proof)).status).toBe(200);
    })
  );

  test.effect.each(["correct", "incorrect"])(
    "the %s mailbox secret reaching its original deadline during hashing leaves the pairing pending",
    (secret) =>
      Effect.gen(function* () {
        const { owner, proof, code, verify, address } = yield* deliveredProof();
        yield* owner.exec("CREATE TABLE hash_deadline(observed_ms INTEGER)");

        const submitted =
          secret === "correct" ? code : code.slice(0, -1) + (code.endsWith("A") ? "B" : "A");

        expect((yield* verify(submitted)).status).toBe(400);
        expect(
          yield* owner.exec(
            "SELECT wrong_attempts,state,expires_at_ms=(SELECT observed_ms FROM hash_deadline) AS reached FROM login_email_proofs WHERE pairing_id=?",
            proof.pairingId
          )
        ).toEqual([{ wrong_attempts: 0, state: "awaiting_proof", reached: 1 }]);
        expect(
          yield* owner.exec(
            "SELECT state FROM browser_handoffs WHERE pairing_id=?",
            proof.pairingId
          )
        ).toEqual([{ state: "pending_approval" }]);
        expect(
          yield* owner.exec("SELECT normalized_address FROM verified_email_credentials")
        ).toEqual([{ normalized_address: address }]);
      })
  );

  test.effect(
    "failed proof consumption rolls back browser approval and allows the same proof to retry",
    () =>
      Effect.gen(function* () {
        const { owner, proof, code, verify, post } = yield* deliveredProof();
        yield* owner.exec(
          "CREATE TRIGGER refuse_evidence BEFORE UPDATE OF state ON login_email_proofs WHEN NEW.state='approved' BEGIN SELECT RAISE(ABORT,'fixture'); END"
        );
        const unavailable = yield* verify(code);
        expect(unavailable.status).toBe(503);
        expect(unavailable.headers.get("set-cookie")).toBeNull();
        expect(
          yield* owner.exec(
            "SELECT wrong_attempts,state,digest IS NOT NULL AS retained FROM login_email_proofs"
          )
        ).toEqual([{ wrong_attempts: 0, state: "awaiting_proof", retained: 1 }]);
        expect(
          yield* owner.exec(
            "SELECT state FROM browser_handoffs WHERE pairing_id=?",
            proof.pairingId
          )
        ).toEqual([{ state: "pending_approval" }]);
        yield* owner.exec("DROP TRIGGER refuse_evidence");
        expect((yield* verify(code)).status).toBe(200);
        expect((yield* verify(code)).status).toBe(400);
        expect((yield* post("/web/pairings/redeem", proof)).status).toBe(200);
      })
  );
});
