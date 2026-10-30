import { readBrowserTransactionPage } from "../../transactions/operations";
import { Clock, DateTime, Duration, Effect, Option, Schema } from "effect";
import {
  BrowserSessionBinding,
  type BrowserSessionInitialContext,
  type InitialTransactionPage,
  browserSessionBindingHeader,
  browserSessionBindingPath,
} from "../../../src/shell/web-session/contract";
import type { CurrentUserMetadata } from "../../../src/shell/identity/contract";
import {
  decodeProcessingConsentStatusRead,
  prepareProcessingConsentStatusRead,
} from "../../../src/shell/processing-consent/operations";
import type { ProcessingConsentStatus } from "../../../src/shell/processing-consent/contract";
import {
  browserSessionBindingResponse,
  readCurrentWebSessionMetadata,
  readWebSessionEntry,
} from "../../web-session/operations";
import type { AuthenticatedWebSession, WebSessionRequest } from "../../web-session/contract";
import { protectCanonicalPressure } from "../../canonical-admission/operations";

type Input = WebSessionRequest & Readonly<{ browserOrigin: string }>;
type StartupPhase = "entry" | "metadata" | "history" | "authority" | "encoding" | "guarded";
type StartupTimings = Record<StartupPhase, number>;
type TimedInput = Input & Readonly<{ timings: StartupTimings }>;
const measurePhase = <A, E>(
  phase: StartupPhase,
  work: Effect.Effect<A, E>,
  timings: StartupTimings
): Effect.Effect<A, E> =>
  work.pipe(
    Effect.timed,
    Effect.map(([duration, result]) => {
      timings[phase] += Duration.toMillis(duration);
      return result;
    })
  );
const appendStartupTimings = (
  response: Response,
  timings: StartupTimings,
  duration: Duration.Duration
): Response => {
  const total = Duration.toMillis(duration);
  const { entry, metadata, history, authority, encoding, guarded } = timings;
  const phases = {
    bootstrap: total,
    "bootstrap-entry": entry,
    "bootstrap-metadata": metadata,
    "bootstrap-history": history,
    "bootstrap-authority": authority,
    "bootstrap-encoding": encoding,
    "bootstrap-admission": Math.max(0, guarded - metadata - history - authority - encoding),
    "bootstrap-other": Math.max(0, total - entry - guarded),
  };
  response.headers.append(
    "server-timing",
    Object.entries(phases)
      .map(([name, elapsed]) => `${name};dur=${elapsed}`)
      .join(", ")
  );
  return response;
};

const maximumInitialResponseBytes = 65_536;
const noStore = { "cache-control": "no-store" };
const unavailableStatus = 503;
const forbiddenStatus = 403;
const invalidStatus = 400;
const refusalCode = (status: number): string => {
  if (status === forbiddenStatus) return "forbidden";
  if (status === invalidStatus) return "validation_failed";
  return "unavailable";
};
const refused = (status: number): Response =>
  Response.json(
    {
      error: { code: refusalCode(status), message: "The operation is unavailable. Retry later." },
      next: [],
    },
    { status, headers: noStore }
  );

const reply = (
  binding: Option.Option<string>,
  initial: Option.Option<typeof BrowserSessionInitialContext.Type>
): Effect.Effect<Response, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(BrowserSessionBinding.fields.binding)(Option.getOrNull(binding)).pipe(
    Effect.flatMap((binding) => Schema.encodeEffect(BrowserSessionBinding)({ binding, initial })),
    Effect.map((body) => {
      const initial = body.initial;
      if (
        initial?.status === "Granted" &&
        initial.transactions !== undefined &&
        new TextEncoder().encode(JSON.stringify(body)).byteLength > maximumInitialResponseBytes
      ) {
        return Response.json(
          { ...body, initial: { status: "Granted", withdrawal: null, profile: initial.profile } },
          { headers: noStore }
        );
      }
      return Response.json(body, { headers: noStore });
    })
  );

const readStatus = ({
  db,
  subject,
}: Readonly<{ db: D1Database; subject: AuthenticatedWebSession }>): Effect.Effect<
  Option.Option<ProcessingConsentStatus>,
  unknown
> =>
  Effect.gen(function* () {
    const read = prepareProcessingConsentStatusRead({
      subject,
      current: yield* Clock.currentTimeMillis,
    });
    const rows = yield* Effect.tryPromise(() =>
      db
        .prepare(read.sql)
        .bind(...read.params)
        .all()
    );
    return yield* decodeProcessingConsentStatusRead(rows.results);
  });
const readProfile = (
  input: Input,
  subject: AuthenticatedWebSession
): Effect.Effect<Option.Option<typeof CurrentUserMetadata.Type>, unknown> =>
  readCurrentWebSessionMetadata({ db: input.db, subject });

const initialTransactions = (
  input: Input,
  subject: AuthenticatedWebSession,
  profile: typeof CurrentUserMetadata.Type
): Effect.Effect<Option.Option<typeof InitialTransactionPage.Type>, unknown> =>
  Effect.gen(function* () {
    if (new URL(input.request.url).searchParams.get("context") !== "transactions") {
      return Option.none();
    }
    const now = DateTime.setZone(
      yield* DateTime.now,
      DateTime.zoneMakeNamedUnsafe(profile.data.timeZone)
    );
    const from = DateTime.toUtc(DateTime.startOf(now, "month"));
    const to = DateTime.toUtc(DateTime.add(DateTime.startOf(now, "month"), { months: 1 }));
    const url = new URL("https://core.internal/transactions");
    url.searchParams.set("from", DateTime.formatIso(from));
    url.searchParams.set("to", DateTime.formatIso(to));
    const page = yield* readBrowserTransactionPage({
      db: input.db,
      request: new Request(url),
      subject,
    });
    return Option.map(page, (page) => ({ from, to, page }));
  });

const grantedReply = (
  subject: AuthenticatedWebSession,
  profile: Option.Option<typeof CurrentUserMetadata.Type>,
  transactions: Option.Option<typeof InitialTransactionPage.Type>
): Effect.Effect<Response, Schema.SchemaError> =>
  Option.isSome(profile) && profile.value.data.id === subject.userId
    ? reply(
        Option.some(subject.id),
        Option.some({
          status: "Granted",
          withdrawal: null,
          profile: profile.value,
          transactions,
        })
      )
    : Effect.sync(() => {
        const response = refused(unavailableStatus);
        response.headers.set("server-timing", 'bootstrap-metadata;desc="unavailable"');
        return response;
      });

/** Reuse each owner's guarded read. Late revocation drops metadata before the response is encoded. */
const protectedContext = (
  input: TimedInput,
  subject: AuthenticatedWebSession,
  initial: ProcessingConsentStatus
): Effect.Effect<Response, unknown> =>
  Effect.gen(function* () {
    const first =
      initial.status === "Granted"
        ? Option.some(initial)
        : yield* measurePhase("authority", readStatus({ db: input.db, subject }), input.timings);
    if (Option.isNone(first)) return yield* reply(Option.none(), Option.none());
    if (first.value.status !== "Granted") {
      return yield* reply(Option.some(subject.id), Option.some(first.value));
    }
    const profile = yield* measurePhase("metadata", readProfile(input, subject), input.timings);
    const transactions = Option.isSome(profile)
      ? yield* measurePhase(
          "history",
          initialTransactions(input, subject, profile.value),
          input.timings
        )
      : Option.none();
    const final = yield* measurePhase(
      "authority",
      readStatus({ db: input.db, subject }),
      input.timings
    );
    if (Option.isNone(final)) return yield* reply(Option.none(), Option.none());
    return yield* final.value.status === "Granted"
      ? measurePhase("encoding", grantedReply(subject, profile, transactions), input.timings)
      : reply(Option.some(subject.id), Option.some(final.value));
  });

const validContextRequest = (request: Request): boolean => {
  const url = new URL(request.url);
  return (
    request.method === "GET" &&
    url.searchParams.size === 1 &&
    ["application", "transactions"].includes(url.searchParams.get("context") ?? "")
  );
};

const readContext = (input: TimedInput): Effect.Effect<Response, unknown> =>
  Effect.gen(function* () {
    if (input.request.headers.get("origin") !== input.browserOrigin) {
      return refused(forbiddenStatus);
    }
    if (!validContextRequest(input.request)) return refused(invalidStatus);
    const current = yield* Clock.currentTimeMillis;
    const observed = yield* measurePhase(
      "entry",
      readWebSessionEntry({ ...input, current }),
      input.timings
    );
    if (Option.isNone(observed)) return yield* reply(Option.none(), Option.none());
    const { subject, status } = observed.value;
    const expected = input.request.headers.get(browserSessionBindingHeader);
    if (expected !== null && expected !== subject.id) return refused(forbiddenStatus);
    return yield* measurePhase(
      "guarded",
      protectCanonicalPressure({
        db: input.db,
        userId: subject.userId,
        work: protectedContext(input, subject, status),
        refused: (response) => {
          response.headers.set("cache-control", "no-store");
          return Effect.succeed(response);
        },
      }),
      input.timings
    );
  });

const contextResponse = (input: Input): Effect.Effect<Response> =>
  Effect.suspend(() => {
    const timings: StartupTimings = {
      entry: 0,
      metadata: 0,
      history: 0,
      authority: 0,
      encoding: 0,
      guarded: 0,
    };
    return readContext({ ...input, timings }).pipe(
      Effect.orElseSucceed(() => {
        const response = refused(unavailableStatus);
        response.headers.set("server-timing", 'bootstrap-read;desc="failed"');
        return response;
      }),
      Effect.timed,
      Effect.map(([duration, response]) => appendStartupTimings(response, timings, duration))
    );
  });

/** The ordinary binding-only path remains unchanged, including all mounted-request checks. */
export const initialBrowserSessionBindingResponse = (
  input: Input
): Effect.Effect<Option.Option<Response>> => {
  const url = new URL(input.request.url);
  return url.pathname === browserSessionBindingPath && url.searchParams.size > 0
    ? contextResponse(input).pipe(Effect.map(Option.some))
    : browserSessionBindingResponse(input);
};
