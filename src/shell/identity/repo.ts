import { Effect, Option, Schema, Struct } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { type E164PhoneNumber, UserId } from "~/core/identity/reference";
import { User, UserPreferences, WhatsAppIdentity } from "~/core/identity/model";

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

const userColumns = `id, service_market AS "serviceMarket", locale,
  time_zone AS "timeZone", created_at AS "createdAt"`;

/**
 * Inserts or refreshes one development User with all three context columns
 * supplied independently. Production creation can reuse the same row
 * boundary without gaining implicit defaults from PostgreSQL.
 */
export const upsertUser = Effect.fn("upsertUser")(function* (
  userId: UserId,
  attributes: typeof UserWithoutId.Type
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOne({
    Request: UserRow,
    Result: UserRow,
    execute: (row) => sql`
      INSERT INTO users (id, service_market, locale, time_zone, created_at)
      VALUES (${row.id}, ${row.serviceMarket}, ${row.locale}, ${row.timeZone}, ${row.createdAt})
      ON CONFLICT (id) DO UPDATE SET
        service_market = EXCLUDED.service_market,
        locale = EXCLUDED.locale,
        time_zone = EXCLUDED.time_zone,
        created_at = EXCLUDED.created_at
      RETURNING ${sql.literal(userColumns)}
    `,
  })({ ...attributes, id: userId }).pipe(Effect.orDie);
});

/** Finds the stable User and all independently persisted interpretation context. */
export const findUser = (userId: UserId) =>
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
  ).pipe(Effect.orDie);

/**
 * Updates only ordinary User presentation preferences. The request projection
 * has no ServiceMarket field and the statement never writes its column.
 */
export const updateUserPreferences = Effect.fn("updateUserPreferences")(function* (
  userId: UserId,
  preferences: UserPreferences
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOneOption({
    Request: UserPreferencesRow,
    Result: UserRow,
    execute: (row) => sql`
      UPDATE users
      SET locale = ${row.locale}, time_zone = ${row.timeZone}
      WHERE id = ${row.userId}
      RETURNING ${sql.literal(userColumns)}
    `,
  })({ userId, ...preferences }).pipe(Effect.orDie);
});

/**
 * Associates a channel-verified normalized WhatsApp number with the stable User
 * the adapter has already established. Reassociation replaces only channel
 * evidence; it never creates or changes User ownership. Database failures are
 * defects.
 */
export const associateWhatsAppIdentity = Effect.fn("associateWhatsAppIdentity")(function* (
  userId: UserId,
  identity: typeof WhatsAppIdentityWithoutUserId.Type
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOne({
    Request: WhatsAppIdentityRow,
    Result: WhatsAppIdentityRow,
    execute: (row) => sql`
      INSERT INTO whatsapp_identities (user_id, phone_number, verified_at)
      VALUES (${row.userId}, ${row.phoneNumber}, ${row.verifiedAt})
      ON CONFLICT (user_id) DO UPDATE SET
        phone_number = EXCLUDED.phone_number,
        verified_at = EXCLUDED.verified_at
      RETURNING user_id AS "userId", phone_number AS "phoneNumber",
        verified_at AS "verifiedAt"
    `,
  })({ ...identity, userId }).pipe(Effect.orDie);
});

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
        SELECT user_id AS "userId"
        FROM whatsapp_identities
        WHERE phone_number = ${phoneNumber}
      `,
    })({ phoneNumber })
  ).pipe(Effect.map(Option.map(({ userId }) => userId)), Effect.orDie);
