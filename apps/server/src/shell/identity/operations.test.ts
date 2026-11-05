import { expect, it } from "@effect/vitest";
import { DateTime, Effect } from "effect";
import { UserId } from "~/core/identity/contract";
import { prepareCurrentUser, prepareSelectedCurrentUser } from "./operations";

const userId = UserId.make("10000000-0000-4000-8000-000000000001");
const row = {
  id: userId,
  service_market: "CO",
  locale: "es-CO",
  time_zone: "America/Bogota",
  created_at_ms: 1000,
  started_at_ms: 1000,
  ends_at_ms: 604801000,
};

it.effect("decodes the complete canonical metadata selected by a live browser relation", () =>
  Effect.gen(function* () {
    const prepared = prepareSelectedCurrentUser({ sql: "SELECT ? AS userId", params: [userId] });
    const loaded = yield* prepared.decode([row]);
    expect(loaded.data).toMatchObject({
      id: userId,
      serviceMarket: "CO",
      locale: "es-CO",
      timeZone: "America/Bogota",
    });
    expect(DateTime.toEpochMillis(loaded.data.trialPeriod.startedAt)).toBe(row.started_at_ms);
    expect(DateTime.toEpochMillis(loaded.data.trialPeriod.endsAt)).toBe(row.ends_at_ms);
    expect(loaded.next).toEqual([]);
  })
);

it.effect("a resolved User read refuses a different User's otherwise valid metadata", () =>
  Effect.gen(function* () {
    const prepared = yield* prepareCurrentUser(userId);
    const refused = yield* prepared
      .decode([{ ...row, id: "10000000-0000-4000-8000-000000000002" }])
      .pipe(
        Effect.match({ onSuccess: () => "disclosed", onFailure: (failure) => failure.error.code })
      );
    expect(refused).toBe("unavailable");
    expect((yield* prepared.decode([row])).data.id).toBe(userId);
  })
);

it.effect("missing or malformed selected metadata never becomes a partial profile", () =>
  Effect.gen(function* () {
    const prepared = prepareSelectedCurrentUser({ sql: "SELECT ? AS userId", params: [userId] });
    for (const rows of [
      [],
      [{ ...row, id: "invalid" }],
      [{ ...row, locale: "unknown" }],
      [{ ...row, ends_at_ms: null }],
    ]) {
      const refused = yield* prepared
        .decode(rows)
        .pipe(
          Effect.match({ onSuccess: () => "disclosed", onFailure: (failure) => failure.error.code })
        );
      expect(refused).toBe("unavailable");
    }
  })
);
