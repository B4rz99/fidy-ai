import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { HttpBody, HttpClient } from "effect/unstable/http";
import { IanaTimeZone } from "~/core/_shared/context";
import { defaultUserId } from "~/shell/db/development-seed";
import { ApiHarness, ApiHarnessClient, headersFor } from "~/shell/testing/api-harness";
import { defaultAgentBearer } from "~/shell/testing/identity-fixtures";
import { truncateAuditLogEntries } from "./fixtures";
import { listAuditLogEntries } from "./repo";

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "canonical operation auditing",
  (it) => {
    it.effect("appends metadata-only evidence for a successful canonical operation", () =>
      Effect.gen(function* () {
        yield* truncateAuditLogEntries;
        const client = yield* ApiHarnessClient;

        yield* client.identity.getCurrentUser();

        const entries = yield* listAuditLogEntries(defaultUserId);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
          subjectUserId: defaultUserId,
          operation: "identity.getCurrentUser",
          outcome: "succeeded",
        });
        expect(Object.keys(entries[0] ?? {}).sort()).toEqual([
          "id",
          "occurredAt",
          "operation",
          "outcome",
          "subjectUserId",
          "tokenId",
        ]);
        expect(Object.values(entries[0] ?? {})).not.toContain(defaultAgentBearer);
      })
    );

    it.effect("appends successful evidence for a User preference mutation", () =>
      Effect.gen(function* () {
        yield* truncateAuditLogEntries;
        const client = yield* ApiHarnessClient;

        yield* client.identity.updateUserPreferences({
          payload: {
            locale: "es-CO",
            timeZone: IanaTimeZone.make("America/New_York"),
          },
        });

        const entries = yield* listAuditLogEntries(defaultUserId);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
          operation: "identity.updateUserPreferences",
          outcome: "succeeded",
        });
      })
    );

    it.effect("appends failed evidence when canonical input is rejected", () =>
      Effect.gen(function* () {
        yield* truncateAuditLogEntries;

        const response = yield* HttpClient.patch("/user/preferences", {
          headers: headersFor(defaultAgentBearer),
          body: HttpBody.jsonUnsafe({ locale: "es-CO", timeZone: "-05:00" }),
        });
        const entries = yield* listAuditLogEntries(defaultUserId);

        expect(response.status).toBe(400);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
          operation: "identity.updateUserPreferences",
          outcome: "failed",
        });
      })
    );
  }
);
