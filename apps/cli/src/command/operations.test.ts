import { TestClock } from "effect/testing";
import { type LoginDependencies } from "../login/contract";
import { IssuedPAT, StartedPATPairing } from "@fidy/server/client";
import { expect, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Option, Schema } from "effect";
import { type Credential, SavedGrant, apiOrigin } from "../credential/contract";
import { type CommandDependencies, PublicOutput } from "./contract";
import { formatFailure, formatOutput, runCommand } from "./operations";

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
          noBrowser ? [] : ["https://fidyapp.com/connect/cli?cliCode=BCDF-GHJK"]
        );
        expect(emitted[0]).toMatchObject({
          publicCode: "BCDF-GHJK",
          approvalUrl: "https://fidyapp.com/connect/cli?cliCode=BCDF-GHJK",
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
