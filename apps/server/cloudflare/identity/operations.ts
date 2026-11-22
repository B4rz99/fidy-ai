import type { ReservedIdentity } from "../directory/contract";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import type { LocalMutationPlan, LocalMutationResult } from "../canonical-admission/contract";
import { prepareLocalWrite } from "../canonical-admission/operations";
import { prepareCurrentUser } from "../../src/shell/identity/operations";
import { IdentityUnavailable } from "./contract";
import { Effect, Schema } from "effect";
import { User, type UserId, type UserPreferences } from "../../src/core/identity/contract";

export const readLocalProfile = Effect.fn(function* (user: UserId) {
  const sql = yield* SqliteClient;
  const read = yield* prepareCurrentUser(user);
  const result = yield* read.decode(yield* sql.unsafe(read.statement.sql, read.statement.params));

  return {
    status: 200,
    outcome: "success" as const,
    body: { data: yield* Schema.encodeEffect(User)(result.data), next: [] },
  } satisfies LocalMutationResult;
});

export const prepareLocalPreferences = ({
  user,
  preferences,
}: Readonly<{ user: UserId; preferences: UserPreferences }>): LocalMutationPlan =>
  prepareLocalWrite({
    targets: ["identity.preferences"],
    commit: Effect.gen(function* () {
      const sql = yield* SqliteClient;

      const changed =
        yield* sql`UPDATE users SET locale=${preferences.locale},time_zone=${preferences.timeZone} WHERE id=${user} RETURNING id`;

      if (changed.length !== 1) return yield* new IdentityUnavailable();

      return yield* readLocalProfile(user);
    }),
  });

export const activateWhatsAppIdentity = Effect.fn(function* (change: typeof ReservedIdentity.Type) {
  const sql = yield* SqliteClient;

  const rows =
    yield* sql`UPDATE users SET whatsapp_bsuid=${change.next_key},whatsapp_revision=whatsapp_revision+1,whatsapp_verified_at_ms=${change.occurred_at_ms} WHERE id=${change.user_id} AND whatsapp_portfolio_id=${change.scope} AND whatsapp_bsuid=${change.prior_key} AND whatsapp_verified_at_ms<${change.occurred_at_ms} AND whatsapp_revision=${change.revision} AND lifetime_registered=1 AND NOT EXISTS(SELECT 1 FROM erasure_requests) RETURNING 1`;

  return rows.length === 1;
});
