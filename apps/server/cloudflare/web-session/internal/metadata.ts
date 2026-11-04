import { UserId } from "../../../src/core/identity/contract";
import { Clock, DateTime, Effect, Option, Schema } from "effect";
import { prepareCurrentUser } from "../../../src/shell/identity/operations";
import type { CurrentUserMetadata } from "../../../src/shell/identity/contract";
import { decodeCategoryRead, prepareCategoryRead } from "../../../src/shell/categories/operations";
import { protectConsentStatement } from "../../../src/shell/consent/operations";
import { webSessionCredentialAuthority } from "../../../src/shell/web-session/operations";
import { webSessionIdleRenewalCandidate } from "../../../src/core/web-session/operations";
import type { AuthenticatedWebSession, WebSessionSnapshotContext } from "../contract";
import type { BrowserSessionInitialContext } from "../../../src/shell/web-session/contract";
import {
  decodeProcessingConsentStatusRead,
  prepareProcessingConsentStatusRead,
} from "../../../src/shell/processing-consent/operations";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import { attempt, uuid } from "./support";

type Input = Readonly<{ db: D1Database; subject: AuthenticatedWebSession }>;
const statements = (
  { db, subject }: Input,
  current: number,
  read: OwnedStatement
): ReadonlyArray<D1PreparedStatement> => {
  const authority = webSessionCredentialAuthority({ subject, current });
  const candidate = DateTime.toEpochMillis(
    webSessionIdleRenewalCandidate(DateTime.makeUnsafe(current))
  );
  const active = protectConsentStatement({
    statement: read,
    subject: { _tag: "User", userId: subject.userId },
    requirement: "unrevoked",
  });
  return [
    db
      .prepare(`UPDATE web_sessions SET idle_expires_at_ms = min(hard_expires_at_ms,
      max(idle_expires_at_ms, ?)) WHERE ${authority.predicate}`)
      .bind(candidate, ...authority.bindings),
    db
      .prepare(
        `SELECT * FROM (${active.sql}) WHERE EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`
      )
      .bind(...active.params, ...authority.bindings),
    prepareCategoryRead({ db, authority: Option.none() }),
    db
      .prepare(`INSERT INTO audit_entries(record_type,id,user_id,session_id,occurred_at_ms)
      SELECT 'identity_read',?,?,?,? WHERE EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})
      AND EXISTS (${active.sql})`)
      .bind(uuid(), subject.userId, subject.id, current, ...authority.bindings, ...active.params),
  ];
};

/** One atomic live-credential renewal, active-Consent metadata read, taxonomy read and identity Audit. */
export const readMetadata = (
  input: Input
): Effect.Effect<Option.Option<typeof CurrentUserMetadata.Type>, void> =>
  Effect.gen(function* () {
    const userId = yield* Schema.decodeEffect(UserId)(input.subject.userId).pipe(
      Effect.mapError(() => undefined)
    );
    const prepared = yield* prepareCurrentUser(userId).pipe(Effect.mapError(() => undefined));
    const current = yield* Clock.currentTimeMillis;
    // This one callback owns writes; interruption waits for the submitted native unit to settle.
    const rows = yield* attempt(() =>
      input.db.batch([...statements(input, current, prepared.statement)])
    ).pipe(Effect.uninterruptible);
    const user = rows[1];
    const taxonomy = rows[2];
    if (
      rows[0]?.meta.changes !== 1 ||
      rows[3]?.meta.changes !== 1 ||
      user === undefined ||
      taxonomy === undefined
    ) {
      return Option.none();
    }
    const loaded = yield* prepared.decode(user.results).pipe(Effect.mapError(() => undefined));
    const categories = decodeCategoryRead(taxonomy.results);
    return Option.map(categories, (value) => ({ ...loaded, categories: Option.some(value.data) }));
  });

/** The same live renewal and identity Audit participate in the caller's larger native unit. */
export const snapshotContext = (
  input: WebSessionSnapshotContext
): Effect.Effect<BrowserSessionInitialContext, void> =>
  Effect.gen(function* () {
    const statusRead = prepareProcessingConsentStatusRead(input);
    const statusRows = input.execute([input.db.prepare(statusRead.sql).bind(...statusRead.params)]);
    const status = yield* decodeProcessingConsentStatusRead(statusRows[0]?.results ?? []).pipe(
      Effect.mapError(() => undefined)
    );
    if (Option.isNone(status)) return yield* Effect.fail(undefined);
    if (status.value.status !== "Granted") return status.value;
    const userId = yield* Schema.decodeEffect(UserId)(input.subject.userId).pipe(
      Effect.mapError(() => undefined)
    );
    const prepared = yield* prepareCurrentUser(userId).pipe(Effect.mapError(() => undefined));
    const rows = input.execute(statements(input, input.current, prepared.statement));
    const profile = yield* decodeSnapshotProfile(rows, prepared);
    return {
      ...status.value,
      profile,
      transactions: Option.none(),
    };
  });

const decodeSnapshotProfile = (
  rows: ReadonlyArray<D1Result>,
  prepared: Effect.Success<ReturnType<typeof prepareCurrentUser>>
): Effect.Effect<typeof CurrentUserMetadata.Type, void> =>
  Effect.gen(function* () {
    const user = rows[1];
    const taxonomy = rows[2];
    if (
      rows[0]?.meta.changes !== 1 ||
      rows[3]?.meta.changes !== 1 ||
      user === undefined ||
      taxonomy === undefined
    ) {
      return yield* Effect.fail(undefined);
    }
    const loaded = yield* prepared.decode(user.results).pipe(Effect.mapError(() => undefined));
    const categories = decodeCategoryRead(taxonomy.results);
    if (Option.isNone(categories)) return yield* Effect.fail(undefined);
    return { ...loaded, categories: Option.some(categories.value.data) };
  });
