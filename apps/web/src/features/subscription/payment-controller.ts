import { type Cause, Effect, Option, Redacted } from "effect";
import { type PrivateInputs, makePrivateInputs } from "@/browser/private-inputs";
import type { PriceId } from "@/transport/client";
import type { DaviplataChallenge, DaviplataConfirmation } from "./daviplata-challenge";
import type {
  Enrollment,
  EnrollmentGateway,
  PaymentFields,
  PaymentSubmission,
  PreparedEnrollment,
} from "./enrollment-gateway";
import {
  type PaymentAction,
  type PaymentField,
  type PaymentMethod,
  type PaymentStage,
  type PaymentView,
  initialPayment,
} from "./payment-model";
import { observePayment } from "./payment-observation";

type Work = Effect.Effect<void, Cause.UnknownError>;
type Selection = Readonly<{ price: PriceId; method: PaymentMethod }>;
export type PaymentController = Readonly<{
  inputs: PrivateInputs<PaymentField>;
  view: () => PaymentView;
  select: (selection: Selection) => Effect.Effect<void>;
  execute: (action: PaymentAction) => Effect.Effect<void>;
  dispose: () => void;
}>;
type State = {
  view: PaymentView;
  selection: Option.Option<Selection>;
  enrollment: Option.Option<Enrollment>;
  challenge: Option.Option<DaviplataChallenge>;
  active: boolean;
  email: string;
  authorization: AbortController;
};
const submissionStage = (submission: PaymentSubmission): PaymentStage => {
  if (submission.status === "source-verifying") return "SourceVerifying";
  if (submission.status === "refused") return "Refused";
  if (submission.billingAttempt.status === "succeeded") return "PaymentSucceeded";
  return submission.billingAttempt.status === "failed" ? "PaymentFailed" : "PaymentPending";
};
const enrollmentStage = (enrollment: Enrollment): PaymentStage => {
  switch (enrollment.status) {
    case "prepared":
      return "Fields";
    case "available":
      return "Available";
    case "creating":
      return "Creating";
    case "verifying":
      return "Verifying";
    case "expired":
      return "Expired";
    case "refused":
      return "Refused";
  }
};
type Owner = Readonly<{
  state: State;
  inputs: PrivateInputs<PaymentField>;
  gateway: EnrollmentGateway;
  publish: (change: Partial<PaymentView>) => void;
}>;
const installEnrollment = (owner: Owner, enrollment: Enrollment): void => {
  const { state, inputs, publish } = owner;
  if (!state.active) return;
  state.enrollment = Option.some(enrollment);
  if (enrollment.status === "prepared") inputs.set("email", enrollment.billingEmail);
  publish({
    stage: enrollmentStage(enrollment),
    busy: false,
    reuse: enrollment.status === "prepared" && enrollment.paymentSourceMode === "reuse",
    contracts:
      enrollment.status === "prepared"
        ? Option.some({
            endUserPolicy: enrollment.contracts.endUserPolicy.permalink.href,
            personalData: enrollment.contracts.personalDataAuthorization.permalink.href,
          })
        : Option.none(),
  });
};
const installSubmission = (owner: Owner, submission: PaymentSubmission): Work =>
  Effect.gen(function* () {
    const generation = owner.state.view.generation;
    const active = (): boolean => owner.state.active && owner.state.view.generation === generation;
    const publish = (value: PaymentSubmission): void => {
      if (active()) owner.publish({ stage: submissionStage(value), busy: false, locked: true });
    };
    publish(submission);
    yield* observePayment({
      gateway: owner.gateway,
      initial: submission,
      email: owner.state.email,
      active,
      publish,
    });
  });
const prepare = (owner: Owner): Work =>
  Effect.gen(function* () {
    const { state, gateway, inputs, publish } = owner;
    if (Option.isNone(state.selection)) return;
    state.enrollment = Option.none();
    for (const field of [
      "number",
      "expiration",
      "cvc",
      "name",
      "nequi",
      "document",
      "product",
      "otp",
      "email",
    ] as const) {
      inputs.clear(field);
    }
    publish({
      stage: "Preparing",
      busy: true,
      failed: false,
      contracts: Option.none(),
    });
    const generation = state.view.generation;
    const { price, method } = state.selection.value;
    const enrollment = yield* Effect.tryPromise((signal) => gateway.prepare(price, method, signal));
    if (!state.active || generation !== state.view.generation) return;
    installEnrollment(owner, enrollment);
    yield* resumeEnrollment(owner, enrollment, generation);
  });
const resumeEnrollment = (owner: Owner, enrollment: Enrollment, generation: number): Work =>
  Effect.gen(function* () {
    if (enrollment.status !== "verifying" && enrollment.status !== "creating") return;
    const resumed = yield* Effect.tryPromise((signal) =>
      owner.gateway.resume(enrollment.enrollmentId, signal)
    );
    if (
      !owner.state.active ||
      generation !== owner.state.view.generation ||
      Option.isNone(resumed)
    ) {
      return;
    }
    owner.state.email = resumed.value.billingEmail;
    yield* installSubmission(owner, resumed.value.submission);
  });

const paymentFields = (
  owner: Owner,
  prepared: PreparedEnrollment
): Option.Option<PaymentFields> => {
  const { inputs, state, publish } = owner;
  if (prepared.paymentSourceMode === "reuse") return Option.none();
  if (prepared.method === "nequi") {
    return Option.some({
      method: "nequi",
      phoneNumber: Redacted.make(inputs.read("nequi")),
      signal: state.authorization.signal,
      onAwaiting: () => {
        inputs.clear("nequi");
        publish({ stage: "AwaitingNequi" });
      },
    });
  }
  const digits = inputs.read("expiration").replace(/\D/gu, "");
  const monthDigits = 2;
  return Option.some({
    number: inputs.read("number"),
    cvc: inputs.read("cvc"),
    expirationMonth: digits.slice(0, monthDigits),
    expirationYear: digits.slice(monthDigits),
    cardholderName: inputs.read("name"),
  });
};
const startDaviplata = (owner: Owner, prepared: PreparedEnrollment): Work =>
  Effect.gen(function* () {
    const { state, gateway, inputs, publish } = owner;
    publish({ stage: "SendingOtp", locked: true, busy: true });
    const fields = {
      documentNumber: Redacted.make(inputs.read("document")),
      productNumber: Redacted.make(inputs.read("product")),
      signal: state.authorization.signal,
    };
    inputs.clear("document");
    inputs.clear("product");
    const challenge = yield* Effect.tryPromise(() =>
      gateway.startDaviplata(prepared, state.email, fields).then((value) => {
        if (!state.active || fields.signal.aborted) {
          value.dispose();
          return Option.none<DaviplataChallenge>();
        }
        return Option.some(value);
      })
    );
    if (Option.isNone(challenge)) return;
    state.challenge = challenge;
    publish({ stage: "Otp", busy: false });
  });
const submit = (owner: Owner): Work =>
  Effect.gen(function* () {
    const { state, gateway, inputs, publish } = owner;
    if (
      state.view.stage !== "Fields" ||
      Option.isNone(state.enrollment) ||
      state.enrollment.value.status !== "prepared"
    ) {
      return;
    }
    const prepared = state.enrollment.value;
    state.email = inputs.read("email").trim().toLowerCase();
    if (prepared.method === "daviplata" && prepared.paymentSourceMode === "create") {
      yield* startDaviplata(owner, prepared);
      return;
    }
    publish({ stage: "Submitting", busy: true });
    const fields = paymentFields(owner, prepared);
    const submission = yield* Effect.tryPromise((signal) =>
      gateway.submit(prepared, state.email, { fields, signal: Option.some(signal) })
    );
    if (!state.active) return;
    for (const field of ["number", "expiration", "cvc", "name", "nequi"] as const) {
      inputs.clear(field);
    }
    yield* installSubmission(owner, submission);
  });
const applyDaviplata = (owner: Owner, result: DaviplataConfirmation): Work =>
  Effect.gen(function* () {
    if (!owner.state.active || owner.state.authorization.signal.aborted) return;
    if (result.status === "submitted") {
      yield* installSubmission(owner, result.submission);
      return;
    }
    if (result.status === "retry-allowed") {
      owner.publish({ stage: "Otp", busy: false });
      return;
    }
    if (result.status === "refused") {
      cancel(owner);
      return;
    }
    owner.publish({ stage: result.retrySubmission ? "RetrySubmission" : "Uncertain", busy: false });
  });
const challengeAction = (owner: Owner, action: "Confirm" | "Resend" | "RetrySubmission"): Work =>
  Effect.gen(function* () {
    const { state, inputs, publish } = owner;
    if (Option.isNone(state.challenge)) return;
    if (
      action === "RetrySubmission"
        ? state.view.stage !== "RetrySubmission"
        : state.view.stage !== "Otp"
    ) {
      return;
    }
    const generation = state.view.generation;
    const signal = state.authorization.signal;
    const challenge = state.challenge.value;
    const otp = Redacted.make(inputs.read("otp"));
    inputs.clear("otp");
    publish({
      stage: action === "RetrySubmission" ? "RetryingSubmission" : "Confirming",
      busy: true,
    });
    const result = yield* Effect.tryPromise(() => {
      if (action === "Confirm") return challenge.confirm(otp);
      return action === "Resend" ? challenge.resend() : challenge.retrySubmission();
    }).pipe(Effect.ensuring(Effect.sync(() => Redacted.wipeUnsafe(otp))));
    if (!state.active || signal.aborted || generation !== state.view.generation) return;
    yield* applyDaviplata(owner, result);
  });
const cancel = (owner: Owner): void => {
  owner.state.authorization.abort();
  Option.map(owner.state.challenge, (challenge) => challenge.dispose());
  owner.state.challenge = Option.none();
  owner.inputs.clear("otp");
  owner.inputs.clear("document");
  owner.inputs.clear("product");
  owner.publish({
    stage: "Refused",
    locked: false,
    busy: false,
    generation: owner.state.view.generation + 1,
  });
};
const refresh = (owner: Owner): Work =>
  Effect.gen(function* () {
    if (Option.isNone(owner.state.enrollment)) return;
    if (!["Creating", "Verifying"].includes(owner.state.view.stage)) return;
    owner.publish({ busy: true, failed: false });
    const enrollment = yield* Effect.tryPromise((signal) =>
      owner.gateway.status(Option.getOrThrow(owner.state.enrollment).enrollmentId, signal)
    );
    installEnrollment(owner, enrollment);
  });
const restart = (owner: Owner): Work => {
  const { state } = owner;
  if (state.view.locked || !["Idle", "Refused", "Expired"].includes(state.view.stage)) {
    return Effect.void;
  }
  state.authorization.abort();
  state.authorization = new AbortController();
  owner.publish({ generation: state.view.generation + 1 });
  return recover(owner, prepare(owner));
};
const ordinaryAction = (owner: Owner, action: PaymentAction): Work => {
  switch (action) {
    case "Submit":
      return submit(owner);
    case "Refresh":
      return refresh(owner);
    case "Prepare":
      return restart(owner);
    default:
      return Effect.void;
  }
};
const execute = (owner: Owner, action: PaymentAction): Work =>
  Effect.suspend(() => {
    if (!owner.state.active) return Effect.void;
    if (action === "Cancel") return Effect.sync(() => cancel(owner));
    if (owner.state.view.busy) return Effect.void;
    if (action === "Confirm" || action === "Resend" || action === "RetrySubmission") {
      return challengeAction(owner, action);
    }
    return ordinaryAction(owner, action);
  });
const recover = (owner: Owner, work: Work): Effect.Effect<void> =>
  Effect.suspend(() => {
    const { state } = owner;
    const generation = state.view.generation;
    return work.pipe(
      Effect.catch(() =>
        Effect.sync(() => {
          if (!state.active || generation !== state.view.generation) return;
          const stage = state.view.locked ? "Uncertain" : "Fields";
          owner.publish({
            busy: false,
            failed: true,
            stage: state.view.stage === "Preparing" ? "Idle" : stage,
          });
        })
      )
    );
  });

/** Retains provider credentials, authorization and raw payment fields outside serializable state. */
export const makePaymentController = (
  configuration: Readonly<{ gateway: EnrollmentGateway; changed: (view: PaymentView) => void }>
): PaymentController => {
  const inputs = makePrivateInputs<PaymentField>();
  const state: State = {
    view: initialPayment,
    selection: Option.none(),
    enrollment: Option.none(),
    challenge: Option.none(),
    active: true,
    email: "",
    authorization: new AbortController(),
  };
  const owner: Owner = {
    state,
    inputs,
    gateway: configuration.gateway,
    publish: (change) => {
      if (!state.active) return;
      state.view = { ...state.view, ...change };
      configuration.changed(state.view);
    },
  };
  return {
    inputs,
    view: () => state.view,
    select: (selection) =>
      Effect.suspend(() => {
        if (!state.active || state.view.busy || state.view.locked) return Effect.void;
        state.authorization.abort();
        state.authorization = new AbortController();
        Option.map(state.challenge, (challenge) => challenge.dispose());
        state.challenge = Option.none();
        state.selection = Option.some(selection);
        owner.publish({ method: selection.method, generation: state.view.generation + 1 });
        return recover(owner, prepare(owner));
      }),
    execute: (action) => recover(owner, execute(owner, action)),
    dispose: () => {
      state.active = false;
      state.authorization.abort();
      Option.map(state.challenge, (challenge) => challenge.dispose());
      state.challenge = Option.none();
      state.enrollment = Option.none();
      state.email = "";
      inputs.dispose();
    },
  };
};
