import { it } from "@effect/vitest";
import { Clock, Effect, Fiber, Redacted } from "effect";
import { installedOrigins } from "@fidy/server/browser-transport";
import { admittedErasureLogins } from "./native-acceptance";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import { type ErasureContinuation, continueAdmittedErasure } from "./native-erasure-continuation";

const original = ["a".repeat(64), "b".repeat(64), "c".repeat(64)];
const target = "d".repeat(64);
const revision = "1".repeat(40);
const userNamespace = "2".repeat(32);
const reference = "00000000-0000-4000-8000-900000000001";
const baseline = new Bun.CryptoHasher("sha256").update(original.join("\n")).digest("hex");
const admitted = {
  revision,
  userNamespace,
  stage: "waiting-physical-erasure",
  checkpoints: [
    { stage: "stable-users", populated: 3 },
    { stage: "signup-created" },
    { stage: "fresh-object", physicalObject: target },
    { stage: "admitted", physicalObject: target, reference },
    { stage: "waiting-physical-erasure", observations: 1, listed: 4, populated: 4 },
  ],
};
const survivors = new Bun.CryptoHasher("sha256").update("one\ntwo").digest("hex");
const retained = new Map(original.map((id) => [id, true] as const));

it.effect("continues the original admitted evidence without a signup or erasure operation", () =>
  Effect.gen(function* () {
    const proof = yield* continueAdmittedErasure({
      checkpoint: admitted,
      revision,
      userNamespace,
      baseline,
      survivors,
      inventory: () => Effect.succeed(retained),
      renew: () => Effect.die("An already erased object needs no work lease"),
      logins: () => Effect.succeed(["one", "two"]),
      record: () => Effect.void,
      refused: () => Effect.succeed("invalid"),
    });
    expect(proof).toMatchObject({
      reference,
      physicalObject: target,
      physicalStateAfter: "absent",
      admissionReplay: "same-reference",
      survivingUsers: 2,
      originalBrowserSessionDenial: "unavailable",
      providerCompletion: "invalid",
      erasedProviderPairing: "pending-then-expired-without-session",
    });
  })
);

it.effect(
  "rejects substituted baseline objects, unrelated admissions and missing replay evidence",
  () =>
    Effect.gen(function* () {
      const options: ErasureContinuation = {
        checkpoint: admitted,
        revision,
        userNamespace,
        baseline,
        survivors,
        inventory: () => Effect.succeed(retained),
        renew: () => Effect.void,
        logins: () => Effect.succeed(["one", "two"]),
        record: () => Effect.void,
      refused: () => Effect.succeed("invalid"),
      };
      const substitutions: Array<Partial<ErasureContinuation>> = [
        { revision: "9".repeat(40) },
        { userNamespace: "9".repeat(32) },
        { checkpoint: { ...admitted, checkpoints: admitted.checkpoints.slice(0, -1) } },
        { baseline: "9".repeat(64) },
        { survivors: "9".repeat(64) },
        { inventory: () => Effect.succeed(new Map([...retained, ["e".repeat(64), true]])) },
        { logins: () => Effect.succeed(["one", "one"]) },
        { refused: () => Effect.fail(Error("Login approved")) },
      ];
      for (const changed of substitutions) {
        expect(yield* Effect.isFailure(continueAdmittedErasure({ ...options, ...changed }))).toBe(
          true
        );
      }
    })
);

it.effect("proves refusal only for the verified erased provider subject at login completion", () =>
  Effect.gen(function* () {
    const origins = installedOrigins.acceptance;
    const verify = (
      status: number,
      body: string,
      providerStatus = "verified"
    ): { driver: ReturnType<typeof admittedErasureLogins>; paths: Array<string> } => {
      const paths: Array<string> = [];
      const expiresAt = "1970-01-01T00:10:00.000Z";
      const driver = admittedErasureLogins({
        revision,
        origins,
        proof: Redacted.make("synthetic-test-proof-".repeat(3)),
        send: Effect.fn(function* (request) {
          const url = new URL(request.url);
          paths.push(url.pathname);
          switch (url.pathname) {
            case "/web/pairings":
              return Response.json({ pairingId: "test-pairing", privateVerifier: "test-verifier", expiresAt });
            case "/web/pairings/redeem": {
              expect(yield* Effect.tryPromise(() => request.json())).toEqual({ pairingId: "test-pairing", privateVerifier: "test-verifier" });
              return (yield* Clock.currentTimeMillis) < Date.parse(expiresAt)
                ? Response.json({status:"pending_approval", expiresAt, pollingIntervalSeconds:5}, {status:202})
                : Response.json({error:{code:"pairing_invalid", message:"Esta vinculación ya no es válida. Inicia de nuevo."}}, {status:400});
            }
            case "/web/providers/google/start": {
              expect(yield* Effect.tryPromise(() => request.json())).toMatchObject({
                intent: "login",
              });
              const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
              auth.searchParams.set("redirect_uri", origins.api + "/providers/google/callback");
              return Response.json(
                { authorizationUrl: auth.toString() },
                {
                  headers: {
                    "set-cookie":
                      "__Host-fidy_google=fixture; Path=/; Secure; HttpOnly; SameSite=Lax",
                  },
                }
              );
            }
            case "/providers/google/callback":
              expect(url.searchParams.get("code")?.split(".")[2]).toBe(
                "fidy-acceptance-" + revision + "-erasure-1"
              );
              return new Response(null, { status: 303 });
            case "/web/providers/google/status":
              return Response.json({ status: providerStatus });
            case "/web/providers/google/complete":
              return Response.json({ status: body }, { status });
            default:
              return yield* Effect.die("Unexpected request");
          }
        }),
      });
      return { driver, paths };
    };
    const accepted = verify(400, "invalid");
    const pending = verify(503, "unavailable");
    const positive = yield* Effect.all([accepted.driver.refused(() => Effect.void), pending.driver.refused(() => Effect.void)], { concurrency:2 }).pipe(Effect.forkChild);
    yield* TestClock.adjust("11 minutes");
    expect(yield* Fiber.join(positive)).toEqual(["invalid","unavailable"]);
    expect(accepted.paths.slice(-2)).toEqual(["/web/pairings/redeem", "/web/pairings/redeem"]);
    for (const result of [
      verify(401, "invalid"),
      verify(200, "approved"),
      verify(400, "invalid", "pending"),
    ]) {
      expect(yield* Effect.isFailure(result.driver.refused(() => Effect.void))).toBe(true);
    }
  })
);

it.effect("retries safe lease renewal and rechecks erasure after authenticating survivors", () =>
  Effect.gen(function* () {
    const stored = new Map<string, boolean>([...retained, [target, true]]);
    let leases = 0,
      reads = 0,
      logins = 0;
    const runner = yield* continueAdmittedErasure({
      checkpoint: admitted,
      revision,
      userNamespace,
      baseline,
      survivors,
      inventory: () => Effect.sync(() => (++reads === 3 ? retained : stored)),
      renew: () =>
        Effect.suspend(() =>
          ++leases === 1 ? Effect.fail(Error("Transport failed")) : Effect.void
        ),
      logins: () =>
        Effect.sync(() => {
          logins++;
          return ["two", "one"];
        }),
      record: () => Effect.void,
      refused: () => Effect.succeed("invalid"),
    }).pipe(Effect.isFailure, Effect.forkChild);
    yield* TestClock.adjust("1 minute");
    expect(yield* Fiber.join(runner)).toBe(true);
    expect(leases).toBe(3);
    expect(logins).toBe(1);
    expect(reads).toBe(4);
  })
);
