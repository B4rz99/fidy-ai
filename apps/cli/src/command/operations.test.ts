import { TestClock } from "effect/testing";
import { type LoginDependencies } from "../login/contract";
import { IssuedPAT, StartedPATPairing } from "@fidy/server/client";
import { expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Option, Schema } from "effect";
import { type Credential, SavedGrant, apiOrigin } from "../credential/contract";
import { type CommandDependencies, PublicOutput } from "./contract";
import { formatCommandFailure, formatFailure, formatOutput, runCommand } from "./operations";

const secretLength = 43;
const secret = `fin_abcd1234_${"s".repeat(secretLength)}`;
const issued = Schema.decodeSync(Schema.toCodecJson(IssuedPAT))({
  bearer: secret,
  pat: {
    _tag: "PAT",
    id: "01900000-0000-4000-8000-000000000001",
    shortId: "abcd1234",
    recipientLabel: "Agente\u001b[31m\u009b2J\u007f\u202e",
    scopes: ["read"],
    lifetimeDays: 7,
    lastUsedAt: null,
    revokedAt: null,
    createdAt: "1969-12-20T00:00:00.000Z",
    expiresAt: "1969-12-27T00:00:00.000Z",
  },
});
const saved: Credential = { grant: { origin: apiOrigin, pat: issued.pat }, bearer: issued.bearer };

it.effect(
  "shows local expiry safely in both formats and logout explicitly does not claim revocation",
  () =>
    Effect.gen(function* () {
      let local = Option.some(saved);
      const output: Array<PublicOutput> = [];
      const dependencies: CommandDependencies = {
        verifyStorage: Effect.void,
        pairing: {
          start: () => Effect.die("unexpected network"),
          claim: () => Effect.die("unexpected network"),
        },
        store: {
          load: Effect.suspend(() => Effect.succeed(local)),
          save: () => Effect.die("unexpected save"),
          clear: Effect.sync(() => {
            local = Option.none();
          }),
        },
        readLine: () => Effect.die("unexpected prompt"),
        emit: (event) =>
          Effect.sync(() => {
            output.push(event);
          }),
      };
      yield* runCommand(["status"], dependencies);
      expect(output[0]).toMatchObject({ _tag: "LocalStatus", availability: "expired" });
      for (const event of output) {
        const human = yield* formatOutput(event, false);
        const json = yield* formatOutput(event, true);
        expect(human.includes(secret) || json.includes(secret)).toBe(false);
        expect(human.includes("\u001b") || json.includes("\u001b")).toBe(false);
        expect(/[\u007f-\u009f\u202e]/u.test(human + json)).toBe(false);
      }
      yield* runCommand(["logout"], dependencies);
      expect(Option.isNone(local)).toBe(true);
      const logout = yield* formatOutput({ _tag: "LoggedOut" }, false);
      expect(logout).toContain("NO fue revocado");
    })
);

it.effect("rejects impossible local status representations at the published output seam", () =>
  Effect.gen(function* () {
    const grant = yield* Schema.encodeEffect(Schema.toCodecJson(SavedGrant))(saved.grant);
    const invalid = [
      { _tag: "LocalStatus", availability: "absent", grant },
      { _tag: "LocalStatus", availability: "available", grant: null },
      { _tag: "LocalStatus", availability: "expired", grant: null },
    ];
    for (const input of invalid) {
      const result = yield* Schema.decodeEffect(Schema.toCodecJson(PublicOutput), {
        onExcessProperty: "error",
      })(input).pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
    }
  })
);

it("gives non-redisclosure recovery for an ambiguous claim without echoing arbitrary causes", () => {
  const human = formatFailure({ reason: "ClaimAmbiguous", json: false });
  expect(human).toContain("revoca");
  expect(human).toContain("nueva vinculación");
  expect(human.includes(secret)).toBe(false);
});

it.effect(
  "opens only the public approval link, with a no-browser fallback and no duplicate flag side effects",
  () =>
    Effect.gen(function* () {
      for (const noBrowser of [false, true]) {
        const fixture = makeLoginFixture();
        const opened: Array<string> = [];
        const emitted: Array<PublicOutput> = [];
        const args = ["login", "--recipient", "Mi agente", "--scopes", "read", "--lifetime", "7"];
        if (noBrowser) args.push("--no-browser");
        const fiber = yield* runCommand(
          args,
          {
            ...fixture.dependencies,
            readLine: () => Effect.die("unexpected prompt"),
            emit: (event) =>
              Effect.sync(() => {
                emitted.push(event);
              }),
          },
          (url) =>
            Effect.sync(() => {
              opened.push(url);
            })
        ).pipe(Effect.forkChild);
        yield* TestClock.adjust("5 seconds");
        yield* Fiber.join(fiber);
        expect(opened).toEqual(
          noBrowser ? [] : ["https://app.fidyapp.com/connect/cli?cliCode=BCDF-GHJK"]
        );
        expect(emitted[0]).toMatchObject({
          publicCode: "BCDF-GHJK",
          approvalUrl: "https://app.fidyapp.com/connect/cli?cliCode=BCDF-GHJK",
        });
        const encoded = yield* Schema.encodeEffect(
          Schema.fromJsonString(Schema.Array(PublicOutput))
        )(emitted);
        expect(encoded).not.toContain(privateProof);
        expect(encoded).not.toContain(secret);
        expect(fixture.saved).toHaveLength(1);
      }
      const fixture = makeLoginFixture();
      const invalid = yield* runCommand(
        ["login", "--no-browser", "--no-browser"],
        {
          ...fixture.dependencies,
          readLine: () => Effect.die("unexpected prompt"),
          emit: () => Effect.die("unexpected output"),
        },
        () => Effect.die("unexpected browser")
      ).pipe(Effect.exit);
      expect(Exit.isFailure(invalid)).toBe(true);
      expect(fixture.saved).toHaveLength(0);
    })
);

const privateProof = "p".repeat(secretLength);
const makeLoginFixture = (): Readonly<{
  dependencies: LoginDependencies;
  saved: Array<Credential>;
}> => {
  const saved: Array<Credential> = [];
  const pairing = Schema.decodeSync(Schema.toCodecJson(StartedPATPairing))({
    pairingId: "01900000-0000-4000-8000-000000000002",
    privateDeviceCode: privateProof,
    publicCode: "BCDF-GHJK",
    expiresAt: "1970-01-01T00:10:00.000Z",
    pollingIntervalSeconds: 5,
  });
  return {
    saved,
    dependencies: {
      verifyStorage: Effect.void,
      store: {
        load: Effect.succeedNone,
        save: (value) =>
          Effect.sync(() => {
            saved.push(value);
          }),
        clear: Effect.void,
      },
      pairing: { start: () => Effect.succeed(pairing), claim: () => Effect.succeed(issued) },
    },
  };
};

it.effect("interrupted saving settles local persistence without success output or rollback", () =>
  Effect.gen(function* () {
    const fixture = makeLoginFixture();
    const saving = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const output: Array<PublicOutput> = [];
    let local = Option.none<Credential>();
    let clears = 0;
    const dependencies: CommandDependencies = {
      ...fixture.dependencies,
      store: {
        load: Effect.suspend(() => Effect.succeed(local)),
        save: (credential) =>
          Deferred.succeed(saving, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(
              Effect.sync(() => {
                local = Option.some(credential);
              })
            )
          ),
        clear: Effect.sync(() => {
          clears += 1;
          local = Option.none();
        }),
      },
      readLine: () => Effect.die("unexpected prompt"),
      emit: (event) =>
        Effect.sync(() => {
          output.push(event);
        }),
    };
    const fiber = yield* runCommand(
      ["login", "--recipient", "Mi agente", "--scopes", "read", "--lifetime", "7", "--no-browser"],
      dependencies
    ).pipe(Effect.forkChild);
    yield* TestClock.adjust("5 seconds");
    yield* Deferred.await(saving);
    const interrupted = yield* Fiber.interrupt(fiber).pipe(
      Effect.forkChild({ startImmediately: true })
    );
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(interrupted);
    const exit = yield* Fiber.await(fiber);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterrupts(exit.cause)).toBe(true);
      expect(Cause.findErrorOption(exit.cause)).toMatchObject({
        value: { reason: "LoginSaveInterrupted" },
      });
      for (const json of [false, true]) {
        const failure = formatCommandFailure(exit.cause, json);
        expect(failure.interrupted).toBe(true);
        expect(failure.message).toContain("puede haberse guardado");
        expect(failure.message).toContain("fidy status");
        expect(failure.message).not.toContain(secret);
        expect(failure.message).not.toContain(privateProof);
        if (json) {
          expect(JSON.parse(failure.message)).toMatchObject({ code: "LoginSaveInterrupted" });
        }
      }
    }
    expect(output.some((event) => event._tag === "LoggedIn")).toBe(false);
    expect(clears).toBe(0);
    yield* runCommand(["status"], dependencies);
    expect(output.at(-1)).toMatchObject({ _tag: "LocalStatus", availability: "expired" });
  })
);

it.effect(
  "a cancelled dispatched claim reports possible consumption through process presentation",
  () =>
    Effect.gen(function* () {
      const fixture = makeLoginFixture();
      const dispatched = yield* Deferred.make<void>();
      let claims = 0;
      const output: Array<PublicOutput> = [];
      const fiber = yield* runCommand(
        [
          "login",
          "--recipient",
          "Mi agente",
          "--scopes",
          "read",
          "--lifetime",
          "7",
          "--no-browser",
        ],
        {
          ...fixture.dependencies,
          pairing: {
            ...fixture.dependencies.pairing,
            claim: () =>
              Effect.sync(() => {
                claims += 1;
              }).pipe(
                Effect.andThen(Deferred.succeed(dispatched, undefined)),
                Effect.andThen(Effect.never)
              ),
          },
          readLine: () => Effect.die("unexpected prompt"),
          emit: (event) =>
            Effect.sync(() => {
              output.push(event);
            }),
        }
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("5 seconds");
      yield* Deferred.await(dispatched);
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        for (const json of [false, true]) {
          const failure = formatCommandFailure(exit.cause, json);
          expect(failure.interrupted).toBe(true);
          expect(failure.message).toContain("No se puede confirmar si el servidor entregó");
          expect(failure.message).toContain("revoca");
          expect(failure.message).not.toContain(secret);
          expect(failure.message).not.toContain(privateProof);
          if (json) {
            expect(JSON.parse(failure.message)).toMatchObject({ code: "ClaimAmbiguous" });
          }
        }
      }
      yield* TestClock.adjust("10 minutes");
      expect(claims).toBe(1);
      expect(output.some((event) => event._tag === "LoggedIn")).toBe(false);
      expect(fixture.saved).toHaveLength(0);
    })
);
