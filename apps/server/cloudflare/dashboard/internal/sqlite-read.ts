import { BrowserSessionBinding } from "../../../src/shell/web-session/contract";
import type { Category } from "../../../src/core/categories/contract";
import { WebSessionId } from "../../../src/core/web-session/contract";
import { Clock, Effect, Option, Schema } from "effect";
import { DashboardDocument } from "../../../src/core/dashboard/contract";
import { UserContext } from "../../../src/core/identity/contract";
import { renderDashboardHtml } from "../../../src/shell/dashboard/operations";
import { DashboardViewSnapshot } from "../../../src/shell/dashboard/contract";
import { prepareAuthorizedAuditCall } from "../../../src/shell/audit/operations";
import { prepareReservedChangeCheck } from "../../../src/shell/sql-assertions/operations";
import { browserSessionBindingHeader } from "../../../src/shell/browser-transport/contract";
import {
  attachCanonicalSnapshotStanding,
  canonicalSnapshotFailure,
  canonicalSnapshotPressureRefusal,
  prepareCanonicalSnapshotAdmission,
} from "../../canonical-admission/operations";
import { prepareRecoveryGenerationFence } from "../../erasure/operations";
import { makeSqliteDatabaseUnit } from "../../sqlite-store/operations";
import { prepareSelectedUserDocument } from "../../user-documents/operations";
import { prepareSelectedUserContext } from "../../identity/user-context/operations";
import { prepareCategorySnapshot } from "../../categories/operations";
import { quotaStatusForUserSelection } from "../../quotas/operations";
import {
  currentBrowserSessionLookup,
  prepareBrowserSessionMaterial,
  readWebSessionSnapshotContext,
  resolveBoundCanonicalWebSession,
} from "../../web-session/operations";
import type { AuthenticatedWebSession, BoundWebSessionLookup } from "../../web-session/contract";
import { transactionId, transactionNoStore } from "../../canonical-work/operations";
import { type NativeDashboardRead, NativeDashboardResult } from "../contract";
import { sqliteDashboardView } from "./sqlite-view";

const DocumentRow = Schema.Struct({
  encoded: Schema.fromJsonString(Schema.toCodecJson(DashboardDocument)),
  revision: Schema.Int,
});
const encodeView = Schema.encodeSync(Schema.toCodecJson(DashboardViewSnapshot));
const encodeResult = Schema.encodeSync(
  Schema.fromJsonString(Schema.toCodecJson(NativeDashboardResult))
);
const maximumResultBytes = 33554432;
const failure = (
  kind: "unavailable" | "unauthenticated" | "rate_limited"
): NativeDashboardResult => {
  const response = canonicalSnapshotFailure(kind);
  return {
    kind: "response",
    response: { ...response, headers: { ...transactionNoStore, ...response.headers } },
  };
};
const unavailable = (): NativeDashboardResult => failure("unavailable");
type Unit = ReturnType<typeof makeSqliteDatabaseUnit>;
type Work = Readonly<{
  unit: Unit;
  lookup: BoundWebSessionLookup;
  current: number;
  sql: SqlStorage;
}>;
const standingStatement = ({ unit, lookup, current }: Work): D1PreparedStatement =>
  quotaStatusForUserSelection({
    db: unit.database,
    current,
    users: { sql: `SELECT userId FROM (${lookup.statement.sql})`, params: lookup.statement.params },
  });
const absent = (): NativeDashboardResult => ({
  kind: "response",
  response: {
    status: 404,
    body: {
      error: {
        code: "dashboard_uninitialized",
        message: "Initialize your Dashboard explicitly, then read it again.",
      },
      next: [],
    },
    headers: transactionNoStore,
  },
});
const audited = (work: Work): unknown => {
  const { unit, lookup, current } = work;
  const rows = unit.run([
    prepareAuthorizedAuditCall({
      db: unit.database,
      authority: lookup.authority,
      id: transactionId(),
      current,
      operation: "dashboard.getDashboardView",
      outcome: "accepted",
      afterOwnerWrite: false,
    }),
    prepareReservedChangeCheck({
      db: unit.database,
      scope: "dashboard",
      reservation: lookup.statement,
    }),
    standingStatement(work),
  ]);
  if (rows[0]?.meta.changes !== 1) throw new Error("Dashboard Audit refused");
  return rows[2]?.results[0];
};
type Retained = Readonly<{
  document: typeof DocumentRow.Type;
  context: UserContext;
  categories: ReadonlyArray<Category>;
}>;
const retainedDashboard = ({ unit, lookup }: Work): Option.Option<Retained> => {
  const categories = prepareCategorySnapshot({ db: unit.database, authority: lookup.authority });
  const rows = unit.run([
    prepareSelectedUserDocument({
      db: unit.database,
      userSelection: lookup.statement,
      kind: "dashboard",
    }),
    prepareSelectedUserContext({ db: unit.database, userSelection: lookup.statement }),
    categories.statement,
  ]);
  const documents = Schema.decodeUnknownSync(
    Schema.Array(DocumentRow).check(Schema.isMaxLength(1))
  )(rows[0]?.results);
  const document = documents[0];
  if (document === undefined) return Option.none();
  return Option.some({
    document,
    context: Schema.decodeUnknownSync(Schema.Tuple([UserContext]))(rows[1]?.results)[0],
    categories: Option.getOrThrow(categories.decode(rows[2]?.results)),
  });
};
type Admission =
  | Readonly<{ subject: AuthenticatedWebSession }>
  | Readonly<{ result: NativeDashboardResult }>;
const recoverAdmission = (work: Work, cause: unknown): Admission => {
  if (!canonicalSnapshotPressureRefusal(cause)) throw cause;
  const { unit, lookup, current } = work;
  const rows = unit.run([
    unit.database.prepare(lookup.statement.sql).bind(...lookup.statement.params),
    standingStatement(work),
  ]);
  const subject = resolveBoundCanonicalWebSession({ lookup, row: rows[0]?.results[0] });
  if (Option.isNone(subject)) return { result: failure("unauthenticated") };
  const result = failure("rate_limited");
  return {
    result: {
      ...result,
      response: attachCanonicalSnapshotStanding({
        response: result.response,
        row: rows[1]?.results[0],
        current,
      }),
    },
  };
};
const admitSnapshot = (work: Work): Admission => {
  const { unit, lookup, current } = work;
  try {
    const rows = unit.run(
      prepareCanonicalSnapshotAdmission({ db: unit.database, lookup, current })
    );
    const subject = resolveBoundCanonicalWebSession({ lookup, row: rows[3]?.results[0] });
    return Option.isSome(subject)
      ? { subject: subject.value }
      : { result: failure("unauthenticated") };
  } catch (cause) {
    return recoverAdmission(work, cause);
  }
};
const financialSnapshot = (
  work: Work,
  subject: AuthenticatedWebSession,
  mode: NativeDashboardRead["input"]["mode"]
): NativeDashboardResult => {
  const { current, sql } = work;
  const retained = retainedDashboard(work);
  const document = Option.isSome(retained) ? retained.value.document : undefined;
  if (document === undefined) {
    const response = absent();
    return {
      ...response,
      response: attachCanonicalSnapshotStanding({
        response: {
          ...response.response,
          headers: {
            ...response.response.headers,
            [browserSessionBindingHeader]: subject.id,
          },
        },
        row: audited(work),
        current,
      }),
    };
  }
  const peers = Option.getOrThrow(retained);
  const facts = sqliteDashboardView({
    sql,
    userId: subject.userId,
    current,
    document: document.encoded,
    context: peers.context,
    categories: peers.categories,
  });
  const body = { data: encodeView({ ...facts.view, revision: document.revision }), next: [] };
  const response = attachCanonicalSnapshotStanding({
    current,
    row: audited(work),
    response: {
      status: 200,
      body,
      headers: {
        ...transactionNoStore,
        etag: `"${document.revision}"`,
        [browserSessionBindingHeader]: subject.id,
      },
    },
  });
  return {
    kind: "view",
    response,
    binding: Schema.decodeSync(WebSessionId)(subject.id),
    measurement: facts.measurement,
    ...(mode === "document" ? { html: renderDashboardHtml(facts.view) } : {}),
  };
};
const snapshot = (
  work: Work,
  mode: NativeDashboardRead["input"]["mode"]
): NativeDashboardResult => {
  const admission = admitSnapshot(work);
  if ("result" in admission) return admission.result;
  const subject = admission.subject;
  const bootstrap =
    mode === "document"
      ? Schema.encodeSync(BrowserSessionBinding)({
          binding: Schema.decodeSync(WebSessionId)(subject.id),
          initial: Option.some(
            Effect.runSync(
              readWebSessionSnapshotContext({
                db: work.unit.database,
                subject,
                current: work.current,
                execute: work.unit.run,
              })
            )
          ),
        })
      : undefined;
  return {
    ...financialSnapshot(work, subject, mode),
    ...(bootstrap === undefined ? {} : { bootstrap }),
  };
};
const validate = (result: NativeDashboardResult): NativeDashboardResult => {
  if (new TextEncoder().encode(encodeResult(result)).byteLength > maximumResultBytes) {
    throw new Error("Dashboard result exceeds resource budget");
  }
  return result;
};
/** No database work precedes the native unit; the external generation and cookie digest grant no reusable authority. */
export const readAuditedSqliteDashboard = (
  read: NativeDashboardRead
): Effect.Effect<NativeDashboardResult> =>
  Effect.gen(function* () {
    const request = read.input.request;
    if (
      request.method !== "GET" ||
      new URL(request.url).pathname !== "/dashboard/view" ||
      new URL(request.url).search !== "" ||
      request.headers.get("origin") !== read.browserOrigin
    ) {
      return unavailable();
    }
    const material = yield* Effect.tryPromise(() =>
      prepareBrowserSessionMaterial({ request, mode: read.input.mode })
    );
    if (Option.isNone(material)) return failure("unauthenticated");
    const unit = makeSqliteDatabaseUnit(read.storage);
    const fence = yield* prepareRecoveryGenerationFence({ db: unit.database, bucket: read.bucket });
    const services = yield* Effect.context<never>();
    return yield* Effect.try(() =>
      read.storage.transactionSync(() => {
        if (!read.admitted()) throw new Error("Dashboard admission closed");
        const current = Effect.runSyncWith(services)(Clock.currentTimeMillis);
        const lookup = currentBrowserSessionLookup({ ...material.value, current });
        unit.run([fence]);
        return validate(
          snapshot({ unit, lookup, current, sql: read.storage.sql }, read.input.mode)
        );
      })
    );
  }).pipe(Effect.orElseSucceed(unavailable));
