import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Clock, Data, DateTime, Effect, Option, Schema } from "effect";
import {
  alice,
  bob,
  nativeTransactionJourney,
  seedNativePAT,
} from "../financial-user-store.test-fixture";
import { native } from "../user-store.test-fixture";
import { KeywordRuleResponse, ListKeywordRulesResponse } from "../../src/shell/categories/contract";
import { CreateTransactionResponse } from "../../src/shell/transactions/contract";

const userA = alice.user;

const domicilios = "10000000-0000-4000-8000-000000000002";

const mercado = "10000000-0000-4000-8000-000000000003";

const transporte = "10000000-0000-4000-8000-000000000004";

const ingresos = "10000000-0000-4000-8000-000000000015";

const otros = "10000000-0000-4000-8000-000000000016";

const foreignCategory = "90000000-0000-4000-8000-000000000009";

class TestPromiseFailure extends Data.TaggedError("TestPromiseFailure")<{ cause: unknown }> {}

const awaitPromise = <A>(
  promise: PromiseLike<A> | A
): Effect.Effect<Awaited<A>, TestPromiseFailure> =>
  Effect.tryPromise({
    try: () => Promise.resolve(promise),
    catch: (cause) => new TestPromiseFailure({ cause }),
  });

const decodeJson = <A>(
  schema: Schema.Codec<A, unknown>,
  response: Response
): Effect.Effect<A, TestPromiseFailure | Schema.SchemaError> =>
  Effect.gen(function* () {
    const body: unknown = yield* awaitPromise(response.json());

    return yield* Schema.decodeUnknownEffect(schema)(body);
  });

const clock = (): number => Effect.runSync(Clock.currentTimeMillis);

const StoredRule = Schema.Struct({
  id: Schema.String,
  keyword: Schema.String,
  categoryId: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const RuleEnvelope = Schema.Struct({ data: StoredRule, next: Schema.Array(Schema.Unknown) });

const RuleListEnvelope = Schema.Struct({
  data: Schema.Array(StoredRule),
  next: Schema.Array(Schema.Unknown),
});

const RemovedEnvelope = Schema.Struct({ data: Schema.String, next: Schema.Array(Schema.Unknown) });

const TransactionEnvelope = Schema.Struct({
  data: Schema.Struct({ id: Schema.String, categoryId: Schema.String }),
  next: Schema.Array(Schema.Unknown),
});

const FailedBody = Schema.Struct({
  error: Schema.Struct({ code: Schema.String, message: Schema.String }),
  next: Schema.Array(Schema.Unknown),
});

type Send = Readonly<{ path: string; method: "GET" | "POST" | "PUT" | "DELETE" }> &
  Partial<
    Readonly<{
      payload: object;
      session: string;
      bearer: string;
      origin: string;
      originless: boolean;
    }>
  >;

type Journey = Effect.Success<typeof nativeTransactionJourney>;

const setup = Effect.gen(function* () {
  const db = yield* nativeTransactionJourney;
  const sessions = [alice.bearer, bob.bearer] as const;

  const send = ({
    path,
    method,
    payload,
    session,
    bearer,
    origin,
    originless,
  }: Send): Promise<Response> => {
    const headers = new Headers();

    if (originless !== true) headers.set("origin", origin ?? "https://app.fidyapp.com");

    if (payload !== undefined) headers.set("content-type", "application/json");

    if (bearer !== undefined) headers.set("authorization", "Bearer " + bearer);

    if (session !== undefined) {
      headers.set("cookie", "__Host-fidy_session=" + session);
      headers.set("Fidy-Session-Binding", session === alice.bearer ? alice.session : bob.session);
    }

    return db.send(
      new Request("https://api.fidyapp.com" + path, {
        method,
        headers,
        body: payload === undefined ? null : JSON.stringify(payload),
      })
    );
  };

  return { db, send, sessions };
});

type SendFn = (input: Send) => Promise<Response>;

type RuleRequest = Readonly<{
  send: SendFn;
  session: string;
  keyword: string;
  categoryId: string;
}>;

const createRule = (
  request: Partial<RuleRequest> & Pick<RuleRequest, "send" | "session" | "keyword">
): Promise<Response> => {
  const { send, session, keyword, categoryId = domicilios } = request;

  return send({
    path: "/category-keyword-rules",
    method: "POST",
    session,
    payload: { keyword, categoryId },
  });
};

type CaptureRequest = Readonly<{
  send: SendFn;
  session: string;
  direction: "inflow" | "outflow";
  counterparty: string;
  categoryId: string;
}>;

const capture = (
  request: Partial<CaptureRequest> & Pick<CaptureRequest, "send" | "session">
): Promise<Response> => {
  const { send, session, direction = "outflow", counterparty, categoryId } = request;

  const movement = {
    money: { amount: "25000.00", currency: "COP" },
    direction,
    occurredAt: DateTime.formatIso(DateTime.makeUnsafe(clock() - 60_000)),
  };

  const described = counterparty === undefined ? movement : { ...movement, counterparty };

  return send({
    path: "/transactions",
    method: "POST",
    session,
    payload: categoryId === undefined ? described : { ...described, categoryId },
  });
};

const issuePAT = Effect.fn(function* ({
  db,
  scopes,
  index,
}: {
  db: Journey;
  scopes: ReadonlyArray<string>;
  index: number;
}) {
  const bearer = "fin_" + String(index).repeat(8) + "_" + "p".repeat(43);
  yield* seedNativePAT({
    db,
    userId: alice.user,
    token: bearer,
    scopes,
    current: yield* Clock.currentTimeMillis,
  });

  return { bearer };
});

const ruleCount = (db: Journey, userId: string): Effect.Effect<unknown> =>
  native(() =>
    db.owner(userId).exec("SELECT count(*) AS total FROM keyword_rules WHERE user_id=?", userId)
  ).pipe(Effect.map((rows) => rows[0]?.total));

const storedCategory = (
  db: Journey,
  userId: string,
  id: string
): Effect.Effect<Option.Option<unknown>> =>
  native(() =>
    db
      .owner(userId)
      .exec("SELECT category_id FROM transactions WHERE user_id=? AND id=?", userId, id)
  ).pipe(Effect.map((rows) => Option.fromUndefinedOr(rows[0]?.category_id)));

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect("applies a replaced keyword and Category only to future matching captures", () =>
    Effect.gen(function* () {
      const { send, sessions } = yield* setup;
      const session = sessions[0];

      const original = (yield* decodeJson(
        Schema.toCodecJson(KeywordRuleResponse),
        yield* awaitPromise(createRule({ send, session, keyword: "Rappi" }))
      )).data;

      const updated = yield* awaitPromise(
        send({
          path: `/category-keyword-rules/${original.id}`,
          method: "PUT",
          session,
          payload: { keyword: "Éxito", categoryId: mercado },
        })
      );

      expect(updated.status).toBe(200);
      expect(
        (yield* decodeJson(Schema.toCodecJson(KeywordRuleResponse), updated)).data
      ).toMatchObject({
        id: original.id,
        keyword: "exito",
        categoryId: mercado,
        createdAt: original.createdAt,
      });

      const matched = yield* decodeJson(
        Schema.toCodecJson(CreateTransactionResponse),
        yield* awaitPromise(capture({ send, session, counterparty: "EXITO supermercado" }))
      );

      expect(matched.data.categoryId).toBe(mercado);

      const retired = yield* decodeJson(
        Schema.toCodecJson(CreateTransactionResponse),
        yield* awaitPromise(capture({ send, session, counterparty: "Rappi" }))
      );

      expect(retired.data.categoryId).toBe(otros);
    })
  );

  test.effect(
    "preserves a rule and its capture behavior when replacement conflicts or names an unknown Category",
    Effect.fnUntraced(function* () {
      const { send, sessions } = yield* setup;
      const session = sessions[0];

      const original = (yield* decodeJson(
        Schema.toCodecJson(KeywordRuleResponse),
        yield* awaitPromise(createRule({ send, session, keyword: "Rappi" }))
      )).data;

      expect((yield* awaitPromise(createRule({ send, session, keyword: "Éxito" }))).status).toBe(
        201
      );

      yield* Effect.forEach(
        [
          { keyword: "EXITO", categoryId: mercado, status: 400 },
          { keyword: "Farmacia", categoryId: foreignCategory, status: 404 },
        ],
        Effect.fnUntraced(function* (replacement) {
          const refused = yield* awaitPromise(
            send({
              path: `/category-keyword-rules/${original.id}`,
              method: "PUT",
              session,
              payload: { keyword: replacement.keyword, categoryId: replacement.categoryId },
            })
          );

          expect(refused.status).toBe(replacement.status);

          const retained = yield* decodeJson(
            Schema.toCodecJson(ListKeywordRulesResponse),
            yield* awaitPromise(send({ path: "/category-keyword-rules", method: "GET", session }))
          );

          expect(retained.data.find((rule) => rule.id === original.id)).toEqual(original);
        }),
        { discard: true }
      );

      const captured = yield* decodeJson(
        Schema.toCodecJson(CreateTransactionResponse),
        yield* awaitPromise(capture({ send, session, counterparty: "Rappi" }))
      );

      expect(captured.data.categoryId).toBe(domicilios);
    })
  );

  test.effect("retains exactly one normalized keyword when concurrent creates compete", () =>
    Effect.gen(function* () {
      const { send, sessions } = yield* setup;
      const session = sessions[0];

      const responses = yield* awaitPromise(
        Promise.all([
          createRule({ send, session, keyword: "Éxito", categoryId: mercado }),
          createRule({ send, session, keyword: "EXITO", categoryId: transporte }),
        ])
      );

      expect(
        responses.map((response) => response.status).sort((left, right) => left - right)
      ).toEqual([201, 400]);
      const accepted = responses.find((response) => response.status === 201);

      if (accepted === undefined) throw new Error("No accepted keyword rule");
      const winner = (yield* decodeJson(Schema.toCodecJson(KeywordRuleResponse), accepted)).data;

      const retained = yield* decodeJson(
        Schema.toCodecJson(ListKeywordRulesResponse),
        yield* awaitPromise(send({ path: "/category-keyword-rules", method: "GET", session }))
      );

      expect(retained.data).toEqual([winner]);

      const captured = yield* decodeJson(
        Schema.toCodecJson(CreateTransactionResponse),
        yield* awaitPromise(capture({ send, session, counterparty: "Exito" }))
      );

      expect(captured.data.categoryId).toBe(winner.categoryId);
    })
  );

  test.effect(
    "lists and creates rules for exactly one User through the derived canonical contract",
    () =>
      Effect.gen(function* () {
        const { send, sessions } = yield* setup;

        const created = yield* awaitPromise(
          createRule({ send, session: sessions[0], keyword: "RÁPPI Turbo", categoryId: domicilios })
        );

        expect(created.status).toBe(201);
        const rule = (yield* decodeJson(RuleEnvelope, created)).data;
        expect(rule.keyword).toBe("rappi turbo");
        expect(rule.categoryId).toBe(domicilios);

        const listed = yield* awaitPromise(
          send({ path: "/category-keyword-rules", method: "GET", session: sessions[0] })
        );

        expect(listed.status).toBe(200);
        const own = (yield* decodeJson(RuleListEnvelope, listed)).data;
        expect(own).toEqual([rule]);

        const other = yield* awaitPromise(
          send({ path: "/category-keyword-rules", method: "GET", session: sessions[1] })
        );

        expect(other.status).toBe(200);
        expect((yield* decodeJson(RuleListEnvelope, other)).data).toEqual([]);
      })
  );

  test.effect("rejects a case- and accent-folded duplicate keyword without a partial effect", () =>
    Effect.gen(function* () {
      const { db, send, sessions } = yield* setup;
      expect(
        (yield* awaitPromise(createRule({ send, session: sessions[0], keyword: "Rappi" }))).status
      ).toBe(201);

      const duplicate = yield* awaitPromise(
        createRule({ send, session: sessions[0], keyword: "RÁPPI", categoryId: mercado })
      );

      expect(duplicate.status).toBe(400);
      const body = yield* decodeJson(FailedBody, duplicate);
      expect(body.error.code).toBe("validation_failed");
      expect(body.error.message).toContain("already");
      expect(yield* ruleCount(db, userA)).toBe(1);
    })
  );

  test.effect(
    "rejects an unknown Category, an oversized keyword, and a malformed body without storing a rule",
    () =>
      Effect.gen(function* () {
        const { db, send, sessions } = yield* setup;
        expect(
          (yield* awaitPromise(
            createRule({
              send,
              session: sessions[0],
              keyword: "Fantasma",
              categoryId: foreignCategory,
            })
          )).status
        ).toBe(404);

        yield* Effect.forEach(
          ["x".repeat(81), "각".repeat(80), "\u0301 café", "\u0301"],
          Effect.fnUntraced(function* (keyword) {
            expect(
              (yield* awaitPromise(createRule({ send, session: sessions[0], keyword }))).status
            ).toBe(400);
          }),
          { discard: true }
        );

        expect(
          (yield* awaitPromise(
            send({
              path: "/category-keyword-rules",
              method: "POST",
              session: sessions[0],
              payload: { keyword: "   ", categoryId: domicilios },
            })
          )).status
        ).toBe(400);
        expect(
          (yield* awaitPromise(
            send({ path: "/category-keyword-rules", method: "GET", session: "unused" })
          )).status
        ).toBe(401);
        expect(yield* ruleCount(db, userA)).toBe(0);
      })
  );

  test.effect(
    "refuses excess rules but allows replacement at capacity and reuses a deleted slot",
    () =>
      Effect.gen(function* () {
        const { db, send, sessions } = yield* setup;
        const current = clock();
        yield* native(() =>
          db.exec("INSERT INTO categories VALUES (?,'Domicilios',22)", domicilios)
        );

        yield* Effect.forEach(
          Array.from({ length: 100 }, (_, index) => index),
          Effect.fnUntraced(function* (index) {
            yield* awaitPromise(
              db.exec(
                `INSERT INTO keyword_rules (id,user_id,keyword,category_id,category_revision,created_at_ms,updated_at_ms)
               VALUES (?,?,?,?,'co-1',?,?)`,
                `80000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
                userA,
                `tienda ${index}`,
                domicilios,
                current,
                current
              )
            );
          }),
          { discard: true }
        );

        const refused = yield* awaitPromise(
          createRule({ send, session: sessions[0], keyword: "demasiada" })
        );

        expect(refused.status).toBe(400);

        const retained = (yield* decodeJson(
          Schema.toCodecJson(ListKeywordRulesResponse),
          yield* awaitPromise(
            send({ path: "/category-keyword-rules", method: "GET", session: sessions[0] })
          )
        )).data;

        expect(retained).toHaveLength(100);
        const first = retained[0];

        if (first === undefined) throw new Error("Missing retained keyword rule");

        const replaced = yield* awaitPromise(
          send({
            path: `/category-keyword-rules/${first.id}`,
            method: "PUT",
            session: sessions[0],
            payload: { keyword: "reemplazada", categoryId: mercado },
          })
        );

        expect(replaced.status).toBe(200);
        expect(
          (yield* decodeJson(Schema.toCodecJson(KeywordRuleResponse), replaced)).data
        ).toMatchObject({
          id: first.id,
          keyword: "reemplazada",
          categoryId: mercado,
        });
        expect(
          (yield* awaitPromise(
            send({
              path: `/category-keyword-rules/${first.id}`,
              method: "DELETE",
              session: sessions[0],
            })
          )).status
        ).toBe(200);
        expect(
          (yield* awaitPromise(createRule({ send, session: sessions[0], keyword: "nueva" }))).status
        ).toBe(201);

        const afterReuse = (yield* decodeJson(
          Schema.toCodecJson(ListKeywordRulesResponse),
          yield* awaitPromise(
            send({ path: "/category-keyword-rules", method: "GET", session: sessions[0] })
          )
        )).data;

        expect(afterReuse).toHaveLength(100);
        expect(afterReuse.some((rule) => rule.id === first.id)).toBe(false);
        expect(afterReuse.some((rule) => rule.keyword === "nueva")).toBe(true);
      })
  );

  test.effect("updates and deletes only the caller's own rule", () =>
    Effect.gen(function* () {
      const { db, send, sessions } = yield* setup;

      const created = (yield* decodeJson(
        RuleEnvelope,
        yield* awaitPromise(
          createRule({ send, session: sessions[0], keyword: "Rappi", categoryId: domicilios })
        )
      )).data;

      const foreignUpdate = yield* awaitPromise(
        send({
          path: `/category-keyword-rules/${created.id}`,
          method: "PUT",
          session: sessions[1],
          payload: { keyword: "Ajeno", categoryId: mercado },
        })
      );

      expect(foreignUpdate.status).toBe(404);

      const foreignDelete = yield* awaitPromise(
        send({
          path: `/category-keyword-rules/${created.id}`,
          method: "DELETE",
          session: sessions[1],
        })
      );

      expect(foreignDelete.status).toBe(404);

      const untouched = yield* awaitPromise(
        db
          .exec("SELECT keyword, category_id, user_id FROM keyword_rules WHERE id = ?", created.id)
          .then((rows) => rows[0])
      );

      expect(untouched).toEqual({ keyword: "rappi", category_id: domicilios, user_id: userA });

      const updated = yield* awaitPromise(
        send({
          path: `/category-keyword-rules/${created.id}`,
          method: "PUT",
          session: sessions[0],
          payload: { keyword: "Rappi Turbo", categoryId: mercado },
        })
      );

      expect(updated.status).toBe(200);
      expect((yield* decodeJson(RuleEnvelope, updated)).data).toMatchObject({
        id: created.id,
        keyword: "rappi turbo",
        categoryId: mercado,
      });

      const removed = yield* awaitPromise(
        send({
          path: `/category-keyword-rules/${created.id}`,
          method: "DELETE",
          session: sessions[0],
        })
      );

      expect(removed.status).toBe(200);
      expect((yield* decodeJson(RemovedEnvelope, removed)).data).toBe(created.id);
      expect(yield* ruleCount(db, userA)).toBe(0);
    })
  );

  test.effect(
    "answers a path segment that is not a stable rule identity as not found on both routes",
    () =>
      Effect.gen(function* () {
        const { send, sessions } = yield* setup;

        const malformedUpdate = yield* awaitPromise(
          send({
            path: "/category-keyword-rules/not-a-rule-id",
            method: "PUT",
            session: sessions[0],
            payload: { keyword: "Malformado", categoryId: mercado },
          })
        );

        expect(malformedUpdate.status).toBe(404);

        const malformedDelete = yield* awaitPromise(
          send({
            path: "/category-keyword-rules/not-a-rule-id",
            method: "DELETE",
            session: sessions[0],
          })
        );

        expect(malformedDelete.status).toBe(404);
      })
  );

  test.effect(
    "applies an explicit Category, then the most specific caller rule, then the direction fallback",
    () =>
      Effect.gen(function* () {
        const { db, send, sessions } = yield* setup;
        yield* awaitPromise(createRule({ send, session: sessions[0], keyword: "Rappi" }));
        yield* awaitPromise(
          createRule({ send, session: sessions[0], keyword: "Rappi Turbo", categoryId: mercado })
        );

        const specific = (yield* decodeJson(
          TransactionEnvelope,
          yield* awaitPromise(
            capture({ send, session: sessions[0], counterparty: "RAPPI TURBO Bogotá" })
          )
        )).data;

        expect(specific.categoryId).toBe(mercado);

        const general = (yield* decodeJson(
          TransactionEnvelope,
          yield* awaitPromise(capture({ send, session: sessions[0], counterparty: "Rappi" }))
        )).data;

        expect(general.categoryId).toBe(domicilios);

        const explicit = (yield* decodeJson(
          TransactionEnvelope,
          yield* awaitPromise(
            capture({ send, session: sessions[0], counterparty: "Rappi", categoryId: transporte })
          )
        )).data;

        expect(explicit.categoryId).toBe(transporte);

        const fallback = (yield* decodeJson(
          TransactionEnvelope,
          yield* awaitPromise(capture({ send, session: sessions[0] }))
        )).data;

        expect(fallback.categoryId).toBe(otros);
        expect(yield* storedCategory(db, userA, fallback.id)).toEqual(Option.some(otros));
        expect(yield* storedCategory(db, userA, specific.id)).toEqual(Option.some(mercado));
        expect(yield* storedCategory(db, userA, general.id)).toEqual(Option.some(domicilios));

        const inflow = (yield* decodeJson(
          TransactionEnvelope,
          yield* awaitPromise(capture({ send, session: sessions[0], direction: "inflow" }))
        )).data;

        expect(inflow.categoryId).toBe(ingresos);
      })
  );

  test.effect(
    "keeps a prior Transaction Category when its rule is replaced and when it is deleted",
    () =>
      Effect.gen(function* () {
        const { db, send, sessions } = yield* setup;

        const created = (yield* decodeJson(
          RuleEnvelope,
          yield* awaitPromise(
            createRule({ send, session: sessions[0], keyword: "Rappi", categoryId: domicilios })
          )
        )).data;

        const captured = (yield* decodeJson(
          TransactionEnvelope,
          yield* awaitPromise(capture({ send, session: sessions[0], counterparty: "Rappi" }))
        )).data;

        expect(captured.categoryId).toBe(domicilios);

        expect(
          (yield* awaitPromise(
            send({
              path: `/category-keyword-rules/${created.id}`,
              method: "PUT",
              session: sessions[0],
              payload: { keyword: "Rappi", categoryId: mercado },
            })
          )).status
        ).toBe(200);
        expect(yield* storedCategory(db, userA, captured.id)).toEqual(Option.some(domicilios));

        expect(
          (yield* awaitPromise(
            send({
              path: `/category-keyword-rules/${created.id}`,
              method: "DELETE",
              session: sessions[0],
            })
          )).status
        ).toBe(200);
        expect(yield* storedCategory(db, userA, captured.id)).toEqual(Option.some(domicilios));

        const afterDelete = (yield* decodeJson(
          TransactionEnvelope,
          yield* awaitPromise(capture({ send, session: sessions[0], counterparty: "Rappi" }))
        )).data;

        expect(afterDelete.categoryId).toBe(otros);
      })
  );

  test.effect("does not let another User's rule categorize a capture or be read", () =>
    Effect.gen(function* () {
      const { send, sessions } = yield* setup;
      yield* awaitPromise(createRule({ send, session: sessions[0], keyword: "Rappi" }));

      const captured = (yield* decodeJson(
        TransactionEnvelope,
        yield* awaitPromise(capture({ send, session: sessions[1], counterparty: "Rappi" }))
      )).data;

      expect(captured.categoryId).toBe(otros);

      const listed = yield* awaitPromise(
        send({ path: "/category-keyword-rules", method: "GET", session: sessions[1] })
      );

      expect((yield* decodeJson(RuleListEnvelope, listed)).data).toEqual([]);
    })
  );

  test.effect("stores no rule when its guarded audit evidence cannot commit", () =>
    Effect.gen(function* () {
      const { db, send, sessions } = yield* setup;
      yield* awaitPromise(
        db.exec(`CREATE TRIGGER refuse_keyword_rule_audit BEFORE INSERT ON audit_entries WHEN NEW.record_type='session_call' AND NEW.operation = 'categories.createKeywordRule' AND NEW.outcome = 'success'
    BEGIN SELECT RAISE(IGNORE); END`)
      );

      const refused = yield* awaitPromise(
        createRule({ send, session: sessions[0], keyword: "Sin evidencia" })
      );

      expect(refused.status).toBe(503);
      expect(yield* awaitPromise(refused.json())).toMatchObject({ error: { code: "unavailable" } });
      expect(yield* ruleCount(db, userA)).toBe(0);
      yield* awaitPromise(db.exec("DROP TRIGGER refuse_keyword_rule_audit"));
      expect(
        (yield* awaitPromise(createRule({ send, session: sessions[0], keyword: "Sin evidencia" })))
          .status
      ).toBe(201);
    })
  );

  test.effect("lets a write-scoped PAT manage rules while a read-scoped PAT cannot", () =>
    Effect.gen(function* () {
      const { db, send } = yield* setup;

      const writer = (yield* issuePAT({ db, scopes: ["write"], index: 1 })).bearer;
      const reader = (yield* issuePAT({ db, scopes: ["read"], index: 2 })).bearer;

      const refused = yield* awaitPromise(
        send({
          path: "/category-keyword-rules",
          method: "POST",
          bearer: reader,
          payload: { keyword: "Agente", categoryId: domicilios },
        })
      );

      expect(refused.status).toBe(403);
      expect(yield* ruleCount(db, userA)).toBe(0);

      const created = yield* awaitPromise(
        send({
          path: "/category-keyword-rules",
          method: "POST",
          bearer: writer,
          payload: { keyword: "Agente", categoryId: mercado },
        })
      );

      expect(created.status).toBe(201);
      const rule = (yield* decodeJson(RuleEnvelope, created)).data;

      const listed = yield* awaitPromise(
        send({ path: "/category-keyword-rules", method: "GET", bearer: reader })
      );

      expect(listed.status).toBe(200);
      expect((yield* decodeJson(RuleListEnvelope, listed)).data).toMatchObject([
        { id: rule.id, keyword: "agente", categoryId: mercado },
      ]);

      const refusedDelete = yield* awaitPromise(
        send({ path: `/category-keyword-rules/${rule.id}`, method: "DELETE", bearer: reader })
      );

      expect(refusedDelete.status).toBe(403);

      const audited = yield* awaitPromise(
        db
          .exec(
            "SELECT operation FROM audit_entries WHERE record_type='credential_call' AND operation = ?",
            "categories.createKeywordRule"
          )
          .then((rows) => rows[0])
      );

      expect(audited).toMatchObject({ operation: "categories.createKeywordRule" });
    })
  );

  test.effect("refuses a rule change from a revoked WebSession without storing anything", () =>
    Effect.gen(function* () {
      const { db, send, sessions } = yield* setup;
      yield* awaitPromise(
        db
          .exec("UPDATE web_sessions SET revoked_at_ms = ? WHERE user_id = ?", clock(), userA)
          .then((rows) => rows[0])
      );

      const refused = yield* awaitPromise(
        createRule({ send, session: sessions[0], keyword: "Revocada" })
      );

      expect(refused.status).toBe(401);
      expect(yield* ruleCount(db, userA)).toBe(0);
    })
  );

  test.effect("refuses cookie-admitted keyword-rule work without the matching browser Origin", () =>
    Effect.gen(function* () {
      const { db, send, sessions } = yield* setup;

      const created = (yield* decodeJson(
        RuleEnvelope,
        yield* awaitPromise(createRule({ send, session: sessions[0], keyword: "Rappi" }))
      )).data;

      const refusedRequests: ReadonlyArray<Send> = [
        { path: "/category-keyword-rules", method: "GET" },
        {
          path: "/category-keyword-rules",
          method: "POST",
          payload: { keyword: "Sin origen", categoryId: domicilios },
        },
        {
          path: `/category-keyword-rules/${created.id}`,
          method: "PUT",
          payload: { keyword: "Sin origen", categoryId: mercado },
        },
        { path: `/category-keyword-rules/${created.id}`, method: "DELETE" },
      ];

      yield* Effect.forEach(
        refusedRequests,
        Effect.fnUntraced(function* (request) {
          const originless = yield* awaitPromise(
            send({ ...request, session: sessions[0], originless: true })
          );

          expect(originless.status).toBe(403);

          const foreignOrigin = yield* awaitPromise(
            send({ ...request, session: sessions[0], origin: "https://evil.example" })
          );

          expect(foreignOrigin.status).toBe(403);
        }),
        { discard: true }
      );

      expect(yield* ruleCount(db, userA)).toBe(1);

      const untouched = yield* awaitPromise(
        db
          .exec("SELECT keyword, category_id FROM keyword_rules WHERE id = ?", created.id)
          .then((rows) => rows[0])
      );

      expect(untouched).toEqual({ keyword: "rappi", category_id: domicilios });

      const audits = yield* awaitPromise(
        db
          .exec(
            "SELECT count(*) AS total FROM (SELECT id,user_id,session_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='session_call') AS session_audit WHERE operation GLOB 'categories.*' AND user_id = ?",
            userA
          )
          .then((rows) => rows[0])
      );

      expect(audits?.total).toBe(1);

      const machine = yield* issuePAT({ db, scopes: ["write"], index: 9 });

      const machineCreate = yield* awaitPromise(
        send({
          path: "/category-keyword-rules",
          method: "POST",
          bearer: machine.bearer,
          originless: true,
          payload: { keyword: "Sin origen", categoryId: domicilios },
        })
      );

      expect(machineCreate.status).toBe(201);
    })
  );

  test.effect("a WebSession past its idle expiry cannot read its keyword rules", () =>
    Effect.gen(function* () {
      const { db, send, sessions } = yield* setup;
      expect(
        (yield* native(() =>
          send({ path: "/category-keyword-rules", method: "GET", session: sessions[0] })
        )).status
      ).toBe(200);
      yield* native(() =>
        db.exec(
          "UPDATE web_sessions SET idle_expires_at_ms=created_at_ms+1 WHERE id=?",
          alice.session
        )
      );
      expect(
        (yield* native(() =>
          send({ path: "/category-keyword-rules", method: "GET", session: sessions[0] })
        )).status
      ).toBe(401);
    })
  );
});
