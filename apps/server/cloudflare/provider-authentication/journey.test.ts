import { afterAll, afterEach, expect, it, vi } from "vitest";
import { type Cause, Effect, Schema } from "effect";
import {
  type Journey,
  delayedProviderTokenResponse,
  disposeJourneys,
  setup,
} from "./journey.test-fixture";

afterAll(disposeJourneys);
afterEach(() => vi.restoreAllMocks());
const Json = Schema.fromJsonString(Schema.Unknown);
const Pairing = Schema.Struct({ pairingId: Schema.String, privateVerifier: Schema.String });
const Started = Schema.Struct({ authorizationUrl: Schema.String });

it("requires the initiating browser proof and current explicit Consent before Google signup", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { send, pairing } = yield* Effect.tryPromise(setup);
      const disclosure = yield* Effect.tryPromise(() => send("/web/providers/disclosure"));
      expect(disclosure.status).toBe(200);
      const current = yield* Schema.decodeUnknownEffect(Schema.Struct({ revision: Schema.String }))(
        yield* Effect.tryPromise(() => disclosure.json())
      );
      const stale = yield* Effect.tryPromise(() =>
        send("/web/providers/google/start", {
          ...pairing,
          intent: "signup",
          consentRevision: "stale",
        })
      );
      expect(stale.status).toBe(400);
      const wrong = yield* Effect.tryPromise(() =>
        send("/web/providers/google/start", {
          ...pairing,
          privateVerifier: "b".repeat(43),
          intent: "signup",
          consentRevision: current.revision,
        })
      );
      expect(wrong.status).toBe(400);
      const started = yield* Effect.tryPromise(() =>
        send("/web/providers/google/start", {
          ...pairing,
          intent: "signup",
          consentRevision: current.revision,
        })
      );
      expect(started.status).toBe(200);
      const result = yield* Schema.decodeUnknownEffect(Started)(
        yield* Effect.tryPromise(() => started.json())
      );
      const authorization = new URL(result.authorizationUrl);
      expect(authorization.origin).toBe("https://accounts.google.com");
      expect(authorization.searchParams.get("scope")).toBe("openid email");
      expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
      expect(started.headers.get("set-cookie")).toContain("HttpOnly; Secure; SameSite=Lax");
    })
  ));

it("creates a Google User without WhatsApp or mailbox proof, discloses recovery once and uses Browser Login for the session", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { send, pairing } = yield* Effect.tryPromise(setup);
      const disclosureResponse = yield* Effect.tryPromise(() => send("/web/providers/disclosure"));
      const disclosure = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ revision: Schema.String })
      )(yield* Effect.tryPromise(() => disclosureResponse.json()));
      const start = yield* Effect.tryPromise(() =>
        send("/web/providers/google/start", {
          ...pairing,
          intent: "signup",
          consentRevision: disclosure.revision,
        })
      );
      const authorize = new URL(
        (yield* Schema.decodeUnknownEffect(Started)(yield* Effect.tryPromise(() => start.json())))
          .authorizationUrl
      );
      const cookie = start.headers.get("set-cookie")?.split(";")[0] ?? "";
      const { generateKeyPair, exportJWK, SignJWT } = yield* Effect.tryPromise(
        () => import("jose")
      );
      const keys = yield* Effect.tryPromise(() => generateKeyPair("RS256"));
      const jwk = yield* Effect.tryPromise(() => exportJWK(keys.publicKey));
      const token = yield* Effect.tryPromise(() =>
        new SignJWT({ nonce: authorize.searchParams.get("nonce"), email: "contact@example.test" })
          .setProtectedHeader({ alg: "RS256", kid: "test" })
          .setIssuer("https://accounts.google.com")
          .setSubject("google-user-1")
          .setAudience("test-client")
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(keys.privateKey)
      );
      vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url === "https://oauth2.googleapis.com/token") {
          return delayedProviderTokenResponse({ token, key: keys.privateKey });
        }
        if (url === "https://www.googleapis.com/oauth2/v3/certs") {
          return Promise.resolve(Response.json({ keys: [{ ...jwk, kid: "test", alg: "RS256" }] }));
        }
        return Promise.reject(new Error("Unexpected provider destination"));
      });
      const callback = yield* Effect.tryPromise(() =>
        send(
          `/providers/google/callback?state=${authorize.searchParams.get("state")}&code=synthetic-code`,
          undefined,
          { cookie }
        )
      );
      expect(callback.status).toBe(303);
      expect(callback.headers.get("location")).toBe("https://app.fidyapp.com/auth/google-return");
      const completion = yield* Effect.tryPromise(() =>
        send("/web/providers/google/complete", pairing)
      );
      expect(completion.status).toBe(200);
      expect(completion.headers.get("set-cookie")).toBeNull();
      const created = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ status: Schema.Literal("created"), backupRecoveryCode: Schema.String })
      )(yield* Effect.tryPromise(() => completion.json()));
      expect(created.backupRecoveryCode.length).toBeGreaterThan(20);
      expect(
        (yield* Effect.tryPromise(() => send("/web/providers/google/complete", pairing))).status
      ).toBe(400);
      const session = yield* Effect.tryPromise(() => send("/web/pairings/redeem", pairing));
      expect(session.status).toBe(200);
      expect(session.headers.get("set-cookie")).toContain("__Host-fidy_session=");
    })
  ));

type ProviderFixture = Partial<
  Readonly<{
    intent: "signup" | "login";
    subject: string;
    email: string;
    issuer: string;
    audience: string;
    nonce: string;
    expiry: number;
    invalidSignature: boolean;
    deny: boolean;
    signingKeyAborted: () => void;
  }>
>;
const authenticate = (
  journey: Journey,
  pairing: typeof Pairing.Type,
  fixture: ProviderFixture = {}
): Effect.Effect<Response, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const disclosure = yield* Effect.tryPromise(() => journey.send("/web/providers/disclosure"));
    const revision = yield* Schema.decodeUnknownEffect(Schema.Struct({ revision: Schema.String }))(
      yield* Effect.tryPromise(() => disclosure.json())
    );
    const start = yield* Effect.tryPromise(() =>
      journey.send("/web/providers/google/start", {
        ...pairing,
        intent: fixture.intent ?? "signup",
        consentRevision: revision.revision,
      })
    );
    const authorization = new URL(
      (yield* Schema.decodeUnknownEffect(Started)(yield* Effect.tryPromise(() => start.json())))
        .authorizationUrl
    );
    const cookie = start.headers.get("set-cookie")?.split(";")[0] ?? "";
    const { generateKeyPair, exportJWK, SignJWT } = yield* Effect.tryPromise(() => import("jose"));
    const keys = yield* Effect.tryPromise(() => generateKeyPair("RS256"));
    const jwk = yield* Effect.tryPromise(() => exportJWK(keys.publicKey));
    const signing =
      fixture.invalidSignature === true
        ? (yield* Effect.tryPromise(() => generateKeyPair("RS256"))).privateKey
        : keys.privateKey;
    const token = yield* Effect.tryPromise(() =>
      new SignJWT({
        nonce: fixture.nonce ?? authorization.searchParams.get("nonce"),
        ...(fixture.email === undefined ? {} : { email: fixture.email }),
      })
        .setProtectedHeader({ alg: "RS256", kid: "test" })
        .setIssuer(fixture.issuer ?? "https://accounts.google.com")
        .setSubject(fixture.subject ?? "stable-google-user")
        .setAudience(fixture.audience ?? "test-client")
        .setIssuedAt()
        .setExpirationTime(fixture.expiry ?? "5m")
        .sign(signing)
    );
    const context = yield* Effect.context<never>();
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === "https://oauth2.googleapis.com/token") {
        return Promise.resolve(Response.json({ id_token: token }));
      }
      if (url === "https://www.googleapis.com/oauth2/v3/certs") {
        if (fixture.signingKeyAborted !== undefined) {
          return Effect.runPromiseWith(context)(
            Effect.never.pipe(
              Effect.onInterrupt(() => Effect.sync(() => fixture.signingKeyAborted?.()))
            ),
            { signal: input instanceof Request ? input.signal : (init?.signal ?? undefined) }
          );
        }
        return Promise.resolve(Response.json({ keys: [{ ...jwk, kid: "test", alg: "RS256" }] }));
      }
      return Promise.reject(new Error("Unexpected provider destination"));
    });
    const callbackPath = `/providers/google/callback?state=${authorization.searchParams.get("state")}&${fixture.deny === true ? "error=access_denied" : "code=synthetic-code"}`;
    const callback = yield* Effect.tryPromise(() =>
      journey.send(callbackPath, undefined, { cookie })
    );
    expect(callback.status).toBe(303);
    expect(callback.headers.get("referrer-policy")).toBe("no-referrer");
    expect(
      (yield* Effect.tryPromise(() => journey.send(callbackPath, undefined, { cookie }))).status
    ).toBe(303);
    if (
      Object.keys(fixture).every(
        (key) => key === "email" || key === "subject" || key === "intent"
      ) &&
      fixture.subject !== ""
    ) {
      expect(
        yield* Effect.tryPromise(() =>
          journey.db
            .prepare("SELECT state FROM provider_authentication_attempts WHERE pairing_id=?")
            .bind(pairing.pairingId)
            .first<string>("state")
        )
      ).toBe("verified");
    }
    return yield* Effect.tryPromise(() => journey.send("/web/providers/google/complete", pairing));
  });
const nextPairing = (
  journey: Journey
): Effect.Effect<typeof Pairing.Type, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise(() => journey.send("/web/pairings", {}));
    return yield* Schema.decodeUnknownEffect(Pairing)(
      yield* Effect.tryPromise(() => response.json())
    );
  });
const countRows = (db: D1Database, table: string): Effect.Effect<number, Cause.UnknownError> =>
  Effect.tryPromise(() =>
    db.prepare(`SELECT count(*) AS count FROM ${table}`).first<number>("count")
  ).pipe(Effect.map((value) => value ?? 0));

it("preserves stable Google ownership across changed/missing emails and never merges another subject with the same contact email", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const journey = yield* Effect.tryPromise(setup);
      expect(
        (yield* authenticate(journey, journey.pairing, { email: "same@example.test" })).status
      ).toBe(200);
      const original = yield* Effect.tryPromise(() =>
        journey.db
          .prepare("SELECT user_id FROM provider_credentials WHERE subject='stable-google-user'")
          .first<string>("user_id")
      );
      for (const email of ["changed@example.test", undefined]) {
        const pairing = yield* nextPairing(journey);
        const response = yield* authenticate(
          journey,
          pairing,
          email === undefined
            ? { intent: "login", issuer: "accounts.google.com" }
            : { email, intent: "login" }
        );
        expect(yield* Effect.tryPromise(() => response.json())).toEqual({ status: "approved" });
        expect(
          (yield* Effect.tryPromise(() => journey.send("/web/pairings/redeem", pairing))).status
        ).toBe(200);
      }
      const other = yield* nextPairing(journey);
      expect(
        (yield* authenticate(journey, other, {
          subject: "another-subject",
          email: "same@example.test",
        })).status
      ).toBe(200);
      expect(yield* countRows(journey.db, "users")).toBe(2);
      expect(yield* countRows(journey.db, "trial_periods")).toBe(2);
      expect(yield* countRows(journey.db, "whatsapp_identities")).toBe(0);
      expect(yield* countRows(journey.db, "verified_email_credentials")).toBe(0);
      expect(
        yield* Effect.tryPromise(() =>
          journey.db
            .prepare("SELECT user_id FROM provider_credentials WHERE subject='stable-google-user'")
            .first<string>("user_id")
        )
      ).toBe(original);
    })
  ));

for (const fixture of [
  { nonce: "wrong" },
  { audience: "other-client" },
  { issuer: "https://attacker.example" },
  { expiry: 1 },
  { invalidSignature: true },
  { deny: true },
  { subject: "" },
]) {
  it(`refuses provider ${JSON.stringify(fixture)} without stable owner state or a usable session`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const journey = yield* Effect.tryPromise(setup);
        expect((yield* authenticate(journey, journey.pairing, fixture)).status).toBe(400);
        expect(yield* countRows(journey.db, "users")).toBe(0);
        expect(yield* countRows(journey.db, "provider_credentials")).toBe(0);
        expect(
          (yield* Effect.tryPromise(() => journey.send("/web/pairings/redeem", journey.pairing)))
            .status
        ).toBe(202);
      })
    ));
}

it("rolls back every new owner record when the origin guard fails, and concurrent completion discloses recovery once", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const journey = yield* Effect.tryPromise(setup);
      yield* Effect.tryPromise(() =>
        journey.db
          .prepare(
            "CREATE TRIGGER refuse_provider BEFORE INSERT ON completed_provider_authentications BEGIN SELECT RAISE(ABORT,'fixture_rollback'); END"
          )
          .run()
      );
      expect((yield* authenticate(journey, journey.pairing)).status).toBe(400);
      for (const table of [
        "users",
        "provider_credentials",
        "trial_periods",
        "backup_recovery_credentials",
        "onboarding_consent_records",
      ]) {
        expect(yield* countRows(journey.db, table)).toBe(0);
      }
      yield* Effect.tryPromise(() => journey.db.prepare("DROP TRIGGER refuse_provider").run());
      const results = yield* Effect.tryPromise(() =>
        Promise.all([
          journey.send("/web/providers/google/complete", journey.pairing),
          journey.send("/web/providers/google/complete", journey.pairing),
        ])
      );
      expect(results.map((result) => result.status).sort((left, right) => left - right)).toEqual([
        200, 400,
      ]);
      expect(yield* countRows(journey.db, "users")).toBe(1);
      expect(
        (yield* Effect.tryPromise(() =>
          journey.send("/web/providers/google/complete", journey.pairing)
        )).status
      ).toBe(400);
    })
  ));

it("keeps configured Google credentials and protocol proofs out of exported diagnostics", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const journey = yield* Effect.tryPromise(setup);
      expect((yield* authenticate(journey, journey.pairing)).status).toBe(200);
      const diagnostics = yield* Schema.encodeEffect(Json)(logs.mock.calls);
      for (const secret of [
        "test-secret",
        "synthetic-code",
        journey.pairing.privateVerifier,
        "stable-google-user",
      ]) {
        expect(diagnostics).not.toContain(secret);
      }
    })
  ));

it("refuses state, cookie, browser substitution, and expired attempts before any owner commit", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const journey = yield* Effect.tryPromise(setup);
      const disclosure = yield* Effect.tryPromise(() => journey.send("/web/providers/disclosure"));
      const current = yield* Schema.decodeUnknownEffect(Schema.Struct({ revision: Schema.String }))(
        yield* Effect.tryPromise(() => disclosure.json())
      );
      const started = yield* Effect.tryPromise(() =>
        journey.send("/web/providers/google/start", {
          ...journey.pairing,
          intent: "signup",
          consentRevision: current.revision,
        })
      );
      const authorization = new URL(
        (yield* Schema.decodeUnknownEffect(Started)(yield* Effect.tryPromise(() => started.json())))
          .authorizationUrl
      );
      const cookie = started.headers.get("set-cookie")?.split(";")[0] ?? "";
      const callback = `/providers/google/callback?state=${authorization.searchParams.get("state")}&code=synthetic-code`;
      expect((yield* Effect.tryPromise(() => journey.send(callback))).status).toBe(303);
      expect(
        (yield* Effect.tryPromise(() =>
          journey.send(callback, undefined, { cookie: "__Host-fidy_google=" + "x".repeat(43) })
        )).status
      ).toBe(303);
      expect(
        (yield* Effect.tryPromise(() =>
          journey.send(
            `/providers/google/callback?state=${"x".repeat(43)}&code=synthetic-code`,
            undefined,
            { cookie }
          )
        )).status
      ).toBe(303);
      const other = yield* nextPairing(journey);
      expect(
        (yield* Effect.tryPromise(() =>
          journey.send("/web/providers/google/complete", {
            pairingId: journey.pairing.pairingId,
            privateVerifier: other.privateVerifier,
          })
        )).status
      ).toBe(400);
      yield* Effect.tryPromise(() =>
        journey.db
          .prepare(
            "UPDATE provider_authentication_attempts SET expires_at_ms=created_at_ms WHERE pairing_id=?"
          )
          .bind(journey.pairing.pairingId)
          .run()
      );
      expect(
        (yield* Effect.tryPromise(() => journey.send(callback, undefined, { cookie }))).status
      ).toBe(303);
      const refused = yield* Effect.tryPromise(() => journey.send(callback, undefined, { cookie }));
      expect(refused.headers.get("location")).toBe("https://app.fidyapp.com/auth/google-return");
      expect(refused.headers.get("set-cookie")).toBeNull();
      expect(
        (yield* Effect.tryPromise(() =>
          journey.send("/web/providers/google/complete", journey.pairing)
        )).status
      ).toBe(400);
      expect(yield* countRows(journey.db, "users")).toBe(0);
    })
  ));

it("an expired abandoned or completed Google attempt never blocks unrelated Browser Login", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const journey = yield* Effect.tryPromise(setup);
      const disclosure = yield* Effect.tryPromise(() => journey.send("/web/providers/disclosure"));
      const { revision } = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ revision: Schema.String })
      )(yield* Effect.tryPromise(() => disclosure.json()));
      expect(
        (yield* Effect.tryPromise(() =>
          journey.send("/web/providers/google/start", {
            ...journey.pairing,
            intent: "signup",
            consentRevision: revision,
          })
        )).status
      ).toBe(200);
      yield* Effect.tryPromise(() =>
        journey.db
          .prepare(
            "UPDATE browser_login_pairings SET created_at_ms=-600001,expires_at_ms=-1 WHERE id=?"
          )
          .bind(journey.pairing.pairingId)
          .run()
      );
      expect((yield* Effect.tryPromise(() => journey.send("/web/pairings", {}))).status).toBe(200);
      const completedPairing = yield* nextPairing(journey);
      expect((yield* authenticate(journey, completedPairing)).status).toBe(200);
      yield* Effect.tryPromise(() =>
        journey.db
          .prepare(
            "UPDATE browser_login_pairings SET created_at_ms=-600001,expires_at_ms=-1 WHERE id=?"
          )
          .bind(completedPairing.pairingId)
          .run()
      );
      expect((yield* Effect.tryPromise(() => journey.send("/web/pairings", {}))).status).toBe(200);
      expect(yield* countRows(journey.db, "provider_credentials")).toBe(1);
      expect(yield* countRows(journey.db, "onboarding_consent_records")).toBe(1);
    })
  ));

it("aborts a stalled Google signing-key request before returning refusal, without owner records", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const journey = yield* Effect.tryPromise(setup);
      let aborted = false;
      const result = yield* authenticate(journey, journey.pairing, {
        signingKeyAborted: () => {
          aborted = true;
        },
      });
      expect(result.status).toBe(400);
      expect(aborted).toBe(true);
      expect(yield* countRows(journey.db, "users")).toBe(0);
      expect(
        (yield* Effect.tryPromise(() => journey.send("/web/pairings/redeem", journey.pairing)))
          .status
      ).toBe(202);
    })
  ));
