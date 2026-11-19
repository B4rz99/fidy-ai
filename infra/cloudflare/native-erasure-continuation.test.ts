import { it } from "@effect/vitest";
import { Effect, Redacted } from "effect";
import { installedOrigins } from "@fidy/server/browser-transport";
import { admittedErasureLogins } from "./native-acceptance";
import { expect } from "vitest";
import { continueAdmittedErasure } from "./native-erasure-continuation";

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
      renew: () => Effect.void,
      logins: () => Effect.succeed(["one", "two"]),
      refused: () => Effect.void,
    });
    expect(proof).toMatchObject({
      reference,
      physicalObject: target,
      physicalStateAfter: "absent",
      admissionReplay: "same-reference",
      survivingUsers: 2,
      originalBrowserSessionDenial: "unavailable",
      erasedProviderLogin: "refused",
    });
  })
);

it.effect(
  "rejects substituted baseline objects, unrelated admissions and missing replay evidence",
  () =>
    Effect.gen(function* () {
      const options = {
        checkpoint: admitted,
        revision,
        userNamespace,
        baseline,
        survivors,
        inventory: () => Effect.succeed(retained),
        renew: () => Effect.void,
        logins: () => Effect.succeed(["one", "two"]),
        refused: () => Effect.void,
      };
      for (const changed of [
        { revision: "9".repeat(40) },
        { userNamespace: "9".repeat(32) },
        { checkpoint: { ...admitted, checkpoints: admitted.checkpoints.slice(0, -1) } },
        { baseline: "9".repeat(64) },
        { survivors: "9".repeat(64) },
        { inventory: () => Effect.succeed(new Map([...retained, ["e".repeat(64), true]])) },
        { logins: () => Effect.succeed(["one", "one"]) },
        { refused: () => Effect.fail(Error("Login approved")) },
      ]) {
        expect(yield* Effect.isFailure(continueAdmittedErasure({ ...options, ...changed }))).toBe(
          true
        );
      }
    })
);

it.effect("proves refusal only for the verified erased provider subject at login completion", () =>
  Effect.gen(function* () {
    const origins = installedOrigins.acceptance;
    const verify = (status: number, body: string, providerStatus = "verified") => {
      const paths: Array<string> = [];
      const driver = admittedErasureLogins({
        revision, origins, proof: Redacted.make("synthetic-test-proof-".repeat(3)),
        send: Effect.fn(function* (request) {
          const url = new URL(request.url);
          paths.push(url.pathname);
          switch (url.pathname) {
            case "/web/pairings":
              return Response.json({ pairingId: "test-pairing", privateVerifier: "test-verifier" });
            case "/web/providers/google/start": {
              expect(yield* Effect.tryPromise(() => request.json())).toMatchObject({ intent: "login" });
              const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
              auth.searchParams.set("redirect_uri", origins.api + "/providers/google/callback");
              return Response.json({ authorizationUrl: auth.toString() }, { headers: {
                "set-cookie": "__Host-fidy_google=fixture; Path=/; Secure; HttpOnly; SameSite=Lax",
              } });
            }
            case "/providers/google/callback":
              expect(url.searchParams.get("code")?.split(".")[2]).toBe("fidy-acceptance-" + revision + "-erasure-1");
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
    yield* accepted.driver.refused();
    expect(accepted.paths.at(-1)).toBe("/web/providers/google/complete");
    for (const result of [verify(401, "invalid"), verify(200, "approved"), verify(400, "invalid", "pending")]) {
      expect(yield* Effect.isFailure(result.driver.refused())).toBe(true);
    }
  })
);
