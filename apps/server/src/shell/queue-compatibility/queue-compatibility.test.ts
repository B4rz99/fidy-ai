/// <reference types="vite/client" />

import { expect, it, layer } from "@effect/vitest";
import { BunCrypto } from "@effect/platform-bun";
import { Effect, Schema } from "effect";
import { UserId } from "~/core/identity/reference";
import { ResendReceivedEmailId } from "~/core/ingestion/reference";
import { UnknownJsonString } from "~/shell/schema-codecs/contract";
import { applicationPersistedQueueNames } from "~/shell/_shared/persisted-queue";
import { DisclosureDeliveryAttemptId } from "~/shell/channels/whatsapp/disclosure-model";
import { disclosureEvidenceQueueId } from "~/shell/channels/whatsapp/disclosure-workflow";
import { forwardedEmailQueueId } from "~/shell/ingestion/forwarded-email-execution";
import {
  type QueueCompatibilityContract,
  maximumQueueIdLength,
  maximumQueueNameLength,
} from "./contracts";

const contractModules = import.meta.glob<{
  queueCompatibilityContract: QueueCompatibilityContract;
}>("./contracts/*.ts", { eager: true });
const discoveredQueueContracts = Object.values(contractModules).map(
  ({ queueCompatibilityContract }) => queueCompatibilityContract
);

const fixtureUrl = (file: string): URL => new URL(`./fixtures/${file}`, import.meta.url);

const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown);

const readFixture = (file: string): Effect.Effect<string> =>
  Effect.promise(() => Bun.file(fixtureUrl(file)).text());

/** Bounded encoded element; the SQL column and JSON codec allow far more. */
const maximumEncodedFixtureLength = 512;

it.effect("ties every discovered compatibility contract to a constructed queue", () =>
  Effect.sync(() => {
    const names = discoveredQueueContracts.map(({ name }) => name).sort();
    expect(names).toEqual(applicationPersistedQueueNames());
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name.length).toBeGreaterThan(0);
      expect(name.length).toBeLessThanOrEqual(maximumQueueNameLength);
    }
  })
);

it.effect(
  "decodes every oldest payload fixture into the same ownership and operation identity",
  () =>
    Effect.gen(function* () {
      for (const contract of discoveredQueueContracts) {
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
        const decoded = yield* Schema.decodeEffect(contract.schema)(encodedRecord);
        const decodedRecord = yield* Schema.decodeUnknownEffect(UnknownRecord)(decoded);
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

layer(BunCrypto.layer)("queue compatibility hashed identities", (it) => {
  it.effect("keeps every derived custom queue id within the SQL column limit", () =>
    Effect.gen(function* () {
      const evidenceId = yield* disclosureEvidenceQueueId({
        attemptId: DisclosureDeliveryAttemptId.make("f1d1a000-0000-4000-8000-00000000c003"),
        evidenceRevision: 0,
      });
      expect(evidenceId.length).toBeLessThanOrEqual(maximumQueueIdLength);
    })
  );

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
