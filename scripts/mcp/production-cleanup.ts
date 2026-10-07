import { Effect, FileSystem, Option, Schema } from "effect";
import {
  type ApprovedScope,
  VerificationFailure,
  budgetCategories,
  query,
  readJson,
  requireCheck,
  writeJson,
} from "./production-fixture";
import { type NativeHost, nativeTools } from "./production-native";

const BudgetIdentity = Schema.Struct({ id: Schema.String.check(Schema.isUUID()) });
const CleanupBudgets = Schema.Array(
  Schema.Struct({
    id: Schema.String.check(Schema.isUUID()),
    currency: Schema.Literal("COP"),
    cap: Schema.Literal("1000"),
  })
).check(Schema.isMaxLength(1));
/** A zero-Budget fixture baseline makes the host's fixed Category an unambiguous recovery boundary. Never retry creation after lost delivery. */
export const disposeBudget = Effect.fn(function* (
  context: Readonly<{ scope: ApprovedScope; root: string }>,
  host: NativeHost
) {
  const { scope, root } = context;
  const fs = yield* FileSystem.FileSystem;
  const path = `${root}/${host}-budget-private.json`;
  const ownedSql = `SELECT id, currency, cap FROM budgets WHERE user_id='${scope.fixtureUserId}' AND category_id='${budgetCategories[host]}' LIMIT 2;`;
  const rows = yield* query(scope, ownedSql).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(CleanupBudgets)),
    Effect.mapError(
      () => new VerificationFailure({ message: "Budget cleanup ownership was ambiguous" })
    )
  );
  const owned = rows[0];
  if (owned === undefined) return;
  if (yield* fs.exists(path)) {
    const saved = yield* readJson(BudgetIdentity, path);
    yield* requireCheck(saved.id === owned.id, "Budget cleanup identity did not match its fixture");
  } else {
    yield* writeJson(path, { id: owned.id });
  }
  yield* nativeTools({
    host,
    binary: scope.binaries[host],
    root,
    mode: "accept",
    namespace: scope.namespace,
    mcpUrl: Option.none(),
  });
  const remaining = yield* query(scope, ownedSql);
  yield* requireCheck(remaining.length === 0, "Budget remained after native cleanup confirmation");
});
