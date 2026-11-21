import {
  type WompiContracts,
  type WompiEnrollmentClientService,
  WompiSourceResult,
} from "./wompi-client";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, DateTime, Effect, Option, Redacted, Result, Schema } from "effect";
import {
  BillingEmail,
  PaymentSubmission,
  type PreparedPaymentEnrollment,
  type Price,
} from "../../../src/core/subscription/contract";
import { SubmitPaymentEnrollmentPayload } from "../../../src/shell/subscription/contract";
import {
  preserveStoreAlarm,
  withStoreAdmission,
  withStoreCapacity,
} from "../../runtime/sqlite/operations";
import { newId } from "../../secret-material/operations";
import {
  billingAttemptIdFor,
  daviplataPolicy,
  readEnrollmentBody,
  submittedToken,
  walletTokenPatterns,
} from "./enrollment-policy";
import { enrollmentAllowance, enrollmentWompi, formCodec } from "./local-enrollment-form";
import {
  type BrowserEnrollment,
  type EnrollmentContext,
  type EnrollmentSession,
  type NativeEnrollmentEnv,
  invalidEnrollment as invalid,
  json,
  liveSession,
  sessionRow,
  unavailableEnrollment as unavailable,
} from "./enrollment-session";
import {
  type Registration,
  finishAdmission,
  hashInputs,
  insertAttempt,
  priceCodec,
  registerTerms,
  requestCodec,
  saveRegistration,
  textReport,
} from "./local-billing-admission";
import { WompiSourceId } from "./wompi-model";
import { type WompiTransportFactory } from "./wompi-runtime";

const verifyDelay = 3000;

const maximumLookups = 8;

const verifying = (enrollmentId: string): Response =>
  json({ body: { status: "source-verifying", enrollmentId }, status: 200 });

const refused = (enrollmentId: string, reason: string): Response =>
  json({ body: { status: "refused", enrollmentId, reason }, status: 200 });

type LocalWork = {
  env: NativeEnrollmentEnv;
  storage: DurableObjectStorage;
  session: EnrollmentSession;
  reg: Registration;
  form: typeof PreparedPaymentEnrollment.Type;
  email: BillingEmail;
  price: Price;
};

const eligible = Effect.fn(function* ({ env, session, reg, form }: LocalWork) {
  const sql = yield* SqliteClient;

  if (
    !(yield* liveSession(session)) ||
    reg.deadlineMs <= (yield* Clock.currentTimeMillis) ||
    (form.method === "daviplata" && Option.isNone(daviplataPolicy(env)))
  ) {
    return false;
  }

  return (
    (yield* sql`SELECT 1 FROM payment_enrollments e JOIN billing_admissions a ON e.id=a.subject_id AND e.user_id=a.user_id
  WHERE e.id=${form.enrollmentId} AND a.operation_id=${reg.operationId} AND a.outcome IS NULL AND e.session_id=${session.id} AND e.environment=${env.WOMPI_ENVIRONMENT}
  AND e.state IN('prepared','creating','verifying') AND NOT EXISTS(SELECT 1 FROM billing_attempt_context b WHERE b.user_id=e.user_id AND b.status<>'succeeded' AND b.no_charge_confirmed_at_ms IS NULL AND NOT EXISTS(SELECT 1 FROM billing_retry_clearances c WHERE c.attempt_id=b.id))
  AND NOT EXISTS(SELECT 1 FROM subscription_standing s JOIN billing_attempt_context b ON b.id=s.attempt_id WHERE s.user_id=e.user_id AND b.paid_ends_at_ms>${yield* Clock.currentTimeMillis})`)
      .length === 1
  );
});

const close = Effect.fn(function* (reg: Registration, reason: string) {
  const sql = yield* SqliteClient;

  if (reg.admission.kind !== "enrollment") return invalid();
  const id = reg.admission.enrollmentId;

  const report = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
    status: "refused",
    enrollmentId: id,
    reason,
  });

  return yield* withStoreCapacity("required")(
    Effect.gen(function* () {
      const rows =
        yield* sql`UPDATE billing_admissions SET outcome='cancelled',report=${report},ack_due_ms=${yield* Clock.currentTimeMillis} WHERE operation_id=${reg.operationId} AND outcome IS NULL RETURNING 1`;

      if (rows.length === 1) {
        yield* sql`UPDATE payment_enrollments SET state=${reason === "expired" ? "expired" : "refused"},reason=${reason},next_lookup_ms=NULL WHERE id=${id}`;
      }

      if (reason === "provider-declined") {
        yield* sql`UPDATE payment_enrollments SET source_creation='settled',state=CASE WHEN state='creating' THEN 'refused' ELSE state END,reason=coalesce(reason,${reason}),next_lookup_ms=NULL WHERE id=${id} AND user_id=${reg.userId} AND source_creation='issued' AND EXISTS(SELECT 1 FROM billing_admissions WHERE operation_id=${reg.operationId} AND subject_id=${id} AND outcome='cancelled')`;
      }

      const [saved] =
        yield* sql`SELECT report FROM billing_admissions WHERE operation_id=${reg.operationId}`;

      return typeof saved?.report === "string" ? textReport(saved.report) : refused(id, reason);
    })
  );
});

const checkSource = Effect.fn(function* ({ session, form, email }: LocalWork, source: string) {
  const sql = yield* SqliteClient;

  const [active] =
    yield* sql`SELECT id FROM payment_source_context WHERE id=${source} AND user_id=${session.user_id} AND method=${form.method} AND billing_email=${email} AND retired_at_ms IS NULL AND NOT EXISTS(SELECT 1 FROM subscription_cancellations WHERE payment_source_id=${source})`;

  if (active === undefined) return yield* Effect.fail("source-no-longer-eligible" as const);
});

const acceptedSource = Effect.fn(function* (work: LocalWork, verified?: WompiSourceId) {
  const { env, session, form, email } = work;
  const sql = yield* SqliteClient;

  const [row] =
    yield* sql`SELECT source_id,state,candidate FROM payment_enrollments WHERE id=${form.enrollmentId}`;

  if (row === undefined) return yield* Effect.fail("invalid-payment-source" as const);
  let source = row.source_id;

  if (verified !== undefined) {
    if (row.candidate !== verified || row.state !== "verifying") {
      return yield* Effect.fail("invalid-payment-source" as const);
    }

    source = newId();
    yield* sql`INSERT INTO payment_sources(id,subscription_id,method,billing_email,wompi_environment,wompi_source_id) SELECT ${source},id,${form.method},${email},${env.WOMPI_ENVIRONMENT},${verified} FROM subscriptions WHERE user_id=${session.user_id}`;
  } else if (form.paymentSourceMode !== "reuse" || row.state !== "prepared") {
    return yield* Effect.fail("invalid-payment-source" as const);
  }

  yield* checkSource(work, String(source));

  return String(source);
});

const commit = Effect.fn(function* (work: LocalWork, verified?: WompiSourceId) {
  const { env, reg, session, form, price, storage } = work;
  const sql = yield* SqliteClient;

  return yield* withStoreCapacity("growth")(
    Effect.gen(function* () {
      if (!(yield* eligible(work))) return unavailable();
      const now = yield* Clock.currentTimeMillis;
      yield* sql`INSERT INTO subscriptions(id,user_id) VALUES(${newId()},${session.user_id}) ON CONFLICT(user_id) DO NOTHING`;
      const source = yield* acceptedSource(work, verified);

      const attempt = yield* insertAttempt({
        id: reg.operationId,
        period: Option.none(),
        price,
        source: String(source),
        user: session.user_id,
        zone: session.time_zone,
        environment: env.WOMPI_ENVIRONMENT,
        now,
        storage,
      });

      const report = yield* Schema.encodeEffect(
        Schema.fromJsonString(Schema.toCodecJson(PaymentSubmission))
      )({ status: "payment-pending", enrollmentId: form.enrollmentId, billingAttempt: attempt });

      yield* finishAdmission({ reg, price, report, now, session: Option.some(session) });

      const completed =
        yield* sql`UPDATE payment_enrollments SET state='available',source_creation=CASE WHEN source_creation='issued' THEN 'settled' ELSE source_creation END,source_id=${source},next_lookup_ms=NULL WHERE id=${form.enrollmentId} RETURNING id`;

      if (completed.length !== 1) return yield* Effect.fail("enrollment-not-completed" as const);

      return textReport(report);
    })
  );
});

const verifyCandidate = Effect.fn(function* (work: LocalWork, transport: WompiTransportFactory) {
  const sql = yield* SqliteClient;
  const now = yield* Clock.currentTimeMillis;
  const { form, storage } = work;

  const candidate = yield* withStoreCapacity("required")(
    Effect.gen(function* () {
      if (!(yield* eligible(work))) return Option.none<WompiSourceId>();

      const [claim] =
        yield* sql`UPDATE payment_enrollments SET lookup_count=lookup_count+1,next_lookup_ms=CASE WHEN lookup_count+1<${maximumLookups} THEN ${now + verifyDelay} END WHERE id=${form.enrollmentId} AND state='verifying' AND candidate IS NOT NULL AND lookup_count<${maximumLookups} AND next_lookup_ms<=${now} RETURNING candidate`;

      if (claim === undefined) return Option.none<WompiSourceId>();
      yield* preserveStoreAlarm(storage, now + verifyDelay);

      return Option.some(yield* Schema.decodeUnknownEffect(WompiSourceId)(claim.candidate));
    })
  );

  if (Option.isNone(candidate)) return verifying(form.enrollmentId);
  const client = yield* enrollmentWompi(work.env, transport);
  const found = yield* Effect.result(client.verifyPaymentSource(candidate.value, form.method));

  if (Result.isFailure(found) || found.success.sourceId !== candidate.value) {
    return verifying(form.enrollmentId);
  }

  if (found.success.billingEmail !== work.email) return yield* close(work.reg, "provider-error");

  return yield* commit(work, candidate.value);
});

type Creation = Extract<SubmitPaymentEnrollmentPayload, { paymentSourceMode: "create" }>;

const walletApproval = Effect.fn(function* (
  work: LocalWork,
  body: Creation,
  client: WompiEnrollmentClientService
) {
  const { env } = work;
  const token = submittedToken(body);

  if (body.method !== "card") {
    const prefix = walletTokenPatterns[env.WOMPI_ENVIRONMENT][body.method];

    if (!prefix.test(Redacted.value(token))) return invalid();

    if (!(yield* enrollmentAllowance(env, work.session.user_id)).ok) return unavailable();

    const approval = yield* Effect.result(
      body.method === "nequi"
        ? client.verifyNequiApproval(token)
        : client.verifyDaviplataApproval(token)
    );

    if (Result.isFailure(approval)) return unavailable();

    if (!approval.success) return invalid();
  }

  return undefined;
});

const claimSource = Effect.fn(function* (work: LocalWork) {
  const { form } = work;
  const sql = yield* SqliteClient;

  const claimed = yield* withStoreCapacity("required")(
    Effect.gen(function* () {
      if (!(yield* eligible(work))) return false;

      return (
        (yield* sql`UPDATE payment_enrollments SET state='creating',source_creation='issued' WHERE id=${form.enrollmentId} AND state='prepared' RETURNING 1`)
          .length === 1
      );
    })
  );

  return claimed;
});

const termsChanged = (form: LocalWork["form"], contracts: WompiContracts): boolean => {
  for (const field of ["endUserPolicy", "personalDataAuthorization"] as const) {
    if (
      contracts.evidence[field].providerContentHash !== form.contracts[field].providerContentHash ||
      contracts.evidence[field].contentSha256 !== form.contracts[field].contentSha256
    ) {
      return true;
    }
  }

  return false;
};

const submitSource = Effect.fn(function* (
  { work, body, contracts }: { work: LocalWork; body: Creation; contracts: WompiContracts },
  client: WompiEnrollmentClientService
) {
  const token = submittedToken(body);
  const { reg } = work;

  const response = yield* Effect.result(
    client.createPaymentSource({
      token,
      method: body.method,
      billingEmail: work.email,
      contracts,
    })
  );

  if (Result.isFailure(response)) {
    return response.failure.certainty === "rejected"
      ? yield* close(reg, "provider-declined")
      : null;
  }

  const source = response.success;

  return WompiSourceResult.$is("Refused")(source)
    ? yield* close(reg, "provider-declined")
    : source.sourceId;
});

const createSource = Effect.fn(function* (
  work: LocalWork,
  body: Extract<SubmitPaymentEnrollmentPayload, { paymentSourceMode: "create" }>,
  transport: WompiTransportFactory
) {
  const { env, form, reg } = work;
  const client = yield* enrollmentWompi(env, transport);
  const approval = yield* walletApproval(work, body, client);

  if (approval !== undefined) return approval;

  const fresh = yield* Effect.result(
    client.contracts(DateTime.makeUnsafe(yield* Clock.currentTimeMillis))
  );

  if (Result.isFailure(fresh)) return unavailable();

  if (termsChanged(form, fresh.success)) return yield* close(reg, "terms-changed");

  if (!(yield* claimSource(work))) return verifying(form.enrollmentId);
  const sql = yield* SqliteClient;
  const candidate = yield* submitSource({ work, body, contracts: fresh.success }, client);

  if (candidate instanceof Response) return candidate;
  const now = yield* Clock.currentTimeMillis;
  yield* withStoreCapacity("required")(
    Effect.gen(function* () {
      yield* sql`UPDATE payment_enrollments SET state='verifying',candidate=${candidate},next_lookup_ms=${candidate === null ? null : now} WHERE id=${form.enrollmentId} AND state='creating'`;

      if (candidate !== null) yield* preserveStoreAlarm(work.storage, now);
    })
  );

  return candidate === null
    ? verifying(form.enrollmentId)
    : yield* verifyCandidate(work, transport);
});

const enrollmentRegistration = Effect.fn(function* ({
  session,
  body,
  form,
  row,
}: {
  session: EnrollmentSession;
  body: SubmitPaymentEnrollmentPayload;
  form: LocalWork["form"];
  row: Readonly<Record<string, unknown>>;
}) {
  const operationId = yield* Effect.tryPromise(() =>
    billingAttemptIdFor({ userId: session.user_id, requestId: body.paymentRequestId })
  );

  const reg: Registration = {
    userId: session.user_id,
    operationId,
    admission: {
      kind: "enrollment",
      enrollmentId: body.enrollmentId,
      acceptedPriceId: form.price.id,
    },
    billingPeriod: form.price.billingPeriod,
    deadlineMs: Number(row.deadline_ms),
    inputsDigest: yield* hashInputs(
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))([
        session.id,
        body.billingEmail,
        body.paymentRequestId,
        row.form,
        body.paymentSourceMode,
        body.decisions,
        body.paymentSourceMode === "create" ? Redacted.value(submittedToken(body)) : row.source_id,
      ])
    ),
  };

  return reg;
});

const enrollmentReceipt = Effect.fn(function* ({
  input,
  body,
  form,
  row,
  reg,
}: {
  input: BrowserEnrollment;
  body: SubmitPaymentEnrollmentPayload;
  form: LocalWork["form"];
  row: Readonly<Record<string, unknown>>;
  reg: Registration;
}) {
  const { session, storage } = input;
  const sql = yield* SqliteClient;

  const saved = yield* withStoreAdmission((admit) =>
    Effect.gen(function* () {
      const [previous] =
        yield* sql`SELECT 1 FROM billing_admissions WHERE operation_id=${reg.operationId}`;

      if (previous === undefined) yield* admit;
      const receipt = yield* saveRegistration(reg, storage);

      if (receipt?.outcome === null) {
        yield* sql`UPDATE payment_enrollments SET session_id=${session.id},email=${body.billingEmail},next_lookup_ms=CASE WHEN source_id IS NOT NULL AND state='prepared' THEN coalesce(next_lookup_ms,${(yield* Clock.currentTimeMillis) + verifyDelay}) ELSE next_lookup_ms END WHERE id=${body.enrollmentId}`;

        if (form.paymentSourceMode === "reuse") {
          yield* preserveStoreAlarm(storage, (yield* Clock.currentTimeMillis) + verifyDelay);
        }
      }

      return receipt;
    })
  );

  if (saved === undefined) return invalid();

  if (typeof saved.report === "string") return textReport(saved.report);

  if (
    saved.outcome === "cancelled" ||
    reg.deadlineMs <= (yield* Clock.currentTimeMillis) ||
    row.state === "expired"
  ) {
    return yield* close(reg, "expired");
  }

  if (row.state === "refused") return refused(form.enrollmentId, String(row.reason));

  return undefined;
});

export const submitLocalForm = Effect.fn(function* (input: BrowserEnrollment) {
  const { request, env, session } = input;

  const decoded = yield* readEnrollmentBody({ request, schema: SubmitPaymentEnrollmentPayload });

  if (Option.isNone(decoded)) return invalid();
  const body = decoded.value;
  const sql = yield* SqliteClient;

  const [row] =
    yield* sql`SELECT * FROM payment_enrollments WHERE id=${body.enrollmentId} AND user_id=${session.user_id} AND environment=${env.WOMPI_ENVIRONMENT}`;

  if (row === undefined || typeof row.form !== "string") return invalid();
  const form = yield* Schema.decodeEffect(formCodec)(row.form);

  if (
    form.paymentSourceMode !== body.paymentSourceMode ||
    (body.paymentSourceMode === "create"
      ? body.method !== form.method
      : body.billingEmail !== form.billingEmail)
  ) {
    return invalid();
  }

  const reg = yield* enrollmentRegistration({ session, body, form, row });
  const existing = yield* enrollmentReceipt({ input, body, form, row, reg });

  if (existing !== undefined) return existing;

  return yield* continueSubmission({ input, body, form, row, reg });
});

export const recoverCandidate = Effect.fn(function* (context: EnrollmentContext, id: string) {
  const { env, storage, transport } = context;
  const sql = yield* SqliteClient;
  const now = yield* Clock.currentTimeMillis;

  const [row] =
    yield* sql`SELECT a.request,a.terms,e.form,e.email,e.state,e.session_id AS id,e.user_id,u.time_zone FROM payment_enrollments e JOIN billing_admissions a ON a.subject_id=e.id AND a.user_id=e.user_id JOIN users u ON u.id=e.user_id WHERE e.id=${id} AND e.state IN('prepared','verifying') AND e.next_lookup_ms<=${now} AND a.outcome IS NULL AND e.deadline_ms>${now}`;

  if (row === undefined) return;
  const session = yield* Schema.decodeUnknownEffect(sessionRow)(row);

  if (!(yield* liveSession(session))) {
    yield* sql`UPDATE payment_enrollments SET next_lookup_ms=NULL WHERE id=${id}`;

    return;
  }

  const reg = yield* Schema.decodeUnknownEffect(requestCodec)(row.request);
  const form = yield* Schema.decodeUnknownEffect(formCodec)(row.form);
  const email = yield* Schema.decodeUnknownEffect(BillingEmail)(row.email);

  if (row.state === "prepared") {
    yield* withStoreCapacity("required")(
      Effect.gen(function* () {
        yield* sql`UPDATE payment_enrollments SET next_lookup_ms=${now + verifyDelay} WHERE id=${id} AND state='prepared'`;
        yield* preserveStoreAlarm(storage, now + verifyDelay);
      })
    );
    const price = yield* registerTerms(env.PRICING, reg);

    if (Option.isNone(price)) {
      yield* close(reg, "terms-changed");

      return;
    }

    yield* commit({ env, storage, session, reg, form, email, price: price.value });

    return;
  }

  const price = yield* Schema.decodeUnknownEffect(priceCodec)(row.terms);
  yield* verifyCandidate({ env, storage, session, reg, form, email, price }, transport);
});

const continueSubmission = Effect.fn(function* ({
  input,
  body,
  form,
  row,
  reg,
}: {
  input: BrowserEnrollment;
  body: SubmitPaymentEnrollmentPayload;
  form: LocalWork["form"];
  row: Readonly<Record<string, unknown>>;
  reg: Registration;
}) {
  const { env, storage, session, transport } = input;
  const sql = yield* SqliteClient;
  const price = yield* registerTerms(env.PRICING, reg);

  if (Option.isNone(price)) {
    return yield* close(
      reg,
      reg.deadlineMs <= (yield* Clock.currentTimeMillis) ? "expired" : "terms-changed"
    );
  }

  const terms = yield* Schema.encodeEffect(priceCodec)(price.value);
  yield* sql`UPDATE billing_admissions SET terms=${terms} WHERE operation_id=${reg.operationId} AND outcome IS NULL AND terms IS NULL`;
  const work = { reg, env, session, storage, price: price.value, form, email: body.billingEmail };

  if (row.state === "verifying") return yield* verifyCandidate(work, transport);

  if (row.state === "creating") return verifying(form.enrollmentId);

  if (!(yield* eligible(work))) return unavailable();

  return body.paymentSourceMode === "reuse"
    ? yield* commit(work)
    : yield* createSource(work, body, transport);
});
