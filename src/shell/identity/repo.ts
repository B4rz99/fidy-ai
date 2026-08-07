import { DateTime, Effect, Option, Schema, Struct } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { ProviderMessageEvidence } from "~/core/_shared/provider-message-evidence";
import {
  E164PhoneNumber,
  UserId,
  WhatsAppCallerReference,
  WhatsAppParentBusinessScopedUserId,
  WhatsAppUsername,
} from "~/core/identity/reference";
import { User, UserPreferences, WhatsAppIdentity } from "~/core/identity/model";
import { withUserTransaction } from "~/shell/db/user-transaction";

const UserWithoutId = User.mapFields(Struct.omit(["id"]));
const UserWithoutCreatedAt = User.mapFields(Struct.omit(["createdAt"]));
const UserRow = Schema.Struct({
  ...UserWithoutCreatedAt.fields,
  createdAt: Schema.DateTimeUtcFromDate,
});

const UserPreferencesRow = Schema.Struct({
  userId: UserId,
  ...UserPreferences.fields,
});

const WhatsAppIdentityWithoutUserId = WhatsAppIdentity.mapFields(Struct.omit(["userId"]));
const WhatsAppReplacementEvidence = WhatsAppIdentityWithoutUserId.mapFields(
  Struct.omit(["businessPortfolioId"])
);
const WhatsAppCallerObservation = WhatsAppIdentity.mapFields(Struct.omit(["userId", "verifiedAt"]));
const WhatsAppIdentityRow = WhatsAppIdentity.mapFields(
  Struct.evolve({
    parentBusinessScopedUserId: () => Schema.OptionFromNullOr(WhatsAppParentBusinessScopedUserId),
    username: () => Schema.OptionFromNullOr(WhatsAppUsername),
    phoneNumber: () => Schema.OptionFromNullOr(E164PhoneNumber),
    verifiedAt: () => Schema.DateTimeUtcFromDate,
  })
);
const WhatsAppIdentityByUser = WhatsAppIdentity.mapFields(Struct.pick(["userId"]));
const WhatsAppReassociationRequest = Schema.Struct({
  providerMessageId: ProviderMessageEvidence.fields.providerMessageId,
  previousBusinessPortfolioId: WhatsAppIdentity.fields.businessPortfolioId,
  previousBusinessScopedUserId: WhatsAppIdentity.fields.businessScopedUserId,
  replacementBusinessScopedUserId: WhatsAppIdentity.fields.businessScopedUserId,
  parentBusinessScopedUserId: WhatsAppIdentityRow.fields.parentBusinessScopedUserId,
  username: WhatsAppIdentityRow.fields.username,
  phoneNumber: WhatsAppIdentityRow.fields.phoneNumber,
  occurredAt: Schema.DateTimeUtcFromDate,
});

const userColumns = `id, service_market AS "serviceMarket", locale,
  time_zone AS "timeZone", created_at AS "createdAt"`;

const writeUser = Effect.fn("Identity.writeUser")(function* (
  mode: "insert" | "upsert",
  userId: UserId,
  attributes: typeof UserWithoutId.Type
) {
  const sql = yield* SqlClient.SqlClient;
  const conflict =
    mode === "upsert"
      ? sql`ON CONFLICT (id) DO UPDATE SET
          service_market = EXCLUDED.service_market,
          locale = EXCLUDED.locale,
          time_zone = EXCLUDED.time_zone,
          created_at = EXCLUDED.created_at`
      : sql``;
  return yield* withUserTransaction(
    userId,
    SqlSchema.findOne({
      Request: UserRow,
      Result: UserRow,
      execute: (row) => sql`
        INSERT INTO users (id, service_market, locale, time_zone, created_at)
        VALUES (${row.id}, ${row.serviceMarket}, ${row.locale}, ${row.timeZone}, ${row.createdAt})
        ${conflict}
        RETURNING ${sql.literal(userColumns)}
      `,
    })({ ...attributes, id: userId }).pipe(Effect.orDie)
  );
});

/**
 * Inserts or refreshes one development User with independently supplied
 * context, returning the canonical persisted row; database failures are defects.
 */
export const upsertUser = Effect.fn("upsertUser")(
  (userId: UserId, attributes: typeof UserWithoutId.Type) => writeUser("upsert", userId, attributes)
);

/** Inserts a production User exactly once; identity conflicts are defects. */
export const insertUser = Effect.fn("insertUser")(
  (userId: UserId, attributes: typeof UserWithoutId.Type) => writeUser("insert", userId, attributes)
);

/** Finds the stable User and all independently persisted interpretation context. */
export const findUser = (
  userId: UserId
): Effect.Effect<Option.Option<typeof UserRow.Type>, never, SqlClient.SqlClient> =>
  withUserTransaction(
    userId,
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      SqlSchema.findOneOption({
        Request: UserId,
        Result: UserRow,
        execute: (id) => sql`
        SELECT ${sql.literal(userColumns)}
        FROM users
        WHERE id = ${id}
      `,
      })(userId)
    ).pipe(Effect.orDie)
  );

/**
 * Updates only ordinary User presentation preferences. The request projection
 * has no ServiceMarket field and the statement never writes its column.
 */
export const updateUserPreferences = Effect.fn("updateUserPreferences")(function* (
  userId: UserId,
  preferences: UserPreferences
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* withUserTransaction(
    userId,
    SqlSchema.findOneOption({
      Request: UserPreferencesRow,
      Result: UserRow,
      execute: (row) => sql`
      UPDATE users
      SET locale = ${row.locale}, time_zone = ${row.timeZone}
      WHERE id = ${row.userId}
      RETURNING ${sql.literal(userColumns)}
    `,
    })({ userId, ...preferences }).pipe(Effect.orDie)
  );
});

const writeWhatsAppIdentity = Effect.fn("Identity.writeWhatsApp")(function* (
  mode: "insert" | "associate" | "observe",
  userId: UserId,
  identity: typeof WhatsAppIdentityWithoutUserId.Type
) {
  const sql = yield* SqlClient.SqlClient;
  let conflict = sql``;
  if (mode === "associate") {
    conflict = sql`ON CONFLICT (user_id, business_portfolio_id) DO UPDATE SET
      business_scoped_user_id = EXCLUDED.business_scoped_user_id,
      parent_business_scoped_user_id = EXCLUDED.parent_business_scoped_user_id,
      username = EXCLUDED.username,
      phone_number = COALESCE(EXCLUDED.phone_number, whatsapp_identities.phone_number),
      verified_at = EXCLUDED.verified_at`;
  } else if (mode === "observe") {
    conflict = sql`ON CONFLICT (business_portfolio_id, business_scoped_user_id) DO UPDATE SET
      parent_business_scoped_user_id = CASE
        WHEN EXCLUDED.verified_at >= whatsapp_identities.verified_at
        THEN EXCLUDED.parent_business_scoped_user_id
        ELSE whatsapp_identities.parent_business_scoped_user_id
      END,
      username = CASE
        WHEN EXCLUDED.verified_at >= whatsapp_identities.verified_at
        THEN EXCLUDED.username
        ELSE whatsapp_identities.username
      END,
      phone_number = CASE
        WHEN EXCLUDED.verified_at >= whatsapp_identities.verified_at
        THEN COALESCE(EXCLUDED.phone_number, whatsapp_identities.phone_number)
        ELSE whatsapp_identities.phone_number
      END,
      verified_at = whatsapp_identities.verified_at`;
  }
  return yield* withUserTransaction(
    userId,
    SqlSchema.findOne({
      Request: WhatsAppIdentityRow,
      Result: WhatsAppIdentityRow,
      execute: (row) => sql`
        INSERT INTO whatsapp_identities (
          user_id, business_portfolio_id, business_scoped_user_id,
          parent_business_scoped_user_id, username, phone_number, verified_at
        ) VALUES (
          ${row.userId}, ${row.businessPortfolioId}, ${row.businessScopedUserId},
          ${row.parentBusinessScopedUserId}, ${row.username}, ${row.phoneNumber}, ${row.verifiedAt}
        )
        ${conflict}
        RETURNING user_id AS "userId", business_portfolio_id AS "businessPortfolioId",
          business_scoped_user_id AS "businessScopedUserId",
          parent_business_scoped_user_id AS "parentBusinessScopedUserId", username,
          phone_number AS "phoneNumber", verified_at AS "verifiedAt"
      `,
    })({ ...identity, userId }).pipe(Effect.orDie)
  );
});

/**
 * Explicitly associates authenticated WhatsApp evidence with a stable User in one Business
 * Portfolio. The association replaces that User's BSUID and mutable evidence for the portfolio;
 * absent phone evidence preserves the previously observed phone. Other User data is unchanged,
 * and persistence failures are defects.
 */
export const associateWhatsAppIdentity = Effect.fn("associateWhatsAppIdentity")(
  (userId: UserId, identity: typeof WhatsAppIdentityWithoutUserId.Type) =>
    writeWhatsAppIdentity("associate", userId, identity)
);

/** Inserts the first verified WhatsApp association; conflicts are defects. */
export const insertWhatsAppIdentity = Effect.fn("insertWhatsAppIdentity")(
  (userId: UserId, identity: typeof WhatsAppIdentityWithoutUserId.Type) =>
    writeWhatsAppIdentity("insert", userId, identity)
);

const findAndLockWhatsAppIdentityInTransaction = (
  userId: UserId
): Effect.Effect<Option.Option<typeof WhatsAppIdentityRow.Type>, never, SqlClient.SqlClient> =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    SqlSchema.findOneOption({
      Request: WhatsAppIdentityByUser,
      Result: WhatsAppIdentityRow,
      execute: ({ userId }) => sql`
        SELECT user_id AS "userId", business_portfolio_id AS "businessPortfolioId",
          business_scoped_user_id AS "businessScopedUserId",
          parent_business_scoped_user_id AS "parentBusinessScopedUserId", username,
          phone_number AS "phoneNumber", verified_at AS "verifiedAt"
        FROM whatsapp_identities
        WHERE user_id = ${userId}
        ORDER BY verified_at DESC
        LIMIT 1
        FOR SHARE
      `,
    })({ userId })
  ).pipe(Effect.orDie);

/** Locks the User's most recently verified association across Business Portfolios. */
export const findAndLockWhatsAppIdentity = (
  userId: UserId
): Effect.Effect<Option.Option<typeof WhatsAppIdentityRow.Type>, never, SqlClient.SqlClient> =>
  withUserTransaction(userId, findAndLockWhatsAppIdentityInTransaction(userId));

/** Reads the User's most recently verified association across Business Portfolios. */
export const findWhatsAppIdentity = (
  userId: UserId
): Effect.Effect<Option.Option<typeof WhatsAppIdentityRow.Type>, never, SqlClient.SqlClient> =>
  withUserTransaction(
    userId,
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      SqlSchema.findOneOption({
        Request: WhatsAppIdentityByUser,
        Result: WhatsAppIdentityRow,
        execute: ({ userId }) => sql`
          SELECT user_id AS "userId", business_portfolio_id AS "businessPortfolioId",
            business_scoped_user_id AS "businessScopedUserId",
            parent_business_scoped_user_id AS "parentBusinessScopedUserId", username,
            phone_number AS "phoneNumber", verified_at AS "verifiedAt"
          FROM whatsapp_identities
          WHERE user_id = ${userId}
          ORDER BY verified_at DESC
          LIMIT 1
        `,
      })({ userId })
    ).pipe(Effect.orDie)
  );

/** Resolves only the authoritative Business Portfolio and BSUID pair without refreshing evidence. */
export const findWhatsAppCaller = Effect.fn("findWhatsAppCaller")(function* (
  caller: WhatsAppCallerReference
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOneOption({
    Request: WhatsAppCallerReference,
    Result: Schema.Struct({ userId: UserId }),
    execute: (input) => sql`
        SELECT resolved.user_id AS "userId"
        FROM (SELECT fidy_resolve_whatsapp_user(
          ${input.businessPortfolioId}, ${input.businessScopedUserId}
        ) AS user_id) AS resolved
        WHERE resolved.user_id IS NOT NULL
      `,
  })(caller).pipe(Effect.map(Option.map((row) => row.userId)), Effect.orDie);
});

/**
 * Atomically applies one authenticated provider identity change and retains its provider id as
 * evidence. Exact replay and stale events are acknowledged without changing current authority;
 * unknown transitions return None for provider retry. Missing replacement evidence clears stale
 * observations, and phone evidence never authorizes the change.
 */
export const reassociateWhatsAppIdentity = Effect.fn("reassociateWhatsAppIdentity")(function* (
  previousCaller: WhatsAppCallerReference,
  replacement: typeof WhatsAppReplacementEvidence.Type,
  providerMessageId: typeof ProviderMessageEvidence.fields.providerMessageId.Type
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOneOption({
    Request: WhatsAppReassociationRequest,
    Result: Schema.Struct({ acknowledged: Schema.Boolean }),
    execute: (request) => sql`
      SELECT reassociated.acknowledged
      FROM (SELECT fidy_reassociate_whatsapp_user(
        ${request.previousBusinessPortfolioId},
        ${request.previousBusinessScopedUserId},
        ${request.replacementBusinessScopedUserId},
        ${request.parentBusinessScopedUserId},
        ${request.username},
        ${request.phoneNumber},
        ${request.occurredAt},
        ${request.providerMessageId}
      ) AS acknowledged) AS reassociated
      WHERE reassociated.acknowledged IS NOT NULL
    `,
  })({
    providerMessageId,
    previousBusinessPortfolioId: previousCaller.businessPortfolioId,
    previousBusinessScopedUserId: previousCaller.businessScopedUserId,
    replacementBusinessScopedUserId: replacement.businessScopedUserId,
    parentBusinessScopedUserId: replacement.parentBusinessScopedUserId,
    username: replacement.username,
    phoneNumber: replacement.phoneNumber,
    occurredAt: replacement.verifiedAt,
  }).pipe(Effect.orDie);
});

/**
 * Resolves a caller only from its trusted Business Portfolio and authenticated BSUID. Phone,
 * username, and parent-BSUID observations never participate in authorization. A successful match
 * refreshes mutable evidence without changing the association; unknown callers return None and
 * persistence failures are defects. `observedAt` defaults to the epoch for callers without a
 * provider occurrence time, so it cannot supersede later evidence.
 */
export const resolveWhatsAppCaller = Effect.fn("resolveWhatsAppCaller")(function* (
  caller: typeof WhatsAppCallerObservation.Type,
  observedAt: typeof Schema.DateTimeUtc.Type = DateTime.makeUnsafe(0)
) {
  const resolved = yield* findWhatsAppCaller(caller);
  if (Option.isNone(resolved)) return Option.none<UserId>();
  yield* writeWhatsAppIdentity("observe", resolved.value, {
    ...caller,
    verifiedAt: observedAt,
  });
  return Option.some(resolved.value);
});
