import { DurableObject } from "cloudflare:workers";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Effect, Option, Schema } from "effect";
import { CategoryId, CategoryReference } from "../../src/core/categories/contract";
import { currentCategoryRelease, interpretCategory } from "../../src/core/categories/operations";
import { UserId } from "../../src/core/identity/contract";
import { createStoreRuntime } from "../runtime/sqlite/operations";
import { UserStore } from "../user-store/runtime";
import { categorizeLocalCapture } from "./operations";

const Capture = Schema.Struct({
  user: UserId,
  id: Schema.String,
  caller: Schema.OptionFromNullOr(CategoryId),
});

export class CategoryProbe extends DurableObject<ConstructorParameters<typeof UserStore>[1]> {
  private readonly store;
  private readonly runtime;
  constructor(state: DurableObjectState, env: ConstructorParameters<typeof UserStore>[1]) {
    super(state, env);
    this.store = new UserStore(state, env);
    this.runtime = createStoreRuntime({
      storage: state.storage,
      owner: "user",
      ceilingBytes: env.SQLITE_STORE_CAPACITY_BYTES,
    });
  }
  override alarm(): Promise<void> {
    return this.store.alarm();
  }
  override fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/fixture/capture") return this.store.fetch(request);
    const owns = (id: string): boolean => this.ctx.id.equals(this.env.USER_STORE.idFromName(id));

    return this.runtime.runPromise(
      Effect.gen(function* () {
        const input = yield* Effect.tryPromise(() => request.json()).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Capture))
        );

        if (!owns(input.user)) return new Response(null, { status: 403 });
        const sql = yield* SqliteClient;

        const result = yield* sql.withTransaction(
          Effect.gen(function* () {
            const choice = yield* categorizeLocalCapture({
              userId: input.user,
              capture: {
                direction: "outflow",
                caller: input.caller,
                counterparty: Option.some("Mercado Central"),
              },
            });

            yield* sql`INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,category_revision,occurred_at_ms,created_at_ms)
          VALUES (${input.id},${input.user},'100','COP','outflow',${choice.categoryId},${choice.revision},1,1)`;

            return choice;
          })
        );

        return Response.json(result);
      }).pipe(
        Effect.tapCause(() =>
          Effect.logWarning({
            component: "categories",
            operation: "fixtureCapture",
            outcome: "conflict",
          })
        ),
        Effect.catchCause(() => Effect.succeed(new Response(null, { status: 409 })))
      )
    );
  }
}

export const observerWorker = {
  fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/release") {
      return Promise.resolve(Response.json(currentCategoryRelease));
    }

    return request.json().then((raw) => {
      const reference = Schema.decodeUnknownSync(CategoryReference)(raw);
      const category = interpretCategory({ release: currentCategoryRelease, reference });

      return Option.isNone(category)
        ? new Response(null, { status: 409 })
        : Response.json(category.value);
    });
  },
};
