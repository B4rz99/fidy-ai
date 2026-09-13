import { expect, it, layer } from "@effect/vitest";
import { BunCrypto } from "@effect/platform-bun";
import { Effect, Schema } from "effect";
import { UserId } from "~/core/identity/reference";
import { ResendReceivedEmailId } from "~/core/ingestion/reference";
import { UnknownJsonString } from "~/schema-compatibility";
import { DisclosureDeliveryAttemptId } from "~/shell/channels/whatsapp/disclosure-model";
import { disclosureEvidenceQueueId } from "~/shell/channels/whatsapp/disclosure-workflow";
import { forwardedEmailQueueId } from "~/shell/ingestion/forwarded-email-execution";
import {
  maximumQueueIdLength,
  maximumQueueNameLength,
  productionQueueContracts,
  productionQueueNames,
} from "./contracts";

const fixtureUrl = (file: string): URL => new URL(`./fixtures/${file}`, import.meta.url);
const serverSourceRoot = Bun.fileURLToPath(new URL("../../", import.meta.url));

const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown);

const readFixture = (file: string): Effect.Effect<string> =>
  Effect.promise(() => Bun.file(fixtureUrl(file)).text());

/** Bounded encoded element; the SQL column and JSON codec allow far more. */
const maximumEncodedFixtureLength = 512;

const expectedQueueNames = [
  "whatsapp-consent-disclosure",
  "whatsapp-consent-disclosure-evidence",
  "onboarding-email-delivery",
  "whatsapp-inbound-turn",
  "browser-pairing-email-start",
  "browser-pairing-email-delivery",
  "browser-pairing-email-expiry",
  "subscription-billing-attempt",
  "email-replacement-delivery",
  "email-replacement-expiry",
  "forwarded-email-ingestion",
  "statement-ingestion",
];

/** Reads the `name`/`schema` identifiers of one `PersistedQueue.make` or `defineContract` body. */
const nameSchemaPair = (
  body: string,
  context: string
): Readonly<{ name: string; schema: string }> => {
  const name = /name:\s*([A-Za-z_$][\w$]*)/u.exec(body)?.[1];
  const schema = /schema:\s*([A-Za-z_$][\w$]*)/u.exec(body)?.[1];
  if (name === undefined || schema === undefined) {
    throw new Error(`Cannot read name/schema identifiers from ${context}`);
  }
  return { name, schema };
};

/**
 * Every production queue construction, as the `name`/`schema` identifier pair the
 * slice passes to `PersistedQueue.make`. Test-only constructions are excluded.
 */
const discoverProductionQueues: Effect.Effect<
  ReadonlyArray<Readonly<{ name: string; schema: string; file: string }>>
> = Effect.gen(function* () {
  const discovered: Array<Readonly<{ name: string; schema: string; file: string }>> = [];
  const paths = [...new Bun.Glob("**/*.ts").scanSync({ cwd: serverSourceRoot })];
  for (const path of paths) {
    if (path.endsWith(".test.ts")) continue;
    const source = yield* Effect.promise(() => Bun.file(`${serverSourceRoot}${path}`).text());
    for (const match of source.matchAll(/PersistedQueue\.make(?:<[^<>]*>)?\(\{([\s\S]*?)\}\)/gu)) {
      discovered.push({ ...nameSchemaPair(match[1] ?? "", path), file: path });
    }
  }
  return discovered;
});

it.effect("locks every production queue name within the SQL column limit", () =>
  Effect.sync(() => {
    expect([...productionQueueNames]).toEqual(expectedQueueNames);
    // Every locked name has exactly one contract, and no contract invents a name.
    expect(productionQueueContracts.map(({ name }) => name).sort()).toEqual(
      [...productionQueueNames].sort()
    );
    for (const name of productionQueueNames) {
      expect(name.length).toBeGreaterThan(0);
      expect(name.length).toBeLessThanOrEqual(maximumQueueNameLength);
    }
  })
);

it.effect("requires a reviewed contract for every production queue construction", () =>
  Effect.gen(function* () {
    const discovered = yield* discoverProductionQueues;
    const contractsSource = yield* Effect.promise(() =>
      Bun.file(new URL("./contracts.ts", import.meta.url)).text()
    );
    const registered = [...contractsSource.matchAll(/defineContract\(\{([\s\S]*?)\}\)/gu)].map(
      (match) => {
        const { name, schema } = nameSchemaPair(match[1] ?? "", "contracts.ts");
        return `${name}:${schema}`;
      }
    );
    expect(discovered).toHaveLength(productionQueueContracts.length);
    expect(discovered.map(({ name, schema }) => `${name}:${schema}`).sort()).toEqual(
      registered.sort()
    );
  })
);

it.effect(
  "decodes every oldest payload fixture into the same ownership and operation identity",
  () =>
    Effect.gen(function* () {
      for (const contract of productionQueueContracts) {
        const encoded = yield* Schema.decodeEffect(UnknownJsonString)(
          yield* readFixture(`${contract.name}.json`)
        );
        const encodedRecord = yield* Schema.decodeUnknownEffect(UnknownRecord)(encoded);
        // The oldest supported encoding omits the revision marker. The current schema
        // defaults it on decode, and regenerating a fixture from the current encoder
        // must fail rather than weaken the contract.
        expect(
          encodedRecord["revision"] ?? encodedRecord["version"],
          contract.name
        ).toBeUndefined();
        const decoded = yield* Schema.decodeUnknownEffect(contract.schema)(encodedRecord);
        const decodedRecord = yield* Schema.decodeEffect(UnknownRecord)(decoded);
        const revision = decodedRecord["revision"] ?? decodedRecord["version"];
        // The current schema defaults the marker to the one supported revision without
        // changing deduplication identity or User/domain ownership.
        expect(revision, contract.name).toBe(1);
        for (const field of [...contract.identityFields, ...contract.userFields]) {
          const raw = encodedRecord[field];
          expect(raw, `${contract.name}.${field}`).toBeDefined();
          expect(decodedRecord[field], `${contract.name}.${field}`).toBe(raw);
        }
        // Directly-keyed queues offer an identity field as the row id, so its encoded
        // value must already fit the SQL id column; the two hashed derivations are
        // bounded separately below.
        for (const field of contract.identityFields) {
          expect(
            String(encodedRecord[field]).length,
            `${contract.name}.${field}`
          ).toBeLessThanOrEqual(maximumQueueIdLength);
        }
        const roundTripped = yield* Schema.encodeUnknownEffect(Schema.toCodecJson(contract.schema))(
          decoded
        ).pipe(Effect.orDie);
        const roundTrippedJson = yield* Schema.encodeUnknownEffect(UnknownJsonString)(
          roundTripped
        ).pipe(Effect.orDie);
        expect(roundTrippedJson.length, contract.name).toBeLessThanOrEqual(
          maximumEncodedFixtureLength
        );
      }
    })
);

it.effect("keeps every derived custom queue id within the SQL column limit", () =>
  Effect.sync(() => {
    const evidenceId = disclosureEvidenceQueueId({
      attemptId: DisclosureDeliveryAttemptId.make("f1d1a000-0000-4000-8000-00000000c003"),
      evidenceRevision: 0,
    });
    expect(evidenceId.length).toBeLessThanOrEqual(maximumQueueIdLength);
  })
);

layer(BunCrypto.layer)("queue compatibility hashed identities", (it) => {
  it.effect("derives hashed queue identities within the SQL column limit", () =>
    Effect.gen(function* () {
      const identity = {
        userId: UserId.make("f1d1a000-0000-4000-8000-00000000c001"),
        receivedEmailId: ResendReceivedEmailId.make("f1d1a000-0000-4000-8000-00000000c012"),
        revision: 1 as const,
      };
      const forwardedId = yield* forwardedEmailQueueId(identity);
      expect(forwardedId.length).toBeLessThanOrEqual(maximumQueueIdLength);
      const repeated = yield* forwardedEmailQueueId(identity);
      expect(repeated).toBe(forwardedId);
    })
  );
});
