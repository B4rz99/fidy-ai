import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect, Exit, Option, type Redacted, Schema } from "effect";
import { UserId } from "../../../src/core/identity/contract";
import { InstitutionId } from "../../../src/core/connections/contract";
import { CreateTransactionInput } from "../../../src/core/transactions/contract";
import { type SynchronizationProvider, SynchronizationWork } from "../contract";
import { newId } from "../../secret-material/operations";
import { preserveStoreAlarm, withStoreCapacity } from "../../runtime/sqlite/operations";
import { prepareConnectionMovement } from "../../transactions/operations";
import { commitLocalWrite } from "../../canonical-admission/operations";
import { institutionsForUser } from "./institution-registration";
import { failed, one } from "./sqlite-browser";
import { grantPurpose, openGrant } from "./grant";

const maximumLifetimeMs = 3600000;

const offerRetryMs = 60000;

const offerLimit = 16;

const pageLimit = 100;

const maxCursorLength = 512;

const maxReferenceLength = 256;

const createdStatus = 201;

const readLeaseMs = 60000;

const cursor = Schema.String.check(Schema.isBetweenLength(1, maxCursorLength));

const institutionMovement = CreateTransactionInput.check(
  Schema.makeFilter((input) => Option.isNone(input.categoryId) && Option.isNone(input.notes))
);

const Page = Schema.Struct({
  movements: Schema.Array(
    Schema.Struct({
      reference: Schema.String.check(Schema.isBetweenLength(1, maxReferenceLength)),
      transaction: institutionMovement,
    })
  ).check(Schema.isMaxLength(pageLimit)),
  nextCursor: Schema.NullOr(cursor),
  checkpoint: Schema.NullOr(cursor),
});

const Account = Schema.Struct({
  id: Schema.String,
  grant_attempt_id: Schema.String,
  cursor: Schema.NullOr(cursor),
  expires_at_ms: Schema.Int,
});

const insertJob = Effect.fn(function* (
  account: typeof Account.Type,
  now: number,
  storage: DurableObjectStorage
) {
  const sql = yield* SqliteClient;
  const id = newId();
  const deadline = Math.min(now + maximumLifetimeMs, account.expires_at_ms);

  if (deadline <= now) return;
  yield* sql`INSERT OR IGNORE INTO connection_synchronizations(id,account_id,grant_attempt_id,start_cursor,admitted_at_ms,expires_at_ms,offer_at_ms,state)
    VALUES(${id},${account.id},${account.grant_attempt_id},${account.cursor},${now},${deadline},${now},'pending')`;
  yield* preserveStoreAlarm(storage, now);
});

export const admitSynchronization = Effect.fn(function* (
  grant: string,
  now: number,
  storage: DurableObjectStorage
) {
  const sql = yield* SqliteClient;

  const accounts = yield* Schema.decodeUnknownEffect(Schema.Array(Account))(
    yield* sql`SELECT a.id,a.grant_attempt_id,NULL AS cursor,g.expires_at_ms FROM connection_accounts a JOIN connection_grants g ON g.attempt_id=a.grant_attempt_id WHERE g.state='active' AND g.attempt_id=${grant}`
  );

  yield* Effect.forEach(
    accounts,
    Effect.fnUntraced(function* (account) {
      yield* sql`UPDATE connection_synchronizations SET state='cancelled',claim_token=NULL,claim_until_ms=NULL WHERE account_id=${account.id} AND grant_attempt_id<>${grant} AND state IN ('pending','running')`;
      yield* sql`INSERT INTO connection_refresh(account_id,grant_attempt_id) VALUES(${account.id},${grant}) ON CONFLICT(account_id) DO UPDATE SET grant_attempt_id=excluded.grant_attempt_id,cursor=NULL,next_refresh_ms=NULL`;
      yield* insertJob(account, now, storage);
    }),
    { discard: true }
  );
});

const workRow = Schema.Struct({
  accountId: Schema.String,
  accountReference: Schema.String,
  connectionId: Schema.String,
  userId: UserId,
  attemptId: Schema.String,
  consentId: Schema.String,
  intentJson: Schema.String,
  envelope: Schema.String,
  cursor: Schema.NullOr(cursor),
  deadline: Schema.Int,
});

const currentJob = Effect.fn(function* (work: SynchronizationWork, now: number) {
  const sql = yield* SqliteClient;

  const [row] =
    yield* sql`SELECT a.id AS accountId,a.provider_reference AS accountReference,c.id AS connectionId,c.user_id AS userId,g.attempt_id AS attemptId,
    b.consent_id AS consentId,b.intent_json AS intentJson,g.envelope,s.start_cursor AS cursor,s.expires_at_ms AS deadline
    FROM connection_synchronizations s JOIN connection_accounts a ON a.id=s.account_id AND a.grant_attempt_id=s.grant_attempt_id
    JOIN connection_refresh r ON r.account_id=a.id AND r.grant_attempt_id=s.grant_attempt_id AND r.cursor IS s.start_cursor
    JOIN connections c ON c.id=a.connection_id JOIN connection_grants g ON g.attempt_id=s.grant_attempt_id JOIN connection_authorizations b ON b.attempt_id=g.attempt_id
    WHERE s.id=${work.jobId} AND s.state IN ('pending','running') AND s.expires_at_ms>${now} AND c.user_id=${work.userId} AND g.state='active' AND c.state='Active' AND g.expires_at_ms>${now}
    AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE user_id=c.user_id)`;

  return row === undefined
    ? Option.none<typeof workRow.Type>()
    : Option.some(yield* Schema.decodeUnknownEffect(workRow)(row));
});

const abandon = Effect.fn(function* (work: SynchronizationWork, now: number) {
  const sql = yield* SqliteClient;
  yield* sql`UPDATE connection_synchronizations SET state='cancelled',claim_token=NULL,claim_until_ms=NULL WHERE id=${work.jobId} AND state IN ('pending','running') AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Draining')`;
  yield* sql`UPDATE connection_refresh SET next_refresh_ms=${now + offerRetryMs} WHERE account_id IN (SELECT account_id FROM connection_synchronizations WHERE id=${work.jobId} AND state='cancelled') AND next_refresh_ms IS NULL AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE user_id=${work.userId})`;
});

type PageExecution = {
  work: SynchronizationWork;
  provider: SynchronizationProvider;
  key: Redacted.Redacted<string>;
  storage: DurableObjectStorage;
};

const fetchPage = Effect.fn(function* (
  { provider, work, key }: PageExecution,
  job: typeof workRow.Type
) {
  const purpose = yield* grantPurpose({ ...job, clientId: provider.clientId });
  const grant = yield* openGrant({ key, purpose, envelope: job.envelope });

  const body = yield* provider.page({
    accountReference: job.accountReference,
    cursor: Option.fromNullishOr(job.cursor),
    work,
    grant,
  });

  const page = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(Page), {
    onExcessProperty: "error",
  })(body);

  return page;
});

const commitPage = Effect.fn(function* (
  { work, provider, storage }: PageExecution,
  { job, token }: { job: typeof workRow.Type; token: string },
  page: typeof Page.Type
) {
  const sql = yield* SqliteClient;
  yield* withStoreCapacity("required")(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;

      if (
        Option.isNone(yield* currentJob(work, now)) ||
        !(yield* institutionsForUser(work.userId)).includes(InstitutionId.make("bancolombia"))
      ) {
        yield* abandon(work, now);
        yield* repairSynchronizationAlarm(storage);

        return;
      }

      yield* Effect.forEach(
        page.movements,
        Effect.fnUntraced(function* (movement) {
          const existing =
            yield* sql`SELECT transaction_id FROM connection_movements WHERE account_id=${job.accountId} AND reference=${movement.reference}`;

          if (existing.length > 0) return;
          const id = newId();

          const result = yield* prepareConnectionMovement(movement.transaction, {
            userId: work.userId,
            current: now,
            movementId: id,
          }).pipe(Effect.flatMap(commitLocalWrite));

          if (result.status !== createdStatus) return yield* failed();
          yield* sql`INSERT INTO connection_movements VALUES(${job.accountId},${movement.reference},${id})`;
        }),
        { discard: true }
      );

      yield* one(
        yield* sql`UPDATE connection_synchronizations SET state='complete',claim_token=NULL,claim_until_ms=NULL,completed_at_ms=${now} WHERE id=${work.jobId} AND state='running' AND claim_token=${token} AND claim_until_ms>${now} RETURNING id`
      );
      yield* one(
        yield* sql`INSERT INTO audit_entries(id,user_id,record_type,operation,outcome,occurred_at_ms) VALUES(${work.jobId},${work.userId},'connection_synchronization','connections.synchronize','success',${now}) RETURNING id`
      );
      const next = page.nextCursor !== null ? now : now + provider.refreshIntervalMs;
      yield* sql`UPDATE connection_refresh SET cursor=${page.nextCursor ?? page.checkpoint},last_success_ms=${now},next_refresh_ms=${next} WHERE account_id=${job.accountId} AND grant_attempt_id=${job.attemptId}`;
      yield* preserveStoreAlarm(storage, next);
    })
  );
});

export const executeSynchronization = Effect.fn(function* (input: PageExecution) {
  const { work, storage } = input;
  const token = newId();
  const sql = yield* SqliteClient;

  const admitted = yield* sql.withTransaction(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const job = yield* currentJob(work, now);

      if (
        Option.isNone(job) ||
        !(yield* institutionsForUser(work.userId)).includes(InstitutionId.make("bancolombia"))
      ) {
        yield* abandon(work, now);
        yield* repairSynchronizationAlarm(storage);

        return Option.none<typeof workRow.Type>();
      }

      yield* one(
        yield* sql`UPDATE connection_synchronizations SET state='running',claim_token=${token},claim_until_ms=${now + readLeaseMs} WHERE id=${work.jobId} AND (state='pending' OR (state='running' AND claim_until_ms<=${now})) RETURNING id`
      );

      return job;
    })
  );

  if (Option.isNone(admitted)) return;
  const job = admitted.value;
  yield* fetchPage(input, job).pipe(
    Effect.timeout("45 seconds"),
    Effect.flatMap((page) => commitPage(input, { job, token }, page)),
    Effect.onError(() =>
      sql`UPDATE connection_synchronizations SET state='pending',claim_token=NULL,claim_until_ms=NULL WHERE id=${work.jobId} AND state='running' AND claim_token=${token} AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Draining')`.pipe(
        Effect.asVoid,
        Effect.orDie
      )
    )
  );
});

export const repairSynchronizationAlarm = Effect.fn(function* (storage: DurableObjectStorage) {
  const sql = yield* SqliteClient;

  const [row] =
    yield* sql`SELECT min(due) AS due FROM (SELECT min(offer_at_ms) AS due FROM connection_synchronizations WHERE state IN ('pending','running') UNION ALL SELECT min(next_refresh_ms) FROM connection_refresh UNION ALL SELECT min(expires_at_ms) FROM connection_synchronizations WHERE state IN ('complete','cancelled')) WHERE NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Draining')`;

  const value = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ due: Schema.NullOr(Schema.Int) })
  )(row);

  return value.due === null ? false : yield* preserveStoreAlarm(storage, value.due);
});

const DueAccount = Schema.Struct({ ...Account.fields, userId: UserId });

const offerDueAccount = Effect.fnUntraced(function* (
  account: typeof DueAccount.Type,
  now: number,
  storage: DurableObjectStorage
) {
  if ((yield* institutionsForUser(account.userId)).includes(InstitutionId.make("bancolombia"))) {
    yield* insertJob(account, now, storage);
  }
});

export const offerSynchronizations = Effect.fn(function* ({
  now,
  storage,
  queue,
  owns,
}: {
  now: number;
  storage: DurableObjectStorage;
  queue: Queue<SynchronizationWork>;
  owns: (user: string) => boolean;
}) {
  const sql = yield* SqliteClient;

  const pending = yield* sql.withTransaction(
    Effect.gen(function* () {
      if ((yield* sql`SELECT 1 FROM erasure_requests WHERE state<>'Draining' LIMIT 1`).length > 0) {
        return [];
      }

      yield* sql`DELETE FROM connection_synchronizations WHERE id IN (SELECT id FROM connection_synchronizations WHERE state IN ('complete','cancelled') AND expires_at_ms<=${now} ORDER BY expires_at_ms LIMIT ${offerLimit})`;
      yield* sql`UPDATE connection_refresh SET next_refresh_ms=NULL WHERE next_refresh_ms<=${now} AND NOT EXISTS(SELECT 1 FROM connection_accounts a JOIN connection_grants g ON g.attempt_id=a.grant_attempt_id JOIN connections c ON c.id=a.connection_id WHERE a.id=connection_refresh.account_id AND a.grant_attempt_id=connection_refresh.grant_attempt_id AND g.state='active' AND g.expires_at_ms>${now} AND c.state='Active')`;
      yield* sql`UPDATE connection_refresh SET next_refresh_ms=${now + offerRetryMs} WHERE next_refresh_ms IS NULL AND account_id IN (SELECT account_id FROM connection_synchronizations WHERE state IN ('pending','running') AND expires_at_ms<=${now})`;
      yield* sql`UPDATE connection_synchronizations SET state='cancelled',claim_token=NULL,claim_until_ms=NULL WHERE state IN ('pending','running') AND expires_at_ms<=${now}`;

      const due = yield* Schema.decodeUnknownEffect(Schema.Array(DueAccount))(
        yield* sql`SELECT a.id,a.grant_attempt_id,r.cursor,g.expires_at_ms,c.user_id AS userId FROM connection_refresh r JOIN connection_accounts a ON a.id=r.account_id AND a.grant_attempt_id=r.grant_attempt_id JOIN connections c ON c.id=a.connection_id JOIN connection_grants g ON g.attempt_id=a.grant_attempt_id WHERE r.next_refresh_ms<=${now} AND c.state='Active' AND g.state='active' AND g.expires_at_ms>${now}
      AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE user_id=c.user_id) AND NOT EXISTS(SELECT 1 FROM consent_history h WHERE h.user_id=c.user_id AND h.record_type='processing_withdrawal' AND NOT EXISTS(SELECT 1 FROM consent_history renewal WHERE renewal.user_id=h.user_id AND renewal.record_type='processing_renewal' AND renewal.withdrawal_id=h.id)) LIMIT ${offerLimit}`
      );

      yield* Effect.forEach(
        due.filter((account) => owns(account.userId)),
        (account) => offerDueAccount(account, now, storage),
        { discard: true }
      );

      yield* sql`UPDATE connection_refresh SET next_refresh_ms=NULL WHERE next_refresh_ms<=${now} AND account_id IN (SELECT account_id FROM connection_synchronizations WHERE state IN ('pending','running'))`;
      yield* sql`UPDATE connection_refresh SET next_refresh_ms=${now + offerRetryMs} WHERE next_refresh_ms<=${now}`;

      const rows = yield* Schema.decodeUnknownEffect(Schema.Array(SynchronizationWork))(
        yield* sql`SELECT 'connection-synchronization' AS kind,c.user_id AS userId,s.id AS jobId FROM connection_synchronizations s JOIN connection_accounts a ON a.id=s.account_id JOIN connections c ON c.id=a.connection_id WHERE s.state IN ('pending','running') AND s.offer_at_ms<=${now} ORDER BY s.offer_at_ms,s.id LIMIT ${offerLimit}`
      );

      yield* Effect.forEach(
        rows,
        (row) =>
          sql`UPDATE connection_synchronizations SET offer_at_ms=min(expires_at_ms,${now + offerRetryMs}) WHERE id=${row.jobId}`,
        { discard: true }
      );

      yield* repairSynchronizationAlarm(storage);

      return rows.filter((row) => owns(row.userId));
    })
  );

  const offers = yield* Effect.forEach(pending, (work) =>
    Effect.tryPromise(() => queue.send(work)).pipe(Effect.exit)
  );

  return {
    attempted: pending.length,
    failed: offers.filter(Exit.isFailure).length,
  };
});
