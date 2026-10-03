import { IssuedPAT } from "@fidy/server/client";
import { expect, it } from "@effect/vitest";
import { Effect, Exit, Option, Schema } from "effect";
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
