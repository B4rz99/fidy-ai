import { expect, it } from "@effect/vitest";
import { DateTime, Effect } from "effect";
import { UserId } from "~/core/_shared/user";
import { makeColombianUser } from "./rules";

const userId = UserId.make("f1d1a000-0000-4000-8000-000000000001");
const createdAt = DateTime.makeUnsafe("2026-07-28T00:00:00Z");

it.effect("creates a Colombian User with explicit independent context", () =>
  Effect.gen(function* () {
    const user = yield* makeColombianUser(userId, { createdAt });

    expect(user).toMatchObject({
      id: userId,
      serviceMarket: "CO",
      locale: "es-CO",
      timeZone: "America/Bogota",
      createdAt,
    });
  })
);
