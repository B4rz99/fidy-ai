import { DateTime, Effect, Option } from "effect";
import { expect, it } from "vitest";
import { approvedWorkersAiModel } from "../../src/shell/hosted-inference/contract";
import { UserTransactionCoordinator } from "../transactions/runtime";
import { encodeJson, now, reply, setup, subject, users } from "./hosted-turn.test-fixture";

const sandboxCoordinator = ({
  db,
  profile,
  run,
}: Readonly<{
  db: D1Database;
  profile: Option.Option<string>;
  run: (request: unknown) => Promise<Response>;
}>): UserTransactionCoordinator =>
  new UserTransactionCoordinator(
    {
      id: { name: users[0] },
      storage: {
        getAlarm: () => Promise.resolve(null),
        deleteAlarm: () => Promise.resolve(),
        setAlarm: () => Promise.resolve(),
      },
    },
    {
      DB: db,
      HOSTED_AI_MODEL: approvedWorkersAiModel,
      AI: { run: (_model, request) => run(request) },
      BANCOLOMBIA_SANDBOX_CONSENT_PROFILE: Option.getOrUndefined(profile),
    }
  );

for (const scenario of ["admitted", "foreign", "expired", "absent"] as const) {
  it(`keeps hosted Connection initiation within ${scenario} sandbox admission`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* Effect.tryPromise(() => setup());
        const current = now();
        const encodeTime = (milliseconds: number): string =>
          DateTime.formatIso(DateTime.makeUnsafe(milliseconds));
        const profile = encodeJson({
          contract: "bancolombia-sandbox-consent-2026-10-27",
          userId: scenario === "foreign" ? users[1] : users[0],
          admission: {
            startsAt: encodeTime(current - 60000),
            expiresAt: encodeTime(current + (scenario === "expired" ? -1 : 60000)),
          },
          financialId: "",
          accountOwner: { SchemeName: "CC", Identification: "synthetic-identity" },
          intent: {
            permissions: ["ReadAccountsBasic"],
            historyPolicy: "bank-default",
            expiryPolicy: "bank-default",
          },
        });
        const requests: Array<unknown> = [];
        const coordinator = sandboxCoordinator({
          db,
          profile: scenario === "absent" ? Option.none() : Option.some(profile),
          run: (request) => {
            requests.push(request);
            return Promise.resolve(
              requests.length === 1
                ? Response.json({
                    choices: [
                      {
                        message: {
                          role: "assistant",
                          content: null,
                          tool_calls: [
                            {
                              id: "connect-bank",
                              type: "function",
                              function: {
                                name: "connections__connectInstitution",
                                arguments: encodeJson({
                                  payload: { institutionId: "bancolombia" },
                                }),
                              },
                            },
                          ],
                        },
                        finish_reason: "tool_calls",
                      },
                    ],
                    usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 },
                  })
                : reply("Consulta el resultado de la conexión.")
            );
          },
        });
        const credential = yield* Effect.tryPromise(() => subject(0));
        const response = yield* Effect.tryPromise(() =>
          coordinator.fetch(
            new Request("https://coordinator.internal/hosted-turn", {
              method: "POST",
              body: encodeJson({
                userId: credential.userId,
                sessionId: credential.id,
                digest: Array.from(credential.digest),
                text: "Conecta Bancolombia",
              }),
            })
          )
        );
        expect(response.status).toBe(202);
        expect(requests).toHaveLength(scenario === "admitted" ? 1 : 2);
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare("SELECT COUNT(*) AS count FROM connections WHERE user_id=?")
              .bind(users[0])
              .first<number>("count")
          )
        ).toBe(scenario === "admitted" ? 1 : 0);
        const evidence = yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT outcome_json FROM transcript_entries WHERE kind='tool_result' AND user_id=?"
            )
            .bind(users[0])
            .all()
        );
        expect(encodeJson(evidence.results)).not.toContain("synthetic-identity");
        if (scenario === "admitted") {
          expect(encodeJson(evidence.results)).toContain("/connections/continue?attempt=");
        }
      })
    ));
}
