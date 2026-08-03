import { Effect, Option, Schema, Struct } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { type E164PhoneNumber, UserId } from "~/core/identity/reference";
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
const WhatsAppIdentityWithoutVerifiedAt = WhatsAppIdentity.mapFields(Struct.omit(["verifiedAt"]));
const WhatsAppIdentityRow = Schema.Struct({
  ...WhatsAppIdentityWithoutVerifiedAt.fields,
  verifiedAt: Schema.DateTimeUtcFromDate,
});
const WhatsAppLookup = WhatsAppIdentity.mapFields(Struct.pick(["phoneNumber"]));
const WhatsAppIdentityByUser = WhatsAppIdentity.mapFields(Struct.pick(["userId"]));

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
export const findUser = (userId: UserId) =>
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
  mode: "insert" | "associate",
  userId: UserId,
  identity: typeof WhatsAppIdentityWithoutUserId.Type
) {
  const sql = yield* SqlClient.SqlClient;
  const conflict =
    mode === "associate"
      ? sql`ON CONFLICT (user_id) DO UPDATE SET
          phone_number = EXCLUDED.phone_number,
          verified_at = EXCLUDED.verified_at`
      : sql``;
  return yield* withUserTransaction(
    userId,
    SqlSchema.findOne({
      Request: WhatsAppIdentityRow,
      Result: WhatsAppIdentityRow,
      execute: (row) => sql`
        INSERT INTO whatsapp_identities (user_id, phone_number, verified_at)
        VALUES (${row.userId}, ${row.phoneNumber}, ${row.verifiedAt})
        ${conflict}
        RETURNING user_id AS "userId", phone_number AS "phoneNumber",
          verified_at AS "verifiedAt"
      `,
    })({ ...identity, userId }).pipe(Effect.orDie)
  );
});

/**
 * Associates verified WhatsApp evidence with a stable User. Reassociation
 * replaces only channel evidence and persistence failures are defects.
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

const findAndLockWhatsAppIdentityInTransaction = (userId: UserId) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    SqlSchema.findOneOption({
      Request: WhatsAppIdentityByUser,
      Result: WhatsAppIdentityRow,
      execute: ({ userId }) => sql`
        SELECT user_id AS "userId", phone_number AS "phoneNumber",
          verified_at AS "verifiedAt"
        FROM whatsapp_identities
        WHERE user_id = ${userId}
        FOR SHARE
      `,
    })({ userId })
  ).pipe(Effect.orDie);

/** Locks and reads the current association in a User-scoped transaction. */
export const findAndLockWhatsAppIdentity = (userId: UserId) =>
  withUserTransaction(userId, findAndLockWhatsAppIdentityInTransaction(userId));

/** Reads the User's current verified WhatsApp association. */
export const findWhatsAppIdentity = (userId: UserId) =>
  withUserTransaction(
    userId,
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      SqlSchema.findOneOption({
        Request: WhatsAppIdentityByUser,
        Result: WhatsAppIdentityRow,
        execute: ({ userId }) => sql`
          SELECT user_id AS "userId", phone_number AS "phoneNumber",
            verified_at AS "verifiedAt"
          FROM whatsapp_identities
          WHERE user_id = ${userId}
        `,
      })({ userId })
    ).pipe(Effect.orDie)
  );

/**
 * Resolves channel-verified WhatsApp evidence to its stable User. Only the
 * normalized phone association participates; provider contact and message ids
 * are deliberately absent. An unassociated number returns `None`, and database
 * failures are defects.
 */
export const resolveWhatsAppCaller = (phoneNumber: E164PhoneNumber) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    SqlSchema.findOneOption({
      Request: WhatsAppLookup,
      Result: Schema.Struct({ userId: UserId }),
      execute: ({ phoneNumber }) => sql`
        SELECT resolved.user_id AS "userId"
        FROM (SELECT fidy_resolve_whatsapp_user(${phoneNumber}) AS user_id) AS resolved
        WHERE resolved.user_id IS NOT NULL
      `,
    })({ phoneNumber })
  ).pipe(Effect.map(Option.map(({ userId }) => userId)), Effect.orDie);
