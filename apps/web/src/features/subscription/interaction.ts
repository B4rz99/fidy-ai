import { Data, Effect, Option } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import type { EnrollmentMethod } from "@/transport/client";
import type { PriceId, SubscriptionOffers } from "./presentation";
import {
  type Enrollment,
  type EnrollmentGateway,
  type PaymentFields,
  type PaymentSubmission,
  type PreparedEnrollment,
} from "./enrollment-gateway";
import { makeEnrollmentCommand } from "./enrollment-command";
import { isAwaitingPaymentStatus, paymentStatusRefreshDelay } from "./payment-status";

const maximumPaymentStatusRefreshes = 65;
type PaymentFlowState =
  | Readonly<{ _tag: "Enrollment"; value: Enrollment }>
  | Readonly<{
      _tag: "PaymentSubmission";
      value: PaymentSubmission;
      billingEmail: string;
      prepared: Option.Option<PreparedEnrollment>;
    }>;

type PaymentSubmissionFlowState = Extract<PaymentFlowState, { _tag: "PaymentSubmission" }>;

const enrollmentFlow = (value: Enrollment): PaymentFlowState => ({ _tag: "Enrollment", value });
const submissionFlow = (
  value: PaymentSubmission,
  billingEmail: string,
  prepared: Option.Option<PreparedEnrollment>
): PaymentSubmissionFlowState => ({
  _tag: "PaymentSubmission",
  value,
  billingEmail,
  prepared,
});

const preparePaymentFlow = Effect.fn(function* (
  gateway: EnrollmentGateway,
  priceId: PriceId,
  options: Readonly<{ method: EnrollmentMethod; replaceFailedSource: boolean }>
) {
  const prepared = yield* Effect.tryPromise({
    try: (signal) =>
      gateway.prepare(priceId, options.method, {
        signal,
        replaceFailedSource: options.replaceFailedSource,
      }),
    catch: () => new EnrollmentInteractionFailed(),
  });
  if (prepared.status !== "verifying" && prepared.status !== "creating") {
    return enrollmentFlow(prepared);
  }
  const resumed = yield* Effect.tryPromise({
    try: (signal) => gateway.resume(prepared.enrollmentId, signal),
    catch: () => new EnrollmentInteractionFailed(),
  });
  return Option.match(resumed, {
    onNone: () => enrollmentFlow(prepared),
    onSome: ({ submission, billingEmail }) =>
      submissionFlow(submission, billingEmail, Option.none()),
  });
});

const pageIsHidden = (): boolean => globalThis.document.visibilityState === "hidden";

const awaitVisiblePage = (): Effect.Effect<boolean> => {
  if (!pageIsHidden()) return Effect.succeed(false);
  return Effect.callback<boolean>((resume) => {
    const onVisibilityChange = (): void => {
      if (pageIsHidden()) return;
      globalThis.document.removeEventListener("visibilitychange", onVisibilityChange);
      resume(Effect.succeed(true));
    };
    globalThis.document.addEventListener("visibilitychange", onVisibilityChange);
    onVisibilityChange();
    return Effect.sync(() =>
      globalThis.document.removeEventListener("visibilitychange", onVisibilityChange)
    );
  });
};

class EnrollmentInteractionFailed extends Data.TaggedError("EnrollmentInteractionFailed")<{}> {}

const refreshPaymentUntilTerminal = Effect.fn(function* (
  gateway: EnrollmentGateway,
  initial: PaymentSubmissionFlowState,
  publish: (current: PaymentSubmissionFlowState) => void
) {
  let current = initial;
  let refreshCount = 0;
  while (isAwaitingPaymentStatus(current.value) && refreshCount < maximumPaymentStatusRefreshes) {
    const resumedFromHiddenPage = yield* awaitVisiblePage();
    if (!resumedFromHiddenPage) yield* Effect.sleep(paymentStatusRefreshDelay(refreshCount));
    if (pageIsHidden()) continue;
    refreshCount += 1;
    const refreshed = yield* Effect.tryPromise({
      try: (signal) => observePayment(gateway, current, signal),
      catch: () => new EnrollmentInteractionFailed(),
    }).pipe(Effect.option);
    if (Option.isSome(refreshed) && refreshed.value.enrollmentId === initial.value.enrollmentId) {
      current = submissionFlow(refreshed.value, current.billingEmail, current.prepared);
      yield* Effect.sync(() => publish(current));
    }
  }
});

const observePayment = (
  gateway: EnrollmentGateway,
  current: PaymentSubmissionFlowState,
  signal: AbortSignal
): Promise<PaymentSubmission> =>
  current.value.status === "payment-pending"
    ? gateway.observeBillingAttempt(
        current.value.enrollmentId,
        current.value.billingAttempt.id,
        signal
      )
    : gateway.continue(current.value.enrollmentId, current.billingEmail, signal);

const canResumeEnrollment = (value: Enrollment): boolean =>
  value.status === "creating" || value.status === "verifying" || value.status === "available";
const recoverEnrollment = Effect.fn(function* (
  gateway: EnrollmentGateway,
  current: Extract<PaymentFlowState, { _tag: "Enrollment" }>,
  uncertain: boolean
) {
  const value = yield* Effect.tryPromise({
    try: (signal) => gateway.status(current.value.enrollmentId, signal),
    catch: () => new EnrollmentInteractionFailed(),
  });
  if (value.enrollmentId !== current.value.enrollmentId) {
    return yield* new EnrollmentInteractionFailed();
  }
  if (value.status === "prepared" && uncertain) return yield* new EnrollmentInteractionFailed();
  if (!canResumeEnrollment(value)) {
    return enrollmentFlow(value);
  }
  const resumed = yield* Effect.tryPromise({
    try: (signal) => gateway.resume(value.enrollmentId, signal),
    catch: () => new EnrollmentInteractionFailed(),
  });
  if (Option.isNone(resumed) || resumed.value.submission.enrollmentId !== value.enrollmentId) {
    return yield* new EnrollmentInteractionFailed();
  }
  return submissionFlow(
    resumed.value.submission,
    resumed.value.billingEmail,
    current.value.status === "prepared" ? Option.some(current.value) : Option.none()
  );
});
const refreshPaymentFlow = (
  gateway: EnrollmentGateway,
  current: PaymentFlowState,
  uncertain: boolean
): Effect.Effect<PaymentFlowState, EnrollmentInteractionFailed> => {
  if (current._tag === "Enrollment") return recoverEnrollment(gateway, current, uncertain);
  return Effect.tryPromise({
    try: (signal) => observePayment(gateway, current, signal),
    catch: () => new EnrollmentInteractionFailed(),
  }).pipe(
    Effect.flatMap((value) =>
      value.enrollmentId === current.value.enrollmentId
        ? Effect.succeed(submissionFlow(value, current.billingEmail, current.prepared))
        : Effect.fail(new EnrollmentInteractionFailed())
    )
  );
};

const submitPaymentFlow = (
  gateway: EnrollmentGateway,
  input: Readonly<{
    prepared: PreparedEnrollment;
    email: string;
    fields: Option.Option<PaymentFields>;
  }>
): Effect.Effect<PaymentFlowState, EnrollmentInteractionFailed> =>
  Effect.tryPromise({
    try: (signal) =>
      gateway.submit(input.prepared, input.email, {
        fields: input.fields,
        signal: Option.some(signal),
      }),
    catch: () => new EnrollmentInteractionFailed(),
  }).pipe(
    Effect.flatMap((submission) =>
      submission.enrollmentId === input.prepared.enrollmentId
        ? Effect.succeed(submissionFlow(submission, input.email, Option.some(input.prepared)))
        : Effect.fail(new EnrollmentInteractionFailed())
    )
  );

type Work = Effect.Effect<PaymentFlowState, EnrollmentInteractionFailed>;
export type PaymentSubmissionView = Readonly<{
  _tag: "PaymentSubmission";
  value: PaymentSubmission;
  canReplaceCard: boolean;
}>;
export type PaymentFlowView =
  | Extract<PaymentFlowState, { _tag: "Enrollment" }>
  | PaymentSubmissionView;
export type EnrollmentInteraction = Readonly<{
  selectedId: Option.Option<PriceId>;
  method: EnrollmentMethod;
  checkout: boolean;
  enabledMethods: ReadonlyArray<EnrollmentMethod>;
  methodsWaiting: boolean;
  methodsFailed: boolean;
  enrollment: Option.Option<PaymentFlowView>;
  busy: boolean;
  failed: boolean;
  needsRecovery: boolean;
  disabled: boolean;
  canContinue: boolean;
  selectPrice: (id: PriceId) => void;
  selectMethod: (method: EnrollmentMethod) => void;
  changeSelection: () => boolean;
  continueToPayment: () => void;
  prepare: (replaceFailedSource?: boolean) => void;
  submit: (email: string, fields?: PaymentFields) => void;
  refresh: () => void;
  refreshMethods: () => void;
  submittedDaviplata: (email: string, submission: PaymentSubmission) => void;
  mount: () => () => void;
}>;
type Owner = {
  get: Atom.AtomContext;
  gateway: Option.Option<EnrollmentGateway>;
  offers: SubscriptionOffers;
  authorizationLock: Atom.Atom<boolean>;
  availability: ReturnType<typeof enrollmentAvailability>;
  command: ReturnType<typeof makeEnrollmentCommand<void, never>>;
  observation: Atom.AtomResultFn<Effect.Effect<void>, void, never>;
  active: boolean;
  generation: number;
  selectedId: Option.Option<PriceId>;
  method: EnrollmentMethod;
  checkout: boolean;
  replaceFailedSource: boolean;
  flow: Option.Option<PaymentFlowState>;
  busy: boolean;
  failed: boolean;
  uncertain: boolean;
};
const enrollmentAvailability = Atom.family((gateway: Option.Option<EnrollmentGateway>) =>
  Atom.make(
    Option.match(gateway, {
      onNone: () => Effect.fail(new EnrollmentInteractionFailed()),
      onSome: (available) =>
        Effect.tryPromise({
          try: (signal) => available.availability(signal),
          catch: () => new EnrollmentInteractionFailed(),
        }),
    })
  )
);
const notify = (owner: Owner): void => {
  if (owner.active) owner.get.setSelf(present(owner));
};
const paymentLocked = (flow: PaymentFlowState): boolean =>
  flow._tag === "Enrollment"
    ? flow.value.status === "creating" || flow.value.status === "verifying"
    : isAwaitingPaymentStatus(flow.value) ||
      (flow.value.status === "payment-pending" && flow.value.billingAttempt.status === "succeeded");
const selectionLocked = (owner: Owner): boolean =>
  owner.busy ||
  owner.uncertain ||
  owner.get.once(owner.authorizationLock) ||
  Option.exists(owner.flow, paymentLocked);
const stop = (owner: Owner): void => {
  owner.generation += 1;
  owner.command.clear();
  owner.get.set(owner.command.atom, Atom.Interrupt);
  owner.get.set(owner.observation, Atom.Interrupt);
  owner.busy = false;
};
const dispose = (owner: Owner): void => {
  owner.active = false;
  stop(owner);
  owner.flow = Option.none();
  owner.uncertain = false;
};
const reset = (owner: Owner): void => {
  stop(owner);
  owner.flow = Option.none();
  owner.failed = false;
  owner.uncertain = false;
};
const publish = (owner: Owner, generation: number, flow: PaymentFlowState): void => {
  if (!owner.active || owner.generation !== generation) return;
  owner.flow = Option.some(flow);
  notify(owner);
};
const observe = (owner: Owner, generation: number, flow: PaymentFlowState): void => {
  if (flow._tag !== "PaymentSubmission" || !isAwaitingPaymentStatus(flow.value)) return;
  Option.map(owner.gateway, (gateway) =>
    owner.get.set(
      owner.observation,
      refreshPaymentUntilTerminal(gateway, flow, (value) => {
        if (value.value.enrollmentId === flow.value.enrollmentId) publish(owner, generation, value);
      })
    )
  );
};
const run = (owner: Owner, work: (gateway: EnrollmentGateway) => Work, mutation = false): void => {
  if (!owner.active || owner.busy || Option.isNone(owner.gateway)) return;
  stop(owner);
  const generation = owner.generation;
  owner.busy = true;
  owner.failed = false;
  notify(owner);
  owner.command.offer(
    work(owner.gateway.value).pipe(
      Effect.tap((flow) =>
        Effect.sync(() => {
          if (!owner.active || owner.generation !== generation) return;
          owner.uncertain = false;
          publish(owner, generation, flow);
          observe(owner, generation, flow);
        })
      ),
      Effect.catchCause(() =>
        Effect.sync(() => {
          if (!owner.active || owner.generation !== generation) return;
          owner.failed = true;
          owner.uncertain ||= mutation;
        })
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (!owner.active || owner.generation !== generation) return;
          owner.busy = false;
          notify(owner);
        })
      ),
      Effect.asVoid
    )
  );
  owner.get.set(owner.command.atom, undefined);
};
const selectPrice = (owner: Owner, id: PriceId): void => {
  if (!owner.active || selectionLocked(owner) || !owner.offers.some((offer) => offer.id === id)) {
    return;
  }
  reset(owner);
  owner.selectedId = Option.some(id);
  notify(owner);
};
const selectMethod = (owner: Owner, method: EnrollmentMethod): void => {
  if (!owner.active || selectionLocked(owner) || method === owner.method) return;
  const availability = owner.get.once(owner.availability);
  if (availability._tag !== "Success" || !availability.value.enabledMethods.includes(method)) {
    return;
  }
  reset(owner);
  owner.method = method;
  owner.replaceFailedSource = true;
  notify(owner);
};
const prepare = (owner: Owner, replacing: boolean): void => {
  if (!owner.active || selectionLocked(owner) || Option.isNone(owner.selectedId)) return;
  const priceId = owner.selectedId.value;
  owner.checkout = true;
  run(owner, (gateway) =>
    preparePaymentFlow(gateway, priceId, {
      method: owner.method,
      replaceFailedSource: replacing,
    })
  );
};
const submit = (owner: Owner, email: string, fields?: PaymentFields): void => {
  if (selectionLocked(owner) || Option.isNone(owner.flow)) return;
  const current = owner.flow.value;
  if (current._tag !== "Enrollment" || current.value.status !== "prepared") return;
  const prepared = current.value;
  run(
    owner,
    (gateway) =>
      submitPaymentFlow(gateway, {
        prepared,
        email,
        fields: Option.fromNullishOr(fields),
      }),
    true
  );
};
const refresh = (owner: Owner): void => {
  if (Option.isNone(owner.flow)) return;
  const current = owner.flow.value;
  run(owner, (gateway) => refreshPaymentFlow(gateway, current, owner.uncertain));
};
const submittedDaviplata = (owner: Owner, email: string, submission: PaymentSubmission): void => {
  if (!owner.active || owner.busy || Option.isNone(owner.flow)) return;
  const current = owner.flow.value;
  if (
    current._tag !== "Enrollment" ||
    current.value.status !== "prepared" ||
    current.value.method !== "daviplata" ||
    current.value.enrollmentId !== submission.enrollmentId
  ) {
    return;
  }
  run(owner, () => Effect.succeed(submissionFlow(submission, email, Option.none())));
};
const viewFlow = (flow: PaymentFlowState): PaymentFlowView =>
  flow._tag === "Enrollment"
    ? flow
    : {
        _tag: "PaymentSubmission",
        value: flow.value,
        canReplaceCard: Option.exists(flow.prepared, (prepared) => prepared.method === "card"),
      };
const present = (owner: Owner): EnrollmentInteraction => {
  const availability = owner.get.once(owner.availability);
  const enabledMethods = availability._tag === "Success" ? availability.value.enabledMethods : [];
  const disabled = selectionLocked(owner);
  const canContinue =
    !disabled && Option.isSome(owner.selectedId) && enabledMethods.includes(owner.method);
  return {
    selectedId: owner.selectedId,
    method: owner.method,
    checkout: owner.checkout,
    enabledMethods,
    methodsWaiting: availability.waiting,
    methodsFailed: AsyncResult.isFailure(availability),
    enrollment: Option.map(owner.flow, viewFlow),
    busy: owner.busy,
    failed: owner.failed,
    needsRecovery: owner.uncertain,
    disabled,
    canContinue,
    selectPrice: (id) => selectPrice(owner, id),
    selectMethod: (method) => selectMethod(owner, method),
    changeSelection: () => {
      if (!owner.active || selectionLocked(owner)) return false;
      reset(owner);
      owner.checkout = false;
      notify(owner);
      return true;
    },
    continueToPayment: () => {
      if (present(owner).canContinue) prepare(owner, owner.replaceFailedSource);
    },
    prepare: (replacing = false) => prepare(owner, replacing),
    submit: (email, fields) => submit(owner, email, fields),
    refresh: () => refresh(owner),
    refreshMethods: () => {
      if (owner.active) owner.get.refresh(owner.availability);
    },
    submittedDaviplata: (email, submission) => submittedDaviplata(owner, email, submission),
    mount: () => {
      owner.active = true;
      notify(owner);
      return () => dispose(owner);
    },
  };
};

/** Each mounted owner admits actions synchronously and fences every completion after disposal.
 * Transient payment fields are consumed once; uncertain submissions require an explicit reread.
 */
export const makeEnrollmentInteraction = (
  input: Readonly<{
    gateway: Option.Option<EnrollmentGateway>;
    offers: SubscriptionOffers;
    authorizationLock: Atom.Atom<boolean>;
  }>
): Atom.Atom<EnrollmentInteraction> =>
  Atom.make((get) => {
    const owner: Owner = {
      ...input,
      get,
      availability: enrollmentAvailability(input.gateway),
      command: makeEnrollmentCommand<void, never>(),
      observation: Atom.fn<Effect.Effect<void>>()((work) => work),
      active: false,
      generation: 0,
      selectedId: Option.none(),
      method: "card",
      checkout: false,
      replaceFailedSource: false,
      flow: Option.none(),
      busy: false,
      failed: false,
      uncertain: false,
    };
    get.mount(owner.command.atom);
    get.mount(owner.observation);
    get.subscribe(owner.availability, () => notify(owner));
    get.subscribe(owner.authorizationLock, () => notify(owner));
    get.addFinalizer(() => dispose(owner));
    return present(owner);
  });
