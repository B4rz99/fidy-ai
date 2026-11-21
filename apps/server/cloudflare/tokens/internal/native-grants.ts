import { repairPATExpiry } from "./native-expiry";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, DateTime, Effect, Option, Schema } from "effect";
import { Hex } from "effect/encoding";
import { UserId } from "../../../src/core/identity/contract";
import {
  ApprovePATPairingPayload,
  CreateManualPATPayload,
  PATPairingPublicCodeInput,
} from "../../../src/core/tokens/contract";
import { buildPATDisclosure, buildPairedPATDisclosure } from "../../../src/core/tokens/operations";
import { approvePairingGrant, issueManualPAT } from "../../../src/shell/tokens/operations";
import {
  grantManualPATConsent,
  grantPairedPATConsent,
} from "../../../src/shell/consent/operations";
import { recordSessionPATTransition } from "../../../src/shell/audit/operations";
import { type OwnedStatement } from "../../../src/shell/owner-write/contract";
import { type CatalogOperation } from "../../../src/shell/canonical-catalog/contract";
import { type LocalMutationResult } from "../../canonical-admission/contract";
import {
  boundSessionLookup,
  readBoundWebSessionProof,
  resolveBoundCanonicalWebSession,
} from "../../web-session/operations";
import { newId } from "../../secret-material/operations";
import { withStoreCapacity } from "../../runtime/sqlite/operations";
import { type Directory, FrozenPAT, Reservation, directoryEvidence } from "./native-routes";
import {
  dayMilliseconds,
  decodeBody,
  digest,
  iso,
  newBearer,
  pairingMilliseconds,
  rejected,
  unauthorized,
} from "./pat-shared";
import { consumed, expiredReview, expiryFor, issuanceLimit, issuedResponse } from "./pat-manual";
import { rateLimited } from "./pat-pairing";
import { PATUnavailable } from "../contract";

type Session = { id: string; user_id: UserId };

type Commit = (
  user: UserId,
  current: number
) => Effect.Effect<LocalMutationResult, PATUnavailable, SqliteClient>;

export type StagedPAT = { targets: ReadonlyArray<string>; commit: Commit };

const result = Effect.fn(
  function* (response: Response) {
    return {
      status: response.status,
      outcome: response.ok ? ("success" as const) : ("validation_failed" as const),
      body: yield* Schema.decodeUnknownEffect(Schema.Json)(
        yield* Effect.tryPromise(() => response.json())
      ),
    };
  },
  Effect.mapError((cause) => new PATUnavailable({ cause: Option.some(cause) }))
);

const refuse = (response: () => Response): StagedPAT => ({
  targets: [],
  commit: () => result(response()),
});

const success = (data: Schema.Json): LocalMutationResult => ({
  status: 200,
  outcome: "success",
  body: { data, next: [] },
});

const execute = Effect.fn(function* (statement: OwnedStatement) {
  const sql = yield* SqliteClient;
  const rows = yield* sql.unsafe(statement.sql + " RETURNING 1", statement.params);

  if (rows.length !== 1) return yield* new PATUnavailable({ cause: Option.none() });
});

const recordGrant = (
  session: Session,
  current: number,
  transition: Pick<Parameters<typeof recordSessionPATTransition>[0]["input"], "operation" | "patId">
): ReturnType<typeof execute> =>
  execute(recordSessionPATTransition({ session, input: { id: newId(), current, ...transition } }));

const preflightSession = Effect.fn(function* (request: Request, owns: (user: string) => boolean) {
  if (request.headers.has("authorization")) return Option.none<Session>();
  const proof = yield* Effect.tryPromise(() => readBoundWebSessionProof(request));

  if (Option.isNone(proof)) return Option.none<Session>();
  const sql = yield* SqliteClient;
  const lookup = boundSessionLookup({ ...proof.value, current: yield* Clock.currentTimeMillis });
  const [row] = yield* sql.unsafe(lookup.statement.sql, lookup.statement.params);
  const live = resolveBoundCanonicalWebSession({ lookup, row });

  if (Option.isNone(live) || !owns(live.value.userId)) return Option.none<Session>();

  return Option.some({
    id: live.value.id,
    user_id: yield* Schema.decodeEffect(UserId)(live.value.userId),
  });
});

const reviewLimit = 10;

const review = Effect.fn(function* (directory: Directory, session: Session, payload: unknown) {
  const sql = yield* SqliteClient;

  const count = yield* Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    yield* sql`DELETE FROM pat_review_events WHERE expires_at_ms<=${now}`;

    return yield* sql`INSERT INTO pat_review_events(session_id,expires_at_ms) SELECT ${session.id},${now + pairingMilliseconds}
      WHERE (SELECT count(*) FROM pat_review_events WHERE session_id=${session.id} AND expires_at_ms>${now})<${reviewLimit} RETURNING id`;
  }).pipe(withStoreCapacity("growth"));

  if (count.length === 0) return refuse(rateLimited);

  const code = Schema.decodeUnknownOption(Schema.Struct({ publicCode: PATPairingPublicCodeInput }))(
    payload
  );

  if (Option.isNone(code)) return refuse(rejected);

  const found = yield* directoryEvidence(
    directory,
    { kind: "review", user: session.user_id, code: code.value.publicCode },
    FrozenPAT
  );

  if (Option.isNone(found)) return refuse(rejected);
  const pairing = found.value;

  return {
    targets: ["pat-pairing:" + pairing.id],
    commit: Effect.fn(
      function* (user: UserId, current: number) {
        if (user !== session.user_id || pairing.expires_at_ms <= current) {
          return yield* result(rejected());
        }

        const closed =
          yield* sql`SELECT 1 FROM pat_pairings WHERE id=${pairing.id} AND state<>'pending_approval'`;

        if (closed.length > 0) return yield* result(rejected());

        return success({
          pairingId: pairing.id,
          recipientLabel: pairing.recipient_label,
          scopes: [...pairing.scopes_json],
          lifetimeDays: pairing.lifetime_days,
          claimBy: iso(pairing.expires_at_ms),
        });
      },
      Effect.mapError((cause) => new PATUnavailable({ cause: Option.some(cause) }))
    ),
  } satisfies StagedPAT;
});

const approve = Effect.fn(function* (directory: Directory, session: Session, payload: unknown) {
  const decoded = Schema.decodeUnknownOption(ApprovePATPairingPayload)(payload);

  if (Option.isNone(decoded)) return refuse(rejected);

  const found = yield* directoryEvidence(
    directory,
    { kind: "bind", user: session.user_id, pairing: decoded.value.pairingId },
    FrozenPAT
  );

  if (Option.isNone(found)) return refuse(rejected);
  const pairing = found.value;
  const proof = yield* Effect.fromResult(Hex.decode(pairing.proof_digest));
  const sql = yield* SqliteClient;

  return {
    targets: ["pat-pairing:" + pairing.id],
    commit: Effect.fn(
      function* (user: UserId, current: number) {
        if (user !== session.user_id || pairing.expires_at_ms <= current) {
          return yield* result(rejected());
        }

        const [prior] =
          yield* sql`SELECT 1 FROM pat_pairings WHERE id=${pairing.id} AND state<>'pending_approval'`;

        if (prior !== undefined) return yield* result(rejected());
        yield* sql`INSERT INTO pat_pairings(id,user_id,public_code,proof_digest,recipient_label,scopes_json,lifetime_days,expires_at_ms,wrong_attempts,last_poll_at_ms,minimum_poll_seconds)
    VALUES(${pairing.id},${user},${pairing.public_code},${proof},${pairing.recipient_label},${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))([...pairing.scopes_json])},${pairing.lifetime_days},${pairing.expires_at_ms},${pairing.wrong_attempts},${pairing.last_poll_at_ms},${pairing.minimum_poll_seconds}) ON CONFLICT(id) DO NOTHING`;
        const expires = current + pairing.lifetime_days * dayMilliseconds;

        const disclosure = buildPairedPATDisclosure({
          grant: {
            recipientLabel: pairing.recipient_label,
            scopes: pairing.scopes_json,
            lifetimeDays: pairing.lifetime_days,
          },
          expiresAt: DateTime.makeUnsafe(expires),
        });

        yield* execute(
          approvePairingGrant({ session, input: { pairingId: pairing.id, current, expires } })
        );
        yield* execute(
          grantPairedPATConsent({
            session,
            input: { id: newId(), pairingId: pairing.id, disclosure, current },
          })
        );
        yield* recordGrant(session, current, {
          operation: "pats.approvePATPairing",
          patId: Option.none(),
        });

        return success({
          pairingId: pairing.id,
          patExpiresAt: iso(expires),
          claimBy: iso(pairing.expires_at_ms),
        });
      },
      Effect.mapError((cause) => new PATUnavailable({ cause: Option.some(cause) }))
    ),
  } satisfies StagedPAT;
});

const staleSession = (session: Session): Response =>
  Response.json(
    {
      error: {
        code: "user_action_required",
        reason: "reauthentication_required",
        userId: session.user_id,
      },
      next: [],
    },
    { status: 403 }
  );

type ManualInput = {
  reservation: typeof Reservation.Type;
  input: CreateManualPATPayload;
  session: Session;
};

const prepareManual = Effect.fn(function* ({ reservation, input, session }: ManualInput) {
  const { requestId, grant } = input,
    sql = yield* SqliteClient;

  const { short_id: shortId, pat_id: patId, expires_at_ms: expires } = reservation;
  const bearer = newBearer(shortId);
  const bearerDigest = yield* Effect.tryPromise(() => digest(bearer));

  return {
    targets: ["manual-pat:" + requestId],
    commit: Effect.fn(
      function* (user: UserId, current: number) {
        if (user !== session.user_id) return yield* result(unauthorized());

        if (
          (yield* sql`SELECT 1 FROM pats WHERE user_id=${user} AND request_id=${requestId}`)
            .length > 0
        ) {
          return yield* result(consumed());
        }

        if (
          (yield* sql`SELECT 1 FROM web_sessions WHERE id=${session.id} AND fresh_until_ms>${current}`)
            .length === 0
        ) {
          return yield* result(staleSession(session));
        }

        if (Option.isNone(expiryFor({ grant, current }))) return yield* result(expiredReview());

        const command = issueManualPAT({
          session,
          input: { grant, requestId, patId, shortId, bearerDigest, current, expires },
        });

        if ((yield* sql.unsafe(command.sql + " RETURNING id", command.params)).length === 0) {
          return yield* result(issuanceLimit());
        }

        yield* execute(
          grantManualPATConsent({
            session,
            input: {
              id: newId(),
              requestId,
              disclosure: buildPATDisclosure({ grant, expiresAt: DateTime.makeUnsafe(expires) }),
              current,
            },
          })
        );
        yield* recordGrant(session, current, {
          operation: "pats.createManualPAT",
          patId: Option.some(patId),
        });

        return yield* result(
          issuedResponse({ input, session, current, expires, shortId, patId, bearer })
        );
      },
      Effect.mapError((cause) => new PATUnavailable({ cause: Option.some(cause) }))
    ),
  } satisfies StagedPAT;
});

export const manual = Effect.fn(function* (
  directory: Directory,
  session: Session,
  payload: unknown
) {
  const input = Schema.decodeUnknownOption(Schema.toCodecJson(CreateManualPATPayload))(payload);

  if (Option.isNone(input)) return refuse(rejected);
  const { grant, requestId } = input.value;
  const sql = yield* SqliteClient;
  const now = yield* Clock.currentTimeMillis;

  const fresh =
    yield* sql`SELECT 1 FROM web_sessions WHERE id=${session.id} AND user_id=${session.user_id} AND fresh_until_ms>${now}`;

  if (fresh.length === 0) return refuse(() => staleSession(session));
  const expiry = expiryFor({ grant, current: now });

  if (Option.isNone(expiry)) return refuse(expiredReview);

  const encoded = yield* Schema.encodeEffect(
    Schema.fromJsonString(Schema.toCodecJson(CreateManualPATPayload))
  )(input.value);

  const context = Hex.encode(yield* Effect.tryPromise(() => digest(encoded)));

  const reservation = yield* directoryEvidence(
    directory,
    {
      kind: "reserve",
      user: session.user_id,
      operation: "manual:" + requestId,
      context,
      expires: expiry.value,
    },
    Reservation
  );

  if (Option.isNone(reservation)) return refuse(consumed);

  return yield* prepareManual({ reservation: reservation.value, input: input.value, session });
});

export const isNativeGrant = (id: string): boolean =>
  ["pats.inspectPATPairing", "pats.approvePATPairing", "pats.createManualPAT"].includes(id);

export const stageGrant = Effect.fn(function* (input: {
  operation: string;
  request: Request;
  owns: (id: string) => boolean;
  directory: Directory;
  payload: unknown;
}) {
  const session = yield* preflightSession(input.request, input.owns);

  if (Option.isNone(session)) return refuse(unauthorized);

  if (input.operation === "pats.inspectPATPairing") {
    return yield* review(input.directory, session.value, input.payload);
  }

  if (input.operation === "pats.approvePATPairing") {
    return yield* approve(input.directory, session.value, input.payload);
  }

  return yield* manual(input.directory, session.value, input.payload);
});

export const dispatchGrant = Effect.fn(function* (unit: {
  request: Request;
  operation: CatalogOperation;
  owns: (id: string) => boolean;
  directory: Directory;
  storage: DurableObjectStorage;
}) {
  const input = yield* decodeBody({
    request: new Request(unit.request.url, {
      method: unit.request.method,
      headers: unit.request.headers,
      body: unit.request.clone().body,
      signal: unit.request.signal,
    }),
    schema: Schema.Json,
  });

  const staged = yield* stageGrant({
    ...unit,
    operation: unit.operation.id,
    payload: Option.getOrNull(input),
  });

  return {
    ...unit,
    input: Effect.succeed(input),
    work: Effect.fnUntraced(function* (_input: unknown, user: UserId, current: number) {
      return yield* staged
        .commit(user, current)
        .pipe(
          Effect.tap((result) =>
            result.outcome === "success" ? repairPATExpiry(current, unit.storage) : Effect.void
          )
        );
    }),
  };
});
