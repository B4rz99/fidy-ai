import type { UserId } from "../../../src/core/identity/contract";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { BillingAttempt } from "../../../src/core/subscription/contract";
import { reportForAttempt, textReport } from "./local-billing-admission";
import { submitLocalForm } from "./local-enrollment-submit";
import { Clock, Effect, Option, Schema } from "effect";
import { browserSessionBindingHeader } from "../../../src/shell/browser-transport/contract";
import { paymentEnrollmentTransport } from "../../../src/shell/subscription/runtime";
import { sessionCookie, sessionDigest } from "../../web-session/operations";
import { daviplataPolicy, enrollmentConfigured } from "./enrollment-policy";
import {
  type BrowserEnrollment,
  type EnrollmentContext,
  authorized,
  invalidEnrollment,
  json,
  unauthorizedEnrollment,
  unavailableEnrollment,
} from "./enrollment-session";
import { prepareLocalForm } from "./local-enrollment-form";

export const nativeEnrollment = Effect.fn(function* (
  context: EnrollmentContext,
  request: Request,
  owns: (id: string) => boolean
) {
  const { env } = context;

  if (!enrollmentConfigured(env)) return unavailableEnrollment();

  if (request.headers.get("origin") !== env.BROWSER_ORIGIN) {
    return json({ body: { error: "invalid_request" }, status: 403 });
  }

  const cookie = sessionCookie(request);

  if (Option.isNone(cookie)) return unauthorizedEnrollment();
  const digest = yield* Effect.tryPromise(() => sessionDigest(cookie.value));

  const subject = yield* authorized(
    digest,
    request.headers.get(browserSessionBindingHeader) ?? "",
    yield* Clock.currentTimeMillis
  );

  if (Option.isNone(subject) || !owns(subject.value.user_id)) {
    return unauthorizedEnrollment();
  }

  return yield* dispatchBrowser({ ...context, request, session: subject.value });
});

const dispatchBrowser = Effect.fn(function* (input: BrowserEnrollment) {
  const { request, session, env } = input;
  const route = paymentEnrollmentTransport(new URL(request.url).pathname);

  if (Option.isNone(route) || route.value.method !== request.method) {
    return invalidEnrollment();
  }

  if (route.value.operation === "availability") {
    return json({
      body: {
        enabledMethods: Option.isSome(daviplataPolicy(env))
          ? ["card", "nequi", "daviplata"]
          : ["card", "nequi"],
      },
      status: 200,
    });
  }

  if (route.value.operation === "prepare") {
    return yield* prepareLocalForm(input);
  }

  if (route.value.operation === "submit") {
    return yield* submitLocalForm(input);
  }

  return yield* readEnrollmentTarget(route.value, session.user_id);
});

const readForm = Effect.fn(function* (user: string, id: string) {
  const sql = yield* SqliteClient;
  const [row] = yield* sql`SELECT * FROM payment_enrollments WHERE id=${id} AND user_id=${user}`;

  if (row === undefined) return invalidEnrollment();

  if (row.state === "preparing") return unavailableEnrollment();

  if (row.state === "prepared" && Number(row.deadline_ms) >= (yield* Clock.currentTimeMillis)) {
    return textReport(String(row.form));
  }

  const status = row.state === "prepared" ? "expired" : row.state;

  const body = { status, enrollmentId: id, method: row.method, priceId: row.price_id };

  return json({
    body: status === "refused" ? { ...body, reason: row.reason } : body,
    status: 200,
  });
});

const readEnrollmentTarget = Effect.fn(function* (
  route: Option.Option.Value<ReturnType<typeof paymentEnrollmentTransport>>,
  userId: UserId
) {
  if (Option.isNone(route.parameter)) {
    return invalidEnrollment();
  }

  const id = route.parameter.value;

  if (route.operation === "billingAttempt") {
    const attempt = yield* reportForAttempt(userId, id);

    if (Option.isNone(attempt)) return invalidEnrollment();

    return json({
      body: yield* Schema.encodeEffect(Schema.toCodecJson(BillingAttempt))(attempt.value),
      status: 200,
    });
  }

  return yield* readForm(userId, id);
});
