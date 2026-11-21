import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { alice } from "../financial-user-store.test-fixture";
import { chatWith } from "../signed-whatsapp.test-fixture";
import { native } from "../user-store.test-fixture";
import { journey } from "./turn-journey.test-fixture";

const safeReply = "No pude completar tu solicitud en este momento. Inténtalo más tarde.";

const providerFailure = Effect.fn(function* (mode: string, rounds: number, answer: string) {
  const { db, provider, now } = yield* journey();

  const caller = "CO.13491208655302741918",
    portfolio = "123456789012345",
    message = "wamid." + mode;

  yield* native(() =>
    db.exec(
      "UPDATE users SET whatsapp_portfolio_id=?,whatsapp_bsuid=?,whatsapp_verified_at_ms=? WHERE id=?",
      portfolio,
      caller,
      now,
      alice.user
    )
  );

  const directory = yield* native(() =>
    db.runtime.unsafeGetDurableObjectStorage("core", "Directory", { name: "directory-v1" })
  );

  yield* native(() =>
    directory.exec(
      "INSERT INTO whatsapp_routes(portfolio,bsuid,user_id,attempt_id,established) VALUES(?,?,?,?,1)",
      portfolio,
      caller,
      alice.user,
      "hosted-proof"
    )
  );

  const facts = (): ReturnType<typeof db.exec> =>
    db.exec(
      "SELECT answer,(SELECT count(*) FROM hosted_tool_calls WHERE turn_id=t.id) AS calls,(SELECT count(*) FROM whatsapp_deliveries WHERE operation_id=t.id) AS deliveries FROM hosted_turns t"
    );

  const send = (): ReturnType<typeof chatWith> =>
    chatWith(db.runtime, {
      text: "¿Qué recuerdas?",
      caller,
      secret: "callback-fixture-secret",
      occurredMs: now,
      message,
    });

  yield* native(() => provider.fetch("https://fixture.invalid/" + mode));
  yield* native(() => provider.fetch("https://fixture.invalid/release"));
  expect((yield* send()).status).toBe(202);
  yield* native(() =>
    expect.poll(facts, { timeout: 10000 }).toEqual([{ answer, calls: 1, deliveries: 1 }])
  );
  expect((yield* send()).status).toBe(202);
  expect(
    yield* native(() =>
      provider.fetch("https://fixture.invalid/waiting").then((reply) => reply.json())
    )
  ).toMatchObject({ rounds });
  expect(
    yield* native(() =>
      provider.fetch("https://fixture.invalid/sends").then((reply) => reply.json())
    )
  ).toMatchObject({ sends: 1 });
  expect(yield* native(facts)).toEqual([{ answer, calls: 1, deliveries: 1 }]);
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  for (const [mode, rounds, answer] of [
    ["unavailable-after-query", 2, safeReply],
    ["invalid-after-query", 3, safeReply],
    ["repair-after-query", 3, "Listo."],
  ] as const) {
    test.effect("preserves one committed query and one WhatsApp reply for provider " + mode, () =>
      providerFailure(mode, rounds, answer)
    );
  }
});
