import {
  make as makeScopedAtom,
  useAtom,
  useAtomRefresh,
  useAtomSet,
  useAtomValue,
} from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Cause, Data, Effect, Array as EffectArray, Option, Redacted } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { makeEnrollmentCommand } from "./enrollment-command";
import { SubscriptionConsentBoundary } from "./consent-boundary";
import { DaviplataEnrollmentForm } from "./daviplata-form";
import { DaviplataAuthorizationLock } from "./daviplata-activity";
import { BillingEmailField, EnrollmentConsent } from "./enrollment-controls";
import {
  type EnrollmentDecisions,
  allDecisionsAccepted,
  emptyDecisions,
} from "./enrollment-decisions";
import {
  type ComponentProps,
  type FormEvent,
  type JSX,
  type RefCallback,
  type RefObject,
  useRef,
  useState,
} from "react";
import { useSession } from "@/session/session-context";
import { useSubscriptionEnrollmentClient } from "@/session/subscription-enrollment-context";
import { Alert, AlertDescription, AlertTitle } from "@/ui/components/alert";
import { Button } from "@/ui/components/button";
import { Input } from "@/ui/components/input";
import { SubscriptionInputDecoration } from "@/ui/components/subscription-input-decoration";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { type EnrollmentMethod, type FidyClient } from "@/transport/client";
import { Skeleton } from "@/ui/components/skeleton";
import { CanonicalQueryRetry } from "@/ui/canonical-query-feedback";
import {
  type PriceId,
  type SubscriptionOfferPresentation,
  type SubscriptionOffers,
  paymentMethodCopy,
  presentSubscriptionOffer,
} from "./presentation";
import { type CardFields } from "@/transport/wompi-tokenization";
import {
  type Enrollment,
  type EnrollmentGateway,
  type PaymentFields,
  type PaymentSubmission,
  type PreparedEnrollment,
  makeEnrollmentGateway,
} from "./enrollment-gateway";
import { isAwaitingPaymentStatus, paymentStatusRefreshDelay } from "./payment-status";
import {
  ArrowLeft01Icon,
  Calendar03Icon,
  CreditCardIcon,
  SmartPhone01Icon,
  SquareLock02Icon,
  UserIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  OfferSelection,
  PaymentFeedback,
  PaymentMethodSelection,
  type StandingViewState,
  SubscriptionStandingView,
  SubscriptionSummary,
  SubscriptionTerms,
  SubscriptionWorkspace,
} from "./workspace";

export type SubscriptionOffersPageState =
  | Readonly<{ _tag: "Initial" }>
  | Readonly<{ _tag: "Loading" }>
  | Readonly<{ _tag: "Ready"; offers: SubscriptionOffers }>
  | Readonly<{ _tag: "Refreshing"; offers: SubscriptionOffers }>
  | Readonly<{
      _tag: "RefreshFailure";
      offers: SubscriptionOffers;
      onRetry: () => void;
      waiting: boolean;
    }>
  | Readonly<{ _tag: "AuthenticationRequired" }>
  | Readonly<{
      _tag: "LoadFailure";
      boundaryFailure: boolean;
      onRetry: () => void;
      waiting: boolean;
    }>;

const LoadingOffers = (): JSX.Element => (
  <section className="grid gap-4 lg:grid-cols-3" aria-label="Cargando ofertas" aria-live="polite">
    <Skeleton className="h-96 w-full" />
    <Skeleton className="h-96 w-full" />
    <Skeleton className="h-96 w-full" />
  </section>
);

const CardField = ({
  id,
  label,
  icon,
  input,
}: Readonly<{
  id: string;
  label: string;
  icon: ComponentProps<typeof SubscriptionInputDecoration>["icon"];
  input: JSX.Element;
}>): JSX.Element => (
  <label className="subscription-field" htmlFor={id}>
    {label}
    <SubscriptionInputDecoration icon={icon}>{input}</SubscriptionInputDecoration>
  </label>
);

const digitsOnly = (value: string): string => value.replace(/\D/gu, "");
const nameCharactersOnly = (value: string): string => value.replace(/[^\p{L} ]/gu, "");

type CardFieldsControlProps = Readonly<{
  disabled: boolean;
  fields: CardFields;
  setFields: (fields: CardFields) => void;
}>;

const CardNumberField = ({ disabled, fields, setFields }: CardFieldsControlProps): JSX.Element => (
  <CardField
    icon={CreditCardIcon}
    id="card-number"
    label="Número de tarjeta"
    input={
      <Input
        id="card-number"
        placeholder="Número de tarjeta"
        autoComplete="cc-number"
        disabled={disabled}
        inputMode="numeric"
        pattern="[0-9]*"
        required
        type="text"
        value={fields.number}
        onChange={(event) => setFields({ ...fields, number: digitsOnly(event.target.value) })}
      />
    }
  />
);

const expirationDigitCount = 6;
const ExpirationField = ({ disabled, fields, setFields }: CardFieldsControlProps): JSX.Element => {
  const expiration =
    fields.expirationYear.length > 0
      ? `${fields.expirationMonth}/${fields.expirationYear}`
      : fields.expirationMonth;
  const setExpiration = (value: string): void => {
    const digits = digitsOnly(value).slice(0, expirationDigitCount);
    setFields({
      ...fields,
      expirationMonth: digits.slice(0, 2),
      expirationYear: digits.slice(2),
    });
  };
  return (
    <CardField
      icon={Calendar03Icon}
      id="card-expiration"
      label="Vencimiento"
      input={
        <Input
          id="card-expiration"
          autoComplete="cc-exp"
          disabled={disabled}
          inputMode="numeric"
          maxLength={7}
          pattern="[0-9/]*"
          placeholder="MM/YYYY"
          required
          type="text"
          value={expiration}
          onChange={(event) => setExpiration(event.target.value)}
        />
      }
    />
  );
};

const CvcField = ({ disabled, fields, setFields }: CardFieldsControlProps): JSX.Element => (
  <CardField
    icon={SquareLock02Icon}
    id="card-cvc"
    label="CVC"
    input={
      <Input
        id="card-cvc"
        autoComplete="cc-csc"
        disabled={disabled}
        inputMode="numeric"
        maxLength={4}
        pattern="[0-9]*"
        required
        type="password"
        value={fields.cvc}
        onChange={(event) => setFields({ ...fields, cvc: digitsOnly(event.target.value) })}
      />
    }
  />
);

const CardholderNameField = ({
  disabled,
  fields,
  setFields,
}: CardFieldsControlProps): JSX.Element => (
  <CardField
    icon={UserIcon}
    id="cardholder-name"
    label="Nombre en la tarjeta"
    input={
      <Input
        id="cardholder-name"
        placeholder="Nombre como aparece en la tarjeta"
        autoComplete="cc-name"
        disabled={disabled}
        required
        type="text"
        value={fields.cardholderName}
        onChange={(event) =>
          setFields({ ...fields, cardholderName: nameCharactersOnly(event.target.value) })
        }
      />
    }
  />
);

const CardFieldsForm = ({ disabled, fields, setFields }: CardFieldsControlProps): JSX.Element => (
  <fieldset className="subscription-card-fields">
    <legend className="sr-only">Datos de pago</legend>
    <CardNumberField disabled={disabled} fields={fields} setFields={setFields} />
    <ExpirationField disabled={disabled} fields={fields} setFields={setFields} />
    <CvcField disabled={disabled} fields={fields} setFields={setFields} />
    <CardholderNameField disabled={disabled} fields={fields} setFields={setFields} />
  </fieldset>
);

const emptyCardFields: CardFields = {
  number: "",
  cvc: "",
  expirationMonth: "",
  expirationYear: "",
  cardholderName: "",
};
const enrollmentSubmitLabel = (busy: boolean): string => (busy ? "Activando Pro…" : "Activar Pro");

type DaviplataFormActions = Readonly<{
  gateway: Option.Option<EnrollmentGateway>;
  onDaviplataSubmitted: (email: string, submission: PaymentSubmission) => void;
}>;
type EnrollmentFormProps = DaviplataFormActions &
  Readonly<{
    enrollment: PreparedEnrollment;
    offer: SubscriptionOfferPresentation;
    busy: boolean;
    submit: (billingEmail: string, fields?: PaymentFields) => void;
  }>;

const NequiNumberField = (
  props: Readonly<{
    disabled: boolean;
    required: boolean;
    value: string;
    change: (value: string) => void;
  }>
): JSX.Element => (
  <label className="subscription-field" htmlFor="nequi-number">
    Número de Nequi
    <Input
      id="nequi-number"
      placeholder="Ej. 300 123 4567"
      autoComplete="off"
      inputMode="numeric"
      pattern="3[0-9]{9}"
      maxLength={10}
      required={props.required}
      disabled={props.disabled}
      value={props.value}
      onChange={(event) => props.change(digitsOnly(event.target.value))}
    />
  </label>
);

const noPendingAuthorization: Option.Option<AbortController> = Option.none();

const NequiEnrollmentForm = ({ enrollment, busy, submit }: EnrollmentFormProps): JSX.Element => {
  const [phoneNumber, setPhoneNumber] = useState("");
  const [billingEmail, setBillingEmail] = useState<string>(enrollment.billingEmail);
  const [awaitingApproval, setAwaitingApproval] = useState(false);
  const [decisions, setDecisions] = useState<EnrollmentDecisions>(emptyDecisions);
  const authorization = useRef(noPendingAuthorization);
  const abort = (): void => {
    Option.map(authorization.current, (controller) => controller.abort());
  };
  const [formLifetimeRef] = useState<RefCallback<HTMLFormElement>>(
    () => (): ReturnType<RefCallback<HTMLFormElement>> => abort
  );
  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    if (!allDecisionsAccepted(decisions) || busy) return;
    abort();
    const controller = new AbortController();
    authorization.current = Option.some(controller);
    submit(billingEmail.trim().toLowerCase(), {
      method: "nequi",
      phoneNumber: Redacted.make(phoneNumber),
      signal: controller.signal,
      onAwaiting: () => {
        setPhoneNumber("");
        setAwaitingApproval(true);
      },
    });
  };
  return (
    <NequiFormContents
      enrollment={enrollment}
      busy={busy}
      phoneNumber={phoneNumber}
      billingEmail={billingEmail}
      decisions={decisions}
      awaitingApproval={awaitingApproval}
      formLifetimeRef={formLifetimeRef}
      onSubmit={onSubmit}
      setBillingEmail={setBillingEmail}
      setDecisions={setDecisions}
      changePhone={(value) => {
        setAwaitingApproval(false);
        setPhoneNumber(value);
      }}
    />
  );
};
const NequiAwaiting = (): JSX.Element => (
  <div className="subscription-nequi-waiting">
    <h3>Esperando autorización</h3>
    <HugeiconsIcon icon={SmartPhone01Icon} size={64} strokeWidth={1.5} aria-hidden="true" />
    <output aria-live="polite">
      Aprueba la suscripción en Nequi. Luego verificaremos tu fuente de pago.
    </output>
  </div>
);

const NequiFormContents = ({
  enrollment,
  busy,
  phoneNumber,
  billingEmail,
  decisions,
  awaitingApproval,
  formLifetimeRef,
  onSubmit,
  setBillingEmail,
  setDecisions,
  changePhone,
}: Readonly<{
  enrollment: PreparedEnrollment;
  busy: boolean;
  phoneNumber: string;
  billingEmail: string;
  decisions: EnrollmentDecisions;
  awaitingApproval: boolean;
  formLifetimeRef: RefCallback<HTMLFormElement>;
  onSubmit: (event: FormEvent) => void;
  setBillingEmail: (email: string) => void;
  setDecisions: (decisions: EnrollmentDecisions) => void;
  changePhone: (phone: string) => void;
}>): JSX.Element => (
  <form ref={formLifetimeRef} className="subscription-form" onSubmit={onSubmit}>
    {awaitingApproval && busy ? (
      <NequiAwaiting />
    ) : (
      <>
        <div>
          <h3 className="subscription-form-heading">Antes de autorizar</h3>
          <p className="subscription-form-description">
            Ingresa la información para continuar con la suscripción.
          </p>
        </div>
        <NequiNumberField
          required={!awaitingApproval}
          disabled={busy}
          value={phoneNumber}
          change={changePhone}
        />
        <BillingEmailField email={billingEmail} disabled={busy} setEmail={setBillingEmail} />
        <EnrollmentConsent
          enrollment={enrollment}
          disabled={busy}
          decisions={decisions}
          setDecisions={setDecisions}
        />
      </>
    )}
    <Button disabled={!allDecisionsAccepted(decisions) || busy} type="submit">
      {busy ? "Esperando autorización…" : "Autorizar con Nequi"}
    </Button>
  </form>
);

const PreparedCardEnrollmentForm = ({
  enrollment,
  offer,
  busy,
  submit,
}: EnrollmentFormProps): JSX.Element => {
  const [billingEmail, setBillingEmail] = useState<string>(enrollment.billingEmail);
  const [fields, setFields] = useState<CardFields>(emptyCardFields);
  const [decisions, setDecisions] = useState<EnrollmentDecisions>(emptyDecisions);
  const allAccepted = allDecisionsAccepted(decisions);
  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    if (!allAccepted || busy) return;
    submit(
      billingEmail.trim().toLowerCase(),
      enrollment.paymentSourceMode === "create" ? fields : undefined
    );
  };

  const submitLabel = enrollmentSubmitLabel(busy);

  return (
    <form className="subscription-form" onSubmit={onSubmit}>
      {enrollment.paymentSourceMode === "create" ? (
        <CardFieldsForm disabled={busy} fields={fields} setFields={setFields} />
      ) : (
        <p>
          Usaremos de nuevo tu fuente de pago guardada. No necesitas ingresar los datos de nuevo.
        </p>
      )}
      <BillingEmailField email={billingEmail} disabled={busy} setEmail={setBillingEmail} />
      <EnrollmentConsent
        decisions={decisions}
        disabled={busy}
        enrollment={enrollment}
        setDecisions={setDecisions}
      />
      <p className="subscription-charge-summary">
        Se cobrará {offer.moneyText} y se renovará cada {offer.billingUnit}.
      </p>
      <Button disabled={!allAccepted || busy} type="submit">
        {submitLabel}
      </Button>
    </form>
  );
};

const PreparedEnrollmentForm = (props: EnrollmentFormProps): JSX.Element => {
  if (props.enrollment.method === "daviplata" && props.enrollment.paymentSourceMode === "create") {
    return Option.match(props.gateway, {
      onNone: () => <p>DaviPlata no está disponible.</p>,
      onSome: (gateway) => (
        <DaviplataEnrollmentForm
          key={props.enrollment.enrollmentId}
          enrollment={props.enrollment}
          start={gateway.startDaviplata}
          onSubmitted={props.onDaviplataSubmitted}
        />
      ),
    });
  }
  return props.enrollment.method === "nequi" && props.enrollment.paymentSourceMode === "create" ? (
    <NequiEnrollmentForm key={props.enrollment.enrollmentId} {...props} />
  ) : (
    <PreparedCardEnrollmentForm key={props.enrollment.enrollmentId} {...props} />
  );
};

const EnrollmentStatusAction = ({
  current,
  busy,
  prepare,
  refresh,
}: Readonly<{
  current: Exclude<Enrollment, PreparedEnrollment>;
  busy: boolean;
  prepare: (replaceFailedSource?: boolean) => void;
  refresh: (current: PaymentFlowState) => void;
}>): JSX.Element => {
  if (current.status === "available") {
    return (
      <PaymentFeedback tone="source" title="Fuente de pago disponible">
        <output>Tu fuente de pago quedó disponible para cobros recurrentes.</output>
        <p>Esto todavía no confirma que el pago esté aprobado.</p>
      </PaymentFeedback>
    );
  }
  if (current.status === "refused" || current.status === "expired") {
    return (
      <PaymentFeedback
        tone="refused"
        title={current.status === "refused" ? "Autorización rechazada" : "Autorización vencida"}
      >
        <p role="alert">
          {current.status === "refused"
            ? "No pudimos inscribir la fuente de pago."
            : "La inscripción venció."}
        </p>
        <Button disabled={busy} onClick={() => prepare()} type="button">
          Preparar una inscripción nueva
        </Button>
      </PaymentFeedback>
    );
  }
  return (
    <PaymentFeedback tone="pending" title="Verificando fuente de pago">
      <output aria-live="polite">
        {current.status === "verifying"
          ? "Estamos verificando el resultado. No vuelvas a enviar los datos."
          : "Creando tu fuente de pago…"}
      </output>
      <Button
        disabled={busy}
        onClick={() => refresh(enrollmentFlow(current))}
        type="button"
        variant="outline"
      >
        Consultar estado
      </Button>
    </PaymentFeedback>
  );
};

const maximumPaymentStatusRefreshes = 65;

const PaymentSubmissionStatus = ({
  submission,
}: Readonly<{ submission: PaymentSubmission }>): JSX.Element => {
  if (submission.status === "source-verifying") {
    return (
      <PaymentFeedback tone="pending" title="Verificando fuente de pago">
        <output aria-live="polite">Estamos verificando tu fuente de pago.</output>
        <p>Esto todavía no confirma que el pago esté aprobado.</p>
      </PaymentFeedback>
    );
  }
  if (submission.status === "refused") {
    return (
      <PaymentFeedback tone="refused" title="Pago no iniciado">
        <p role="alert">No pudimos iniciar el pago. Puedes intentarlo de nuevo.</p>
      </PaymentFeedback>
    );
  }
  if (submission.billingAttempt.status === "succeeded") {
    return (
      <PaymentFeedback tone="success" title="Pago aprobado">
        <output aria-live="polite">Tu pago fue realizado y tu suscripción está activa.</output>
        <p>
          Tu acceso: <strong>Pro</strong>
        </p>
      </PaymentFeedback>
    );
  }
  if (submission.billingAttempt.status === "failed") {
    return (
      <PaymentFeedback tone="refused" title="Pago rechazado">
        <p role="alert">Wompi rechazó el pago. Puedes intentarlo de nuevo.</p>
      </PaymentFeedback>
    );
  }
  return (
    <PaymentFeedback tone="pending" title="Pago pendiente">
      <output aria-live="polite">
        Estamos esperando la confirmación del pago. No vuelvas a enviarlo.
      </output>
    </PaymentFeedback>
  );
};

type PaymentFlowState =
  | Readonly<{ _tag: "Enrollment"; value: Enrollment }>
  | Readonly<{
      _tag: "PaymentSubmission";
      value: PaymentSubmission;
      billingEmail: string;
      prepared: Option.Option<PreparedEnrollment>;
    }>;

type PaymentSubmissionFlowState = Extract<PaymentFlowState, { _tag: "PaymentSubmission" }>;

type ScopedPaymentFlow = Readonly<{
  flowId: number;
  state: PaymentFlowState;
}>;

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
    if (Option.isSome(refreshed)) {
      current = submissionFlow(refreshed.value, current.billingEmail, current.prepared);
      yield* Effect.sync(() => publish(current));
    }
  }
});

type PaymentRefreshIdentity = Readonly<{
  enrollmentId: PreparedEnrollment["enrollmentId"];
  flowId: ScopedPaymentFlow["flowId"];
}>;

type PaymentStatusRefreshCommand = Readonly<{
  gateway: EnrollmentGateway;
  identity: PaymentRefreshIdentity;
  initial: PaymentSubmissionFlowState;
  publish: (identity: PaymentRefreshIdentity, current: PaymentSubmissionFlowState) => void;
}>;

const PaymentStatusRefresh = makeScopedAtom(() =>
  Atom.fn<PaymentStatusRefreshCommand>()(
    ({ gateway, identity, initial, publish }) =>
      refreshPaymentUntilTerminal(gateway, initial, (current) => publish(identity, current)),
    { concurrent: false }
  )
);

const PaymentFlow = makeScopedAtom(() =>
  Atom.make<Option.Option<ScopedPaymentFlow>>(Option.none())
);

const TerminalPaymentFeedback = ({
  current,
  busy,
  prepare,
}: Readonly<{
  current: PaymentSubmissionFlowState;
  busy: boolean;
  prepare: (replaceFailedSource?: boolean) => void;
}>): JSX.Element => {
  const canRetry =
    current.value.status === "refused" ||
    (current.value.status === "payment-pending" &&
      current.value.billingAttempt.status === "failed");
  return (
    <div className="flex flex-col gap-3">
      <PaymentSubmissionStatus submission={current.value} />
      {canRetry && (
        <Button disabled={busy} onClick={() => prepare()} type="button">
          Volver a intentar
        </Button>
      )}
      {canRetry && Option.exists(current.prepared, (prepared) => prepared.method === "card") && (
        <Button disabled={busy} onClick={() => prepare(true)} type="button" variant="outline">
          Usar otra tarjeta
        </Button>
      )}
    </div>
  );
};

const renderPaymentEnrollment = (
  input: DaviplataFormActions & {
    current: PaymentFlowState;
    offer: SubscriptionOfferPresentation;
    busy: boolean;
    prepare: (replaceFailedSource?: boolean) => void;
    submit: (prepared: PreparedEnrollment, email: string, fields?: PaymentFields) => void;
    refresh: (current: PaymentFlowState) => void;
  }
): JSX.Element => {
  const { current, busy, prepare, submit, refresh } = input;
  if (current._tag === "PaymentSubmission") {
    if (!isAwaitingPaymentStatus(current.value)) {
      return <TerminalPaymentFeedback current={current} busy={busy} prepare={prepare} />;
    }
    return (
      <div className="subscription-payment-status">
        <PaymentSubmissionStatus submission={current.value} />
        <Button disabled={busy} onClick={() => refresh(current)} type="button" variant="outline">
          Consultar estado
        </Button>
      </div>
    );
  }
  const enrollment = current.value;
  if (enrollment.status === "prepared") {
    return (
      <div className="flex flex-col gap-5">
        <PreparedEnrollmentForm
          offer={input.offer}
          gateway={input.gateway}
          onDaviplataSubmitted={input.onDaviplataSubmitted}
          busy={busy}
          enrollment={enrollment}
          submit={(email, fields) => submit(enrollment, email, fields)}
        />
        {enrollment.method === "card" && enrollment.paymentSourceMode === "reuse" && (
          <Button disabled={busy} onClick={() => prepare(true)} type="button" variant="outline">
            Usar otra tarjeta
          </Button>
        )}
      </div>
    );
  }
  return (
    <EnrollmentStatusAction busy={busy} current={enrollment} prepare={prepare} refresh={refresh} />
  );
};

const EnrollmentContent = ({
  offer,
  gateway,
  onDaviplataSubmitted,
  enrollment,
  busy,
  prepare,
  submit,
  refresh,
}: Readonly<{
  enrollment: Option.Option<PaymentFlowState>;
  offer: SubscriptionOfferPresentation;
  busy: boolean;
  prepare: (replaceFailedSource?: boolean) => void;
  submit: (prepared: PreparedEnrollment, email: string, fields?: PaymentFields) => void;
  refresh: (current: PaymentFlowState) => void;
}> &
  DaviplataFormActions): JSX.Element =>
  Option.match(enrollment, {
    onNone: () => (busy ? <p aria-live="polite">Cargando formulario…</p> : <></>),
    onSome: (current) =>
      renderPaymentEnrollment({
        current,
        offer,
        busy,
        prepare,
        submit,
        refresh,
        gateway,
        onDaviplataSubmitted,
      }),
  });

const focusPaymentHeading: RefCallback<HTMLHeadingElement> = (node) => {
  node?.focus();
};

const PaymentDetails = ({
  offer,
  gateway,
  onDaviplataSubmitted,
  method,
  enrollment,
  busy,
  failed,
  prepare,
  submit,
  refresh,
}: Readonly<{
  enrollment: Option.Option<PaymentFlowState>;
  offer: SubscriptionOfferPresentation;
  busy: boolean;
  failed: boolean;
  prepare: (replaceFailedSource?: boolean) => void;
  submit: (prepared: PreparedEnrollment, email: string, fields?: PaymentFields) => void;
  refresh: (current: PaymentFlowState) => void;
  method: EnrollmentMethod;
}> &
  DaviplataFormActions): JSX.Element => (
  <section className="subscription-payment" aria-label={paymentMethodCopy[method].title}>
    <h2 ref={focusPaymentHeading} tabIndex={-1} className="subscription-payment-title">
      {paymentMethodCopy[method].title}
    </h2>
    <div className="subscription-mobile-summary">
      <p>Pro {offer.selectionLabel}</p>
      <strong>{offer.moneyText}</strong> / {offer.billingUnit}
    </div>
    {failed ? (
      <p role="alert">No pudimos continuar. Revisa los datos o intenta más tarde.</p>
    ) : null}
    <EnrollmentContent
      offer={offer}
      gateway={gateway}
      onDaviplataSubmitted={onDaviplataSubmitted}
      busy={busy}
      enrollment={enrollment}
      prepare={prepare}
      refresh={refresh}
      submit={submit}
    />
  </section>
);

type EnrollmentInteraction = Readonly<{
  enrollment: Option.Option<PaymentFlowState>;
  busy: boolean;
  failed: boolean;
  interrupt: () => void;
  start: (
    work: (
      gateway: EnrollmentGateway
    ) => Effect.Effect<PaymentFlowState, EnrollmentInteractionFailed>
  ) => void;
  reset: () => void;
}>;

type PaymentFlowSetter = (
  value:
    | Option.Option<ScopedPaymentFlow>
    | ((current: Option.Option<ScopedPaymentFlow>) => Option.Option<ScopedPaymentFlow>)
) => void;

type PaymentRefreshControl = Readonly<{
  interrupt: () => void;
  start: (flowId: number, value: PaymentFlowState) => void;
}>;

const retainCurrentFlow = (
  existing: Option.Option<ScopedPaymentFlow>,
  identity: PaymentRefreshIdentity,
  current: PaymentSubmissionFlowState
): Option.Option<ScopedPaymentFlow> =>
  Option.orElse(
    Option.map(
      Option.filter(
        existing,
        (active) =>
          active.flowId === identity.flowId &&
          active.state._tag === "PaymentSubmission" &&
          active.state.value.enrollmentId === identity.enrollmentId &&
          current.value.enrollmentId === identity.enrollmentId
      ),
      () => ({ flowId: identity.flowId, state: current })
    ),
    () => existing
  );

const usePaymentRefreshLifetimeRef = (interrupt: () => void): RefCallback<HTMLDivElement> => {
  const [lifetimeRef] = useState<RefCallback<HTMLDivElement>>(
    () => (): ReturnType<RefCallback<HTMLDivElement>> => interrupt
  );
  return lifetimeRef;
};

const usePaymentRefresh = (
  gateway: Option.Option<EnrollmentGateway>,
  setScopedFlow: PaymentFlowSetter
): PaymentRefreshControl => {
  const refreshPaymentStatus = useAtomSet(PaymentStatusRefresh.use());
  const interrupt = (): void => refreshPaymentStatus(Atom.Interrupt);
  const start = (flowId: number, value: PaymentFlowState): void => {
    if (value._tag !== "PaymentSubmission" || !isAwaitingPaymentStatus(value.value)) {
      interrupt();
      return;
    }
    Option.match(gateway, {
      onNone: interrupt,
      onSome: (availableGateway) =>
        refreshPaymentStatus({
          gateway: availableGateway,
          identity: { enrollmentId: value.value.enrollmentId, flowId },
          initial: value,
          publish: (identity, current) =>
            setScopedFlow((existing) => retainCurrentFlow(existing, identity, current)),
        }),
    });
  };
  return { interrupt, start };
};

const publishPaymentFlow =
  (
    input: Readonly<{
      activeFlowId: RefObject<number>;
      flowId: number;
      setScopedFlow: PaymentFlowSetter;
      paymentRefresh: PaymentRefreshControl;
    }>
  ): ((value: PaymentFlowState) => Effect.Effect<void>) =>
  (value) =>
    Effect.sync(() => {
      if (input.activeFlowId.current !== input.flowId) return;
      input.setScopedFlow(Option.some({ flowId: input.flowId, state: value }));
      input.paymentRefresh.start(input.flowId, value);
    });

const useEnrollmentInteraction = (
  gateway: Option.Option<EnrollmentGateway>
): EnrollmentInteraction => {
  const [scopedFlow, setScopedFlow] = useAtom(PaymentFlow.use());
  const [command] = useState(() =>
    makeEnrollmentCommand<PaymentFlowState, EnrollmentInteractionFailed>()
  );
  const status = useAtomValue(command.atom);
  const controlCommand = useAtomSet(command.atom);
  const activeFlowId = useRef(0);
  const paymentRefresh = usePaymentRefresh(gateway, setScopedFlow);
  const interrupt = (): void => {
    activeFlowId.current += 1;
    command.clear();
    controlCommand(Atom.Interrupt);
    paymentRefresh.interrupt();
  };
  const start = (
    work: (
      gateway: EnrollmentGateway
    ) => Effect.Effect<PaymentFlowState, EnrollmentInteractionFailed>
  ): void => {
    paymentRefresh.interrupt();
    activeFlowId.current += 1;
    const flowId = activeFlowId.current;
    Option.match(gateway, {
      onNone: () => undefined,
      onSome: (availableGateway) => {
        command.offer(
          work(availableGateway).pipe(
            Effect.tap(publishPaymentFlow({ activeFlowId, flowId, setScopedFlow, paymentRefresh }))
          )
        );
        controlCommand(undefined);
      },
    });
  };
  const reset = (): void => {
    interrupt();
    controlCommand(Atom.Reset);
    setScopedFlow(Option.none());
  };
  return {
    enrollment: Option.map(scopedFlow, (active) => active.state),
    busy: status.waiting,
    failed: AsyncResult.isFailure(status) && !Cause.hasInterrupts(status.cause),
    interrupt,
    start,
    reset,
  };
};

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

const refreshPaymentFlow = (
  gateway: EnrollmentGateway,
  current: PaymentFlowState
): Effect.Effect<PaymentFlowState, EnrollmentInteractionFailed> => {
  if (current._tag === "PaymentSubmission") {
    return Effect.tryPromise({
      try: (signal) => observePayment(gateway, current, signal),
      catch: () => new EnrollmentInteractionFailed(),
    }).pipe(Effect.map((value) => submissionFlow(value, current.billingEmail, current.prepared)));
  }
  return Effect.tryPromise({
    try: (signal) => gateway.status(current.value.enrollmentId, signal),
    catch: () => new EnrollmentInteractionFailed(),
  }).pipe(Effect.map(enrollmentFlow));
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
    Effect.map((submission) => submissionFlow(submission, input.email, Option.some(input.prepared)))
  );

const PaymentFlowDetails = ({
  gateway,
  offer,
  method,
  interaction,
}: Readonly<{
  gateway: Option.Option<EnrollmentGateway>;
  offer: SubscriptionOfferPresentation;
  method: EnrollmentMethod;
  interaction: EnrollmentInteraction;
}>): JSX.Element => (
  <PaymentDetails
    offer={offer}
    gateway={gateway}
    onDaviplataSubmitted={(email, submission) =>
      interaction.start(() => Effect.succeed(submissionFlow(submission, email, Option.none())))
    }
    method={method}
    busy={interaction.busy}
    enrollment={interaction.enrollment}
    failed={interaction.failed}
    prepare={(replacing = false) =>
      interaction.start((gateway) =>
        preparePaymentFlow(gateway, offer.id, { method, replaceFailedSource: replacing })
      )
    }
    refresh={(current) => interaction.start((gateway) => refreshPaymentFlow(gateway, current))}
    submit={(prepared, email, fields) =>
      interaction.start((gateway) =>
        submitPaymentFlow(gateway, {
          prepared,
          email,
          fields: Option.fromNullishOr(fields),
        })
      )
    }
  />
);

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
const useEnrollmentMethods = (
  gateway: Option.Option<EnrollmentGateway>
): Readonly<{
  enabledMethods: ReadonlyArray<EnrollmentMethod>;
  refresh: () => void;
  waiting: boolean;
  failed: boolean;
}> => {
  const availabilityAtom = enrollmentAvailability(gateway);
  const availability = useAtomValue(availabilityAtom);
  const refresh = useAtomRefresh(availabilityAtom);
  return {
    enabledMethods: availability._tag === "Success" ? availability.value.enabledMethods : [],
    refresh,
    waiting: availability.waiting,
    failed: AsyncResult.isFailure(availability),
  };
};
const paymentSelectionIsLocked = (current: PaymentFlowState): boolean =>
  current._tag === "PaymentSubmission" &&
  (isAwaitingPaymentStatus(current.value) ||
    (current.value.status === "payment-pending" &&
      current.value.billingAttempt.status === "succeeded"));

type SubscriptionStandingPresentation = Readonly<{ state: StandingViewState; refresh: () => void }>;
const hasPaidAccess = (state: StandingViewState): boolean =>
  state._tag === "Ready" &&
  state.standing.accessTier === "pro" &&
  Option.isSome(state.standing.paidSubscription);

type ReadyOffersProps = Readonly<{
  standing: SubscriptionStandingPresentation;
  offers: SubscriptionOffers;
  gateway: Option.Option<EnrollmentGateway>;
}>;
type SubscriptionSelection = Readonly<{
  selectedId: Option.Option<PriceId>;
  method: EnrollmentMethod;
  checkout: boolean;
  enabledMethods: ReadonlyArray<EnrollmentMethod>;
  refreshMethods: () => void;
  methodsWaiting: boolean;
  methodsFailed: boolean;
  interaction: EnrollmentInteraction;
  presented: ReadonlyArray<SubscriptionOfferPresentation>;
  disabled: boolean;
  selectedOffer: Option.Option<SubscriptionOfferPresentation>;
  canContinue: boolean;
  selectPrice: (id: PriceId) => void;
  selectMethod: (method: EnrollmentMethod) => void;
  changeSelection: () => void;
  continueToPayment: () => void;
}>;
const useSubscriptionSelection = ({ offers, gateway }: ReadyOffersProps): SubscriptionSelection => {
  const [selectedId, setSelectedId] = useState<Option.Option<PriceId>>(Option.none);
  const [method, setMethod] = useState<EnrollmentMethod>("card");
  const [checkout, setCheckout] = useState(false);
  const [replaceFailedSource, setReplaceFailedSource] = useState(false);
  const availability = useEnrollmentMethods(gateway);
  const { enabledMethods } = availability;
  const authorizationLocked = useAtomValue(DaviplataAuthorizationLock.use());
  const interaction = useEnrollmentInteraction(gateway);
  const presented = offers.map(presentSubscriptionOffer);
  const disabled =
    interaction.busy ||
    authorizationLocked ||
    Option.exists(interaction.enrollment, paymentSelectionIsLocked);
  const selectedOffer = Option.flatMap(selectedId, (id) =>
    EffectArray.findFirst(presented, (offer) => offer.id === id)
  );
  const canContinue = !disabled && Option.isSome(selectedOffer) && enabledMethods.includes(method);
  return {
    selectedId,
    method,
    checkout,
    enabledMethods,
    refreshMethods: availability.refresh,
    methodsWaiting: availability.waiting,
    methodsFailed: availability.failed,
    interaction,
    presented,
    disabled,
    selectedOffer,
    canContinue,
    selectPrice: (id: PriceId): void => {
      setSelectedId(Option.some(id));
      interaction.reset();
    },
    selectMethod: (choice: EnrollmentMethod): void => {
      if (choice === method) return;
      setMethod(choice);
      setReplaceFailedSource(true);
      interaction.reset();
    },
    changeSelection: (): void => {
      if (disabled) return;
      interaction.reset();
      setCheckout(false);
      requestAnimationFrame(() => document.getElementById("subscription-period-title")?.focus());
    },
    continueToPayment: (): void => {
      if (!canContinue) return;
      Option.map(selectedOffer, (offer) => {
        setCheckout(true);
        interaction.start((gateway) =>
          preparePaymentFlow(gateway, offer.id, { method, replaceFailedSource })
        );
      });
    },
  };
};
const methodAvailabilityMessage = (
  selection: Pick<SubscriptionSelection, "methodsWaiting" | "methodsFailed">
): string => {
  if (selection.methodsWaiting) return "Consultando métodos de pago…";
  if (selection.methodsFailed) return "No pudimos consultar los métodos de pago. Intenta de nuevo.";
  return "No hay métodos de pago disponibles en este momento.";
};
const OfferOverview = ({
  selection,
  terms,
}: Readonly<{
  selection: SubscriptionSelection;
  terms: SubscriptionOfferPresentation;
}>): JSX.Element => (
  <>
    <OfferSelection
      disabled={selection.disabled}
      presented={selection.presented}
      selectedId={selection.selectedId}
      select={selection.selectPrice}
    />
    <SubscriptionTerms offer={terms} />
    <PaymentMethodSelection
      enabledMethods={selection.enabledMethods}
      selected={selection.method}
      disabled={selection.disabled}
      select={selection.selectMethod}
    />
    {selection.enabledMethods.length === 0 && (
      <div>
        <p aria-live="polite" className="subscription-muted">
          {methodAvailabilityMessage(selection)}
        </p>
        <Button
          type="button"
          variant="outline"
          disabled={selection.methodsWaiting}
          onClick={selection.refreshMethods}
        >
          Actualizar métodos
        </Button>
      </div>
    )}
    <div className="subscription-continue">
      <Button type="button" disabled={!selection.canContinue} onClick={selection.continueToPayment}>
        {paymentMethodCopy[selection.method].continueLabel}
      </Button>
    </div>
  </>
);
const Checkout = ({
  selection,
  gateway,
}: Readonly<{
  selection: SubscriptionSelection;
  gateway: Option.Option<EnrollmentGateway>;
}>): JSX.Element => (
  <>
    <div className="subscription-back">
      <Button
        variant="ghost"
        type="button"
        disabled={selection.disabled}
        onClick={selection.changeSelection}
      >
        <HugeiconsIcon icon={ArrowLeft01Icon} size={22} aria-hidden="true" />
        Cambiar selección
      </Button>
    </div>
    {Option.match(selection.selectedOffer, {
      onNone: () => null,
      onSome: (offer) => (
        <PaymentFlowDetails
          key={`${selection.method}:${offer.id}`}
          gateway={gateway}
          offer={offer}
          method={selection.method}
          interaction={selection.interaction}
        />
      ),
    })}
  </>
);
const ReadyOffersContent = (props: ReadyOffersProps): JSX.Element => {
  const selection = useSubscriptionSelection(props);
  const refreshLifetimeRef = usePaymentRefreshLifetimeRef(selection.interaction.interrupt);
  const { standing } = props;
  const paid = hasPaidAccess(standing.state);
  return (
    <div
      ref={refreshLifetimeRef}
      className="subscription-columns"
      data-checkout={selection.checkout}
      data-method={selection.method}
      data-paid={paid}
    >
      <div className="subscription-main">
        {selection.checkout ? (
          <Checkout selection={selection} gateway={props.gateway} />
        ) : (
          <>
            <SubscriptionStandingView state={standing.state} onRetry={standing.refresh} />
            {!paid && (
              <OfferOverview
                selection={selection}
                terms={presentSubscriptionOffer(props.offers[0])}
              />
            )}
          </>
        )}
      </div>
      <SubscriptionSummary
        offer={selection.selectedOffer}
        checkout={selection.checkout}
        paid={paid}
      />
    </div>
  );
};

const ReadyOffers = ({ offers, gateway, standing }: ReadyOffersProps): JSX.Element => (
  <PaymentFlow.Provider>
    <PaymentStatusRefresh.Provider>
      <DaviplataAuthorizationLock.Provider>
        <ReadyOffersContent gateway={gateway} offers={offers} standing={standing} />
      </DaviplataAuthorizationLock.Provider>
    </PaymentStatusRefresh.Provider>
  </PaymentFlow.Provider>
);

const AuthenticationRequired = (): JSX.Element => (
  <Alert>
    <AlertTitle>Inicia sesión para activar Pro</AlertTitle>
    <AlertDescription className="flex flex-col items-start gap-3">
      <p>Vincula este navegador con tu cuenta de Fidy para continuar.</p>
      <Button render={<a aria-label="Iniciar sesión" href="/login" />} size="sm">
        Iniciar sesión
      </Button>
    </AlertDescription>
  </Alert>
);

const LoadFailure = ({
  boundaryFailure,
  onRetry,
  waiting,
}: Readonly<{
  boundaryFailure: boolean;
  onRetry: () => void;
  waiting: boolean;
}>): JSX.Element => (
  <CanonicalQueryRetry
    description="Intenta de nuevo en unos momentos."
    onRetry={onRetry}
    retryLabel="Reintentar carga"
    retryingLabel="Reintentando…"
    title={boundaryFailure ? "No pudimos comunicarnos con Fidy" : "No pudimos cargar las ofertas"}
    waiting={waiting}
  />
);

const SubscriptionOffersContent = ({
  state,
  gateway,
  standing,
}: Readonly<{
  standing: SubscriptionStandingPresentation;
  state: SubscriptionOffersPageState;
  gateway: Option.Option<EnrollmentGateway>;
}>): JSX.Element => {
  switch (state._tag) {
    case "Initial":
      return <p className="text-muted-foreground">La consulta de ofertas aún no se ha iniciado.</p>;
    case "Loading":
      return <LoadingOffers />;
    case "Ready":
      return <ReadyOffers gateway={gateway} offers={state.offers} standing={standing} />;
    case "Refreshing":
      return (
        <>
          <p aria-live="polite" className="text-sm text-muted-foreground">
            Actualizando ofertas…
          </p>
          <ReadyOffers gateway={gateway} offers={state.offers} standing={standing} />
        </>
      );
    case "RefreshFailure":
      return (
        <>
          <CanonicalQueryRetry
            description="Mostramos las últimas ofertas disponibles."
            onRetry={state.onRetry}
            retryLabel="Reintentar actualización"
            retryingLabel="Reintentando…"
            title="No pudimos actualizar las ofertas"
            waiting={state.waiting}
          />
          <ReadyOffers gateway={gateway} offers={state.offers} standing={standing} />
        </>
      );
    case "AuthenticationRequired":
      return <AuthenticationRequired />;
    case "LoadFailure":
      return (
        <LoadFailure
          boundaryFailure={state.boundaryFailure}
          onRetry={state.onRetry}
          waiting={state.waiting}
        />
      );
  }
};

const StandingWithoutOffers = ({
  standing,
  children,
}: Readonly<{
  standing: SubscriptionStandingPresentation;
  children: JSX.Element;
}>): JSX.Element => (
  <div className="subscription-columns" data-paid={hasPaidAccess(standing.state)}>
    <div className="subscription-main">
      <SubscriptionStandingView state={standing.state} onRetry={standing.refresh} />
      <div className="subscription-offers-feedback">{children}</div>
    </div>
    <SubscriptionSummary
      paid={hasPaidAccess(standing.state)}
      offer={Option.none()}
      checkout={false}
    />
  </div>
);

export const SubscriptionOffersView = ({
  state,
  gateway,
  standing,
}: Readonly<{
  state: SubscriptionOffersPageState;
  gateway: Option.Option<EnrollmentGateway>;
  standing: SubscriptionStandingPresentation;
}>): JSX.Element => {
  const content = <SubscriptionOffersContent gateway={gateway} state={state} standing={standing} />;
  const hasOfferContent =
    state._tag === "Ready" ||
    state._tag === "Refreshing" ||
    state._tag === "RefreshFailure" ||
    state._tag === "AuthenticationRequired";
  return (
    <SubscriptionWorkspace>
      {hasOfferContent ? (
        content
      ) : (
        <StandingWithoutOffers standing={standing}>{content}</StandingWithoutOffers>
      )}
    </SubscriptionWorkspace>
  );
};

const subscriptionOffersQuery = Atom.family((client: FidyClient) =>
  client.query("subscription", "listSubscriptionOffers", {})
);
const subscriptionStatusQuery = Atom.family((client: FidyClient) =>
  client.query("subscription", "getSubscriptionStatus", {})
);

const useSubscriptionStanding = (): SubscriptionStandingPresentation => {
  const router = useRouter();
  const query = subscriptionStatusQuery(router.options.context.apiClient);
  const status = useAtomValue(query);
  const refresh = useAtomRefresh(query);
  const view = presentCanonicalQuery(status);
  return {
    state:
      view._tag === "Ready" ? { _tag: "Ready", standing: view.value.data } : { _tag: view._tag },
    refresh,
  };
};

const readyOffersState = ({
  offers,
  refreshFailure,
  refreshing,
  onRetry,
}: Readonly<{
  offers: SubscriptionOffers;
  refreshFailure: boolean;
  refreshing: boolean;
  onRetry: () => void;
}>): SubscriptionOffersPageState => {
  if (refreshFailure) return { _tag: "RefreshFailure", offers, onRetry, waiting: refreshing };
  if (refreshing) return { _tag: "Refreshing", offers };
  return { _tag: "Ready", offers };
};

const AuthorizedSubscriptionOffers = (): JSX.Element => {
  const router = useRouter();
  const { authentication } = useSession();
  const standing = useSubscriptionStanding();
  const enrollmentClient = useSubscriptionEnrollmentClient();
  const [gateway] = useState(() => makeEnrollmentGateway(enrollmentClient));
  const offers = subscriptionOffersQuery(router.options.context.apiClient);
  const result = useAtomValue(offers);
  const refresh = useAtomRefresh(offers);
  if (authentication === "expired") {
    return (
      <SubscriptionOffersView
        standing={standing}
        gateway={Option.none()}
        state={{ _tag: "AuthenticationRequired" }}
      />
    );
  }
  const queryState = presentCanonicalQuery(result);
  switch (queryState._tag) {
    case "Initial":
      return (
        <SubscriptionOffersView
          standing={standing}
          gateway={Option.none()}
          state={{ _tag: queryState.waiting ? "Loading" : "Initial" }}
        />
      );
    case "Failure":
      return (
        <SubscriptionOffersView
          standing={standing}
          gateway={Option.none()}
          state={{
            _tag: "LoadFailure",
            boundaryFailure: queryState.failure._tag !== "DeclaredFailure",
            onRetry: refresh,
            waiting: queryState.waiting,
          }}
        />
      );
    case "Ready":
      return (
        <SubscriptionOffersView
          standing={standing}
          gateway={Option.some(gateway)}
          state={readyOffersState({
            offers: queryState.value.data,
            refreshFailure: Option.isSome(queryState.refreshFailure),
            refreshing: queryState.waiting,
            onRetry: refresh,
          })}
        />
      );
  }
};

export const SubscriptionOffersFeature = (): JSX.Element => (
  <SubscriptionConsentBoundary>
    <AuthorizedSubscriptionOffers />
  </SubscriptionConsentBoundary>
);
