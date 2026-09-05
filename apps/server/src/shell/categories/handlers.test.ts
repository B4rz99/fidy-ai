import { expect, layer } from "@effect/vitest";
import { Effect, Option, Result } from "effect";
import { HttpBody, HttpClient } from "effect/unstable/http";
import { CategoryKeyword } from "~/core/categories/model";
import { CategoryId } from "~/core/categories/reference";
import { categoryIds } from "~/core/categories/taxonomy";
import { freePatCaller } from "~/shell/_shared/suggested-operations";
import { defaultUserId } from "~/shell/db/development-seed";
import { withUserTransaction } from "~/shell/db/user-transaction";
import { ApiHarness, ApiHarnessClient, headersFor } from "~/shell/testing/api-harness";
import { createKeywordRule, deleteKeywordRule, updateKeywordRule } from "./mutations";
import { defaultPatBearer } from "~/shell/testing/identity-fixtures";
import { transactionPayload, truncateTransactions } from "~/shell/transactions/fixtures";

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "category operations",
  (it) => {
    it.effect("lists the direct Colombian taxonomy with stable category ids", () =>
      Effect.gen(function* () {
        const client = yield* ApiHarnessClient;
        const listed = yield* client.categories.listCategories();

        expect(listed.data).toHaveLength(16);
        expect(listed.data).toContainEqual({
          id: categoryIds.domicilios,
          label: "Domicilios",
        });
        expect(listed.data.some((category) => category.label === "Deudas y comisiones")).toBe(
          false
        );
      })
    );

    it.effect("rejects a keyword that normalization would erase at the API boundary", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;
        const response = yield* HttpClient.post("/category-keyword-rules", {
          headers: headersFor(defaultPatBearer),
          body: HttpBody.jsonUnsafe({
            keyword: "\u0301",
            categoryId: categoryIds.mercado,
          }),
        });
        const body = yield* response.json;

        expect(response.status).toBe(400);
        expect(body).toMatchObject({
          error: { code: "validation_failed", fields: [{ path: "keyword" }] },
        });
      })
    );

    it.effect("rejects a keyword rule for a Category outside the retained taxonomy", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;
        const client = yield* ApiHarnessClient;

        const missing = yield* Effect.flip(
          client.categories.createKeywordRule({
            payload: {
              keyword: CategoryKeyword.make("inexistente"),
              categoryId: CategoryId.make("00000000-0000-4000-8000-000000000000"),
            },
          })
        );

        expect(missing).toMatchObject({ error: { code: "not_found" } });
      })
    );

    it.effect("rejects a duplicate keyword even when case and accents differ", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;
        const client = yield* ApiHarnessClient;
        yield* client.categories.createKeywordRule({
          payload: {
            keyword: CategoryKeyword.make("Éxito"),
            categoryId: categoryIds.mercado,
          },
        });

        const duplicate = yield* Effect.flip(
          client.categories.createKeywordRule({
            payload: {
              keyword: CategoryKeyword.make("exito"),
              categoryId: categoryIds.otros,
            },
          })
        );

        expect(duplicate).toMatchObject({ error: { code: "validation_failed" } });
      })
    );

    it.effect("keeps concurrent rule creation within the 100-rule User cap", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;
        const client = yield* ApiHarnessClient;
        yield* Effect.forEach(
          Array.from({ length: 99 }, (_, index) => index),
          (index) =>
            client.categories.createKeywordRule({
              payload: {
                keyword: CategoryKeyword.make(`rule-${index}`),
                categoryId: categoryIds.otros,
              },
            }),
          { discard: true }
        );

        const raced = yield* Effect.forEach(
          ["race-a", "race-b"],
          (keyword) =>
            Effect.result(
              client.categories.createKeywordRule({
                payload: {
                  keyword: CategoryKeyword.make(keyword),
                  categoryId: categoryIds.otros,
                },
              })
            ),
          { concurrency: "unbounded" }
        );
        const denied = yield* Effect.flip(
          client.categories.createKeywordRule({
            payload: {
              keyword: CategoryKeyword.make("rule-101"),
              categoryId: categoryIds.otros,
            },
          })
        );
        const retained = yield* client.categories.listKeywordRules({});

        expect(raced.filter(Result.isSuccess)).toHaveLength(1);
        expect(raced.filter(Result.isFailure)).toHaveLength(1);
        expect(denied).toMatchObject({ error: { code: "validation_failed" } });
        expect(retained.data).toHaveLength(100);
      })
    );

    it.effect("rolls keyword-rule creation back with its caller-owned transaction", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;
        const client = yield* ApiHarnessClient;
        const caller = freePatCaller(["write"]);

        const rollback = yield* Effect.result(
          withUserTransaction(
            defaultUserId,
            createKeywordRule({
              userId: defaultUserId,
              caller,
              payload: {
                keyword: CategoryKeyword.make("Rappi"),
                categoryId: categoryIds.domicilios,
              },
            }).pipe(Effect.andThen(Effect.fail("rollback requested")))
          )
        );
        const retained = yield* client.categories.listKeywordRules({});

        expect(rollback).toEqual(Result.fail("rollback requested"));
        expect(retained.data).toEqual([]);
      })
    );

    it.effect("rolls keyword-rule replacement and deletion back together", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;
        const client = yield* ApiHarnessClient;
        const caller = freePatCaller(["write"]);
        const created = yield* client.categories.createKeywordRule({
          payload: {
            keyword: CategoryKeyword.make("Rappi"),
            categoryId: categoryIds.domicilios,
          },
        });

        const rollback = yield* Effect.result(
          withUserTransaction(
            defaultUserId,
            Effect.gen(function* () {
              yield* updateKeywordRule({
                userId: defaultUserId,
                caller,
                keywordRuleId: created.data.id,
                payload: {
                  keyword: CategoryKeyword.make("Rappi Turbo"),
                  categoryId: categoryIds.mercado,
                },
              });
              yield* deleteKeywordRule({
                userId: defaultUserId,
                caller,
                keywordRuleId: created.data.id,
              });
              return yield* Effect.fail("rollback requested");
            })
          )
        );
        const retained = yield* client.categories.listKeywordRules({});

        expect(rollback).toEqual(Result.fail("rollback requested"));
        expect(retained.data).toEqual([created.data]);
      })
    );

    it.effect("applies an editable user keyword to future captures without rewriting history", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;
        const client = yield* ApiHarnessClient;

        const createdRule = yield* client.categories.createKeywordRule({
          payload: {
            keyword: CategoryKeyword.make("Rappi"),
            categoryId: categoryIds.mercado,
          },
        });
        const first = yield* client.transactions.createTransaction({
          payload: transactionPayload({ counterparty: "RÁPPI", categoryId: Option.none() }),
        });

        expect(first.data.categoryId).toBe(categoryIds.mercado);
        expect((yield* client.categories.listKeywordRules({})).data).toEqual([createdRule.data]);

        yield* client.categories.updateKeywordRule({
          params: { id: createdRule.data.id },
          payload: {
            keyword: CategoryKeyword.make("Rappi"),
            categoryId: categoryIds.transporte,
          },
        });
        const second = yield* client.transactions.createTransaction({
          payload: transactionPayload({ counterparty: "Rappi", categoryId: Option.none() }),
        });
        expect(first.data.categoryId).toBe(categoryIds.mercado);
        expect(second.data.categoryId).toBe(categoryIds.transporte);

        yield* client.categories.deleteKeywordRule({ params: { id: createdRule.data.id } });
        const third = yield* client.transactions.createTransaction({
          payload: transactionPayload({ counterparty: "Rappi", categoryId: Option.none() }),
        });
        expect(third.data.categoryId).toBe(categoryIds.otros);
      })
    );
  }
);
