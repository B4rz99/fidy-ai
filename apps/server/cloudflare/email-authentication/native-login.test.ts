import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { expect } from "vitest";
import { native } from "../user-store.test-fixture";
import { alice, bob, seed } from "../financial-user-store.test-fixture";

import { NativeLoginEmailWork } from "./contract";
import { loginMailbox as setup } from "./native-login.test-fixture";

const interruptClaim = Effect.fn(function* (
  owner: Effect.Success<ReturnType<typeof setup>>["owner"],
  outcome: string
) {
  if (outcome === "settlement") {
    yield* owner.exec(
      "CREATE TRIGGER interrupt_settlement BEFORE UPDATE ON login_email_proofs WHEN OLD.state='sending' AND NEW.state='awaiting_proof' BEGIN SELECT RAISE(ABORT,'fixture'); END"
    );
  }

  if (outcome === "revoked-after-claim") {
    yield* owner.exec(
      "CREATE TRIGGER revoke_after_claim AFTER UPDATE ON login_email_proofs WHEN NEW.state='sending' BEGIN UPDATE verified_email_credentials SET revision=revision+1; END"
    );
  }
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect("a mailbox revoked while awaiting allowance cannot charge the local window", () =>
    Effect.gen(function* () {
      const { owner, start, pairing, directory, inbox } = yield* setup(
        "revoked-during-allowance@example.test"
      );

      yield* directory("CREATE TABLE revoke_on_allowance(user_id TEXT)");
      yield* directory("INSERT INTO revoke_on_allowance VALUES(?)", alice.user);
      expect((yield* start(yield* pairing())).status).toBe(202);
      expect(yield* owner.exec("SELECT revision FROM verified_email_credentials")).toEqual([
        { revision: 2 },
      ]);
      expect(yield* owner.exec("SELECT used FROM login_email_window")).toEqual([]);
      expect(yield* owner.exec("SELECT state FROM login_email_proofs")).toEqual([]);
      expect(yield* directory("SELECT used FROM login_email_window")).toEqual([{ used: 1 }]);
      expect(yield* inbox()).toEqual([]);
    })
  );
  test.effect("only the latest generation can approve its original pairing", () =>
    Effect.gen(function* () {
      const { owner, start, pairing, post, deliver, work, inbox, hold } =
        yield* setup("resend@example.test");

      yield* hold;
      const proof = yield* pairing();
      yield* start(proof);
      const first = yield* work();
      yield* deliver(first);
      yield* owner.exec("UPDATE login_email_proofs SET requested_at_ms=requested_at_ms-61000");
      yield* start(proof);
      const next = yield* work();
      expect(first.id).not.toBe(next.id);
      yield* deliver(first);
      yield* deliver(next);
      const messages = yield* inbox();
      expect(messages).toHaveLength(2);

      const verify = (letter: string): ReturnType<typeof post> =>
        post("/web/email/authentication/complete", {
          ...proof,
          combinedCode: letter.split("\n\n")[1],
        });

      expect((yield* verify(messages[0] ?? "")).status).toBe(400);
      expect((yield* verify(messages[1] ?? "")).status).toBe(200);
    })
  );
  test.effect(
    "a stale Directory mapping cannot bind a browser pairing or spend either window",
    () =>
      Effect.gen(function* () {
        const { owner, start, pairing, directory } = yield* setup("stale@example.test");
        const proof = yield* pairing();
        yield* owner.exec("UPDATE verified_email_credentials SET revision=2");
        expect((yield* start(proof)).status).toBe(202);
        expect(
          yield* directory("SELECT user_id FROM browser_pairings WHERE id=?", proof.pairingId)
        ).toEqual([{ user_id: null }]);
        expect(yield* directory("SELECT used FROM login_email_window")).toEqual([]);
      })
  );
  test.effect(
    "a lost shared reply permits no send or local charge; retry spends another allowance",
    () =>
      Effect.gen(function* () {
        const { owner, start, pairing, directory, inbox, delivered } =
          yield* setup("uncertain@example.test");

        yield* directory("CREATE TABLE lose_next_allowance(id INTEGER)");
        const proof = yield* pairing();
        expect((yield* start(proof)).status).toBe(503);
        expect(yield* directory("SELECT used FROM login_email_window")).toEqual([{ used: 1 }]);
        expect(yield* owner.exec("SELECT used FROM login_email_window")).toEqual([]);
        expect(yield* owner.exec("SELECT state FROM login_email_proofs")).toEqual([]);
        expect(yield* inbox()).toEqual([]);
        expect((yield* start(proof)).status).toBe(202);
        expect(yield* directory("SELECT used FROM login_email_window")).toEqual([{ used: 2 }]);
        expect(yield* delivered).toHaveLength(1);
      })
  );
  test.effect(
    "parallel pairings share five local admissions after deletion and a separate Directory deadline",
    () =>
      Effect.gen(function* () {
        const { owner, start, pairing, directory, hold } = yield* setup("limits@example.test");
        yield* hold;

        const proofs = yield* Effect.all(
          Array.from({ length: 8 }, () => pairing()),
          { concurrency: 8 }
        );

        const requests = yield* Effect.forEach(proofs, (proof) => start(proof), { concurrency: 8 });
        expect(requests.every((reply) => reply.status === 202)).toBe(true);
        expect(yield* owner.exec("SELECT used FROM login_email_window")).toEqual([{ used: 5 }]);
        expect(yield* owner.exec("SELECT count(*) AS count FROM login_email_proofs")).toEqual([
          { count: 5 },
        ]);
        yield* owner.exec("DELETE FROM browser_handoffs");
        const reset = owner.now + 100000;
        yield* directory("UPDATE login_email_window SET reset_at_ms=?,used=999", reset);
        yield* start(yield* pairing());
        expect(yield* directory("SELECT used FROM login_email_window")).toEqual([{ used: 999 }]);
        yield* owner.exec("UPDATE login_email_window SET reset_at_ms=0");
        const final = yield* Effect.all([pairing(), pairing()], { concurrency: 2 });
        yield* Effect.forEach(final, (proof) => start(proof), { concurrency: 2 });
        expect(yield* directory("SELECT reset_at_ms,used FROM login_email_window")).toEqual([
          { reset_at_ms: reset, used: 1000 },
        ]);
        expect(yield* owner.exec("SELECT used FROM login_email_window")).toEqual([{ used: 1 }]);
        yield* directory("UPDATE login_email_window SET reset_at_ms=0");
        const local = yield* owner.exec("SELECT reset_at_ms FROM login_email_window");
        yield* start(yield* pairing());
        expect(yield* owner.exec("SELECT reset_at_ms FROM login_email_window")).toEqual(local);
        expect(yield* owner.exec("SELECT used FROM login_email_window")).toEqual([{ used: 2 }]);
        expect(yield* directory("SELECT used FROM login_email_window")).toEqual([{ used: 1 }]);
      })
  );
  test.effect(
    "a refused intent rolls back the User charge and retains the spent shared allowance",
    () =>
      Effect.gen(function* () {
        const { owner, start, pairing, directory } = yield* setup("rollback@example.test");
        yield* owner.exec(
          "CREATE TRIGGER refuse_work BEFORE INSERT ON login_email_proofs BEGIN SELECT RAISE(IGNORE); END"
        );
        expect((yield* start(yield* pairing())).status).toBe(503);
        expect(yield* owner.exec("SELECT used FROM login_email_window")).toEqual([]);
        expect(yield* directory("SELECT used FROM login_email_window")).toEqual([{ used: 1 }]);
      })
  );

  test.effect.each(["mailbox", "pairing", "expiry", "work deadline", "erase"] as const)(
    "rechecks %s immediately before the one-shot claim",
    (change) =>
      Effect.gen(function* () {
        const { owner, start, pairing, work, deliver, inbox, hold } =
          yield* setup("revoked@example.test");

        yield* hold;
        yield* start(yield* pairing());
        const identity = yield* work();

        const mutations = {
          mailbox: "UPDATE verified_email_credentials SET revision=revision+1",
          pairing: "UPDATE browser_handoffs SET state='invalidated'",
          expiry: "UPDATE browser_handoffs SET expires_at_ms=0",
          "work deadline": "UPDATE login_email_proofs SET expires_at_ms=0",
          erase:
            "INSERT INTO erasure_requests(id,user_id,state) SELECT 'erase',id,'pending' FROM users",
        };

        yield* owner.exec(mutations[change]);
        expect(yield* deliver(identity)).toBe(204);
        expect(yield* deliver(identity)).toBe(204);
        expect(yield* inbox()).toEqual([]);

        const expired = change === "expiry" || change === "work deadline";

        expect(
          yield* owner.exec(
            expired
              ? "SELECT count(*) AS usable FROM login_email_proofs WHERE state <> 'rejected' OR selector IS NOT NULL OR digest IS NOT NULL"
              : "SELECT state FROM login_email_proofs"
          )
        ).toEqual(expired ? [{ usable: 0 }] : [{ state: "rejected" }]);
      })
  );

  test.effect.each(["accepted", "lost", "limited", "settlement", "revoked-after-claim"] as const)(
    "keeps duplicate delivery secret-free and one-shot after %s",
    (outcome) =>
      Effect.gen(function* () {
        const { owner, start, pairing, hold, work, deliver, inbox, logs, post, address } =
          yield* setup(outcome + "@example.test");

        yield* hold;
        const proof = yield* pairing();
        yield* start(proof);
        const identity = yield* work();
        yield* interruptClaim(owner, outcome);

        const claims = yield* Effect.all([deliver(identity), deliver(identity)], {
          concurrency: 2,
        });

        expect(claims.filter((status) => status === 503)).toHaveLength(
          outcome === "settlement" ? 1 : 0
        );
        yield* deliver(identity);
        const messages = yield* inbox();
        expect(messages).toHaveLength(1);

        const code = yield* Schema.decodeUnknownEffect(Schema.String)(
          messages[0]?.split("\n\n")[1]
        );

        const state = {
          accepted: "awaiting_proof",
          lost: "ambiguous",
          limited: "rejected",
          settlement: "sending",
          "revoked-after-claim": "awaiting_proof",
        }[outcome];

        expect(yield* owner.exec("SELECT state FROM login_email_proofs")).toEqual([{ state }]);
        const keep = ["accepted", "settlement", "revoked-after-claim"].includes(outcome);
        expect(
          yield* owner.exec("SELECT selector,length(digest) AS bytes FROM login_email_proofs")
        ).toEqual([{ selector: keep ? code.slice(0, 9) : null, bytes: keep ? 32 : null }]);
        expect(
          yield* owner.exec("SELECT normalized_address FROM verified_email_credentials")
        ).toEqual([{ normalized_address: address }]);
        expect(yield* owner.exec("SELECT state FROM browser_handoffs")).toEqual([
          { state: "pending_approval" },
        ]);
        expect(
          (yield* post("/web/email/authentication/complete", { ...proof, combinedCode: code }))
            .status
        ).toBe(outcome === "accepted" ? 200 : 400);

        const retained = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
          yield* owner.exec("SELECT *,hex(digest) AS retained FROM login_email_proofs")
        );

        const encodedIdentity = yield* Schema.encodeEffect(
          Schema.fromJsonString(NativeLoginEmailWork)
        )(identity);

        for (const secret of [code, code.slice(10), proof.privateVerifier]) {
          expect(retained).not.toContain(secret);
          expect(encodedIdentity).not.toContain(secret);
          expect(logs.join(" ")).not.toContain(secret);
        }

        expect(logs.join(" ")).not.toContain(address);
      })
  );

  test.effect("the watchdog reoffers an admitted intent after a missed scheduling hint", () =>
    Effect.gen(function* () {
      const { owner, start, pairing, hold, checkOwner, delivered } = yield* setup(
        "rediscovered@example.test"
      );

      yield* hold;
      yield* start(yield* pairing());
      yield* owner.exec("UPDATE login_email_proofs SET offer_at_ms=0");
      expect(yield* checkOwner).toBe(204);
      expect(yield* delivered).toHaveLength(1);
    })
  );
  test.effect("distinct Users cannot consume each other's mailbox proof or browser verifier", () =>
    Effect.gen(function* () {
      const { runtime, owner, pairing, start, delivered, awaitMail, post } =
        yield* setup("first@example.test");

      const other = yield* seed(runtime, bob, false);
      yield* other.exec(
        "INSERT INTO verified_email_credentials VALUES(?,?,1,?)",
        bob.user,
        "second@example.test",
        owner.now
      );
      yield* native(() =>
        other.directory.exec(
          "INSERT INTO verified_email_routes VALUES(?,?,?,1)",
          "second@example.test",
          bob.user,
          bob.session
        )
      );

      const left = yield* pairing(),
        right = yield* pairing();

      yield* start(left);
      yield* start(right, "second@example.test");
      const first = (yield* delivered)[0]?.split("\n\n")[1];
      const second = (yield* awaitMail("second@example.test"))[0]?.split("\n\n")[1];
      expect(
        (yield* post("/web/email/authentication/complete", { ...left, combinedCode: second }))
          .status
      ).toBe(400);
      expect(
        (yield* post("/web/email/authentication/complete", { ...right, combinedCode: first }))
          .status
      ).toBe(400);
      expect(yield* owner.exec("SELECT wrong_attempts FROM login_email_proofs")).toEqual([
        { wrong_attempts: 0 },
      ]);
      expect(yield* other.exec("SELECT wrong_attempts FROM login_email_proofs")).toEqual([
        { wrong_attempts: 0 },
      ]);
      expect(
        (yield* post("/web/email/authentication/complete", { ...left, combinedCode: first })).status
      ).toBe(200);
      expect(
        (yield* post("/web/email/authentication/complete", { ...right, combinedCode: second }))
          .status
      ).toBe(200);
    })
  );
  test.effect("consumes one mailbox proof and redeems only its bound browser pairing", () =>
    Effect.gen(function* () {
      const { start, pairing, delivered, post, owner } = yield* setup("approved@example.test");
      const proof = yield* pairing();
      yield* start(proof);

      const code = yield* Schema.decodeUnknownEffect(Schema.String)(
        (yield* delivered)[0]?.split("\n\n")[1]
      );

      const verify = (
        combinedCode: string,
        privateVerifier = proof.privateVerifier
      ): ReturnType<typeof post> =>
        post("/web/email/authentication/complete", { ...proof, privateVerifier, combinedCode });

      expect((yield* verify(code, "X".repeat(43))).status).toBe(400);
      yield* owner.exec("UPDATE verified_email_credentials SET revision=2");
      expect((yield* verify(code)).status).toBe(400);
      expect((yield* verify(code.slice(0, -1) + (code.endsWith("A") ? "B" : "A"))).status).toBe(
        400
      );
      expect(yield* owner.exec("SELECT wrong_attempts,state FROM login_email_proofs")).toEqual([
        { wrong_attempts: 0, state: "awaiting_proof" },
      ]);
      yield* owner.exec("UPDATE verified_email_credentials SET revision=1");
      const replies = yield* Effect.all([verify(code), verify(code)], { concurrency: 2 });
      expect(replies.map((reply) => reply.status).sort((left, right) => left - right)).toEqual([
        200, 400,
      ]);
      const redeemed = yield* post("/web/pairings/redeem", proof);
      expect(redeemed.status).toBe(200);
      expect(redeemed.headers.get("set-cookie")).toContain("__Host-fidy_session=");
    })
  );
  test.effect("delivers the admitted generation through the Queue and Workflow", () =>
    Effect.gen(function* () {
      const { start, pairing, delivered, work, runtime, inbox } =
        yield* setup("alice@example.test");

      expect((yield* start(yield* pairing())).status).toBe(202);
      expect(yield* delivered).toHaveLength(1);
      const identity = yield* work();

      const bindings = yield* native(() =>
        runtime.getBindings<{ BROWSER_PAIRING_EMAIL_WORKFLOW: Workflow }>("core")
      );

      const instance = yield* native(() =>
        bindings.BROWSER_PAIRING_EMAIL_WORKFLOW.get(identity.id)
      );

      const completed = native(() => instance.status()).pipe(
        Effect.repeat({
          until: (status) => status.status === "complete",
          schedule: Schedule.spaced("50 millis"),
        }),
        Effect.timeout("5 seconds")
      );

      const status = yield* completed;
      expect(status.output ?? null).toBeNull();
      yield* native(() => instance.restart());
      expect((yield* completed).output ?? null).toBeNull();
      expect(yield* inbox()).toHaveLength(1);
    })
  );
  test.effect("admits only pending browser proof for the established mailbox", () =>
    Effect.gen(function* () {
      const { owner, start, pairing } = yield* setup("alice@example.test");
      const proof = yield* pairing();
      expect((yield* start({ ...proof, privateVerifier: "X".repeat(43) })).status).toBe(400);
      const unknown = yield* start(proof, "unknown@example.test");
      expect(unknown.status).toBe(202);
      expect(yield* owner.exec("SELECT work_id FROM login_email_proofs")).toEqual([]);
      const known = yield* start(proof);
      expect(known.status).toBe(unknown.status);
      expect(known.headers.get("cache-control")).toBe("no-store");
      expect(yield* native(() => known.text())).toBe(yield* native(() => unknown.text()));
      expect((yield* start(proof)).status).toBe(202);
      expect(yield* owner.exec("SELECT used FROM login_email_window")).toEqual([{ used: 1 }]);
      expect(
        yield* native(() => owner.directory.exec("SELECT used FROM login_email_window"))
      ).toEqual([{ used: 1 }]);
    })
  );
});
