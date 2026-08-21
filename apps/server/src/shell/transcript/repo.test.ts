import { expect, layer } from "@effect/vitest";
import { DateTime, Effect, Exit } from "effect";
import {
  TranscriptEntryId,
  TranscriptText,
  TranscriptTurnId,
  UserTranscriptEntry,
} from "~/core/transcript/model";
import { MigrationSqlClient } from "~/shell/db/client";
import { defaultUserId } from "~/shell/db/development-seed";
import { ApiHarness } from "~/shell/testing/api-harness";
import { appendTranscriptEntries, selectTranscriptEntries } from "./repo";

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "Transcript persistence",
  (it) => {
    it.effect("rolls back the whole supplied batch when a later entry cannot be appended", () =>
      Effect.gen(function* () {
        const entryId = TranscriptEntryId.make("f1d1a000-0000-4000-8000-000000000a50");
        const entry = UserTranscriptEntry.make({
          id: entryId,
          turnId: TranscriptTurnId.make("f1d1a000-0000-4000-8000-000000000a51"),
          text: TranscriptText.make("batch must remain atomic"),
          occurredAt: DateTime.makeUnsafe("2026-08-01T12:00:00Z"),
        });
        const admin = yield* MigrationSqlClient;
        yield* admin`DELETE FROM transcript_entries WHERE entry_id = ${entryId}`;

        const outcome = yield* Effect.exit(appendTranscriptEntries(defaultUserId, [entry, entry]));
        expect(Exit.isFailure(outcome)).toBe(true);

        const retained = yield* selectTranscriptEntries(defaultUserId);
        expect(retained.some((candidate) => candidate.id === entryId)).toBe(false);
      })
    );
  }
);
