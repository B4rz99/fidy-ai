import {
  make as makeScopedAtom,
  useAtom,
  useAtomRefresh,
  useAtomSet,
  useAtomValue,
} from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Cause, Data, Effect, Array as EffectArray, Option, Predicate, Redacted } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { makeEnrollmentCommand } from "./enrollment-command";
import { DaviplataEnrollmentForm } from "./daviplata-form";
import { DaviplataAuthorizationLock } from "./daviplata-activity";
import { BillingEmailField, EnrollmentConsent } from "./enrollment-controls";
import {
  type EnrollmentDecisions,
  allDecisionsAccepted,
  emptyDecisions,
} from "./enrollment-decisions";
import {
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
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/ui/components/card";
import { Input } from "@/ui/components/input";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import {
  type EnrollmentMethod,
  type FidyClient,
  type SubscriptionStatus,
} from "@/transport/client";
import { Skeleton } from "@/ui/components/skeleton";
import { formatMoney } from "@/transport/money";
import { CanonicalQueryRetry } from "@/ui/canonical-query-feedback";
import {
  type PriceId,
  type SubscriptionOfferPresentation,
  type SubscriptionOffers,
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

/** Exhaustive rendering state for the authenticated Subscription offer page. */
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

const OfferButton = ({
  disabled,
  offer,
  selected,
  select,
}: Readonly<{
  disabled: boolean;
  offer: SubscriptionOfferPresentation;
  selected: boolean;
  select: (id: PriceId) => void;
}>): JSX.Element => (
  <Button
    aria-label={
      selected ? `Oferta ${offer.selectionLabel} seleccionada` : `Elegir ${offer.selectionLabel}`
    }
    aria-pressed={selected}
    className="w-full"
    size="offer"
    disabled={disabled}
    onClick={() => select(offer.id)}
    type="button"
    variant={selected ? "secondary" : "default"}
  >
    {offer.moneyText}/{offer.billingUnit}
  </Button>
);

const CardField = ({
  id,
  label,
  input,
}: Readonly<{
  id: string;
  label: string;
  input: JSX.Element;
}>): JSX.Element => (
  <label className="flex flex-col gap-1" htmlFor={id}>
    {label}
    {input}
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
    id="card-number"
    label="Número de tarjeta"
    input={
      <Input
        id="card-number"
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
    id="cardholder-name"
    label="Nombre en la tarjeta"
    input={
      <Input
        id="cardholder-name"
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
  <fieldset className="grid gap-3 sm:grid-cols-2">
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
  <label className="flex flex-col gap-1" htmlFor="nequi-number">
    Número de Nequi
    <Input
      id="nequi-number"
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
    <form ref={formLifetimeRef} className="flex flex-col gap-5" onSubmit={onSubmit}>
      <NequiNumberField
        required={!awaitingApproval}
        disabled={busy}
        value={phoneNumber}
        change={(value) => {
          setAwaitingApproval(false);
          setPhoneNumber(value);
        }}
      />
      <BillingEmailField email={billingEmail} disabled={busy} setEmail={setBillingEmail} />
      <EnrollmentConsent
        enrollment={enrollment}
        disabled={busy}
        decisions={decisions}
        setDecisions={setDecisions}
      />
      {awaitingApproval && busy ? (
        <output aria-live="polite">
          Aprueba la suscripción en Nequi. Luego verificaremos tu fuente de pago.
        </output>
      ) : null}
      <Button disabled={!allDecisionsAccepted(decisions) || busy} type="submit">
        {busy ? "Esperando autorización…" : "Autorizar con Nequi"}
      </Button>
    </form>
  );
};

const PreparedCardEnrollmentForm = ({
  enrollment,
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
    <form className="flex flex-col gap-5" onSubmit={onSubmit}>
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
  prepare: () => void;
  refresh: (enrollmentId: PreparedEnrollment["enrollmentId"]) => void;
}>): JSX.Element => {
  if (current.status === "available") {
    return <output>Tu fuente de pago quedó disponible para cobros recurrentes.</output>;
  }
  if (current.status === "refused" || current.status === "expired") {
    return (
      <div className="flex flex-col gap-2">
        <p role="alert">
          {current.status === "refused"
            ? "No pudimos inscribir la fuente de pago."
            : "La inscripción venció."}
        </p>
        <Button disabled={busy} onClick={prepare} type="button">
          Preparar una inscripción nueva
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <output>
        {current.status === "verifying"
          ? "Estamos verificando el resultado. No vuelvas a enviar los datos."
          : "Creando tu fuente de pago…"}
      </output>
      <Button disabled={busy} onClick={() => refresh(current.enrollmentId)} type="button">
        Consultar estado
      </Button>
    </div>
  );
};

const maximumPaymentStatusRefreshes = 65;

const PaymentSubmissionStatus = ({
  submission,
}: Readonly<{
  submission: PaymentSubmission;
}>): JSX.Element => {
  if (submission.status === "source-verifying") {
    return <output aria-live="polite">Estamos verificando tu fuente de pago.</output>;
  }
  if (submission.status === "refused") {
    return <p role="alert">No pudimos iniciar el pago. Puedes intentarlo de nuevo.</p>;
  }
  if (submission.billingAttempt.status === "succeeded") {
    return <output aria-live="polite">Tu pago fue realizado y tu suscripción está activa.</output>;
  }
  if (submission.billingAttempt.status === "failed") {
    return <p role="alert">Wompi rechazó el pago. Puedes intentarlo de nuevo.</p>;
  }
  return <></>;
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
  method: EnrollmentMethod
) {
  const prepared = yield* Effect.tryPromise({
    try: (signal) => gateway.prepare(priceId, method, signal),
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
      try: (signal) =>
        current.value.status === "payment-pending"
          ? gateway.observeBillingAttempt(
              current.value.enrollmentId,
              current.value.billingAttempt.id,
              signal
            )
          : gateway.continue(current.value.enrollmentId, current.billingEmail, signal),
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

const renderPaymentEnrollment = (
  input: DaviplataFormActions & {
    current: PaymentFlowState;
    busy: boolean;
    prepare: () => void;
    submit: (prepared: PreparedEnrollment, email: string, fields?: PaymentFields) => void;
    refresh: (enrollmentId: PreparedEnrollment["enrollmentId"]) => void;
  }
): JSX.Element => {
  const { current, busy, prepare, submit, refresh } = input;
  if (current._tag === "PaymentSubmission") {
    if (!isAwaitingPaymentStatus(current.value)) {
      return <PaymentSubmissionStatus submission={current.value} />;
    }
    const prepared = current.prepared;
    return (
      <div className="flex flex-col gap-5">
        {Option.isSome(prepared) && prepared.value.method !== "daviplata" && (
          <PreparedEnrollmentForm
            gateway={input.gateway}
            onDaviplataSubmitted={input.onDaviplataSubmitted}
            busy
            enrollment={prepared.value}
            submit={(email, fields) => submit(prepared.value, email, fields)}
          />
        )}
        <PaymentSubmissionStatus submission={current.value} />
      </div>
    );
  }
  const enrollment = current.value;
  if (enrollment.status === "prepared") {
    return (
      <div className="flex flex-col gap-5">
        <PreparedEnrollmentForm
          gateway={input.gateway}
          onDaviplataSubmitted={input.onDaviplataSubmitted}
          busy={busy}
          enrollment={enrollment}
          submit={(email, fields) => submit(enrollment, email, fields)}
        />
      </div>
    );
  }
  return (
    <EnrollmentStatusAction busy={busy} current={enrollment} prepare={prepare} refresh={refresh} />
  );
};

const EnrollmentContent = ({
  gateway,
  onDaviplataSubmitted,
  enrollment,
  busy,
  prepare,
  submit,
  refresh,
}: Readonly<{
  enrollment: Option.Option<PaymentFlowState>;
  busy: boolean;
  prepare: () => void;
  submit: (prepared: PreparedEnrollment, email: string, fields?: PaymentFields) => void;
  refresh: (enrollmentId: PreparedEnrollment["enrollmentId"]) => void;
}> &
  DaviplataFormActions): JSX.Element =>
  Option.match(enrollment, {
    onNone: () => (busy ? <p aria-live="polite">Cargando formulario…</p> : <></>),
    onSome: (current) =>
      renderPaymentEnrollment({
        current,
        busy,
        prepare,
        submit,
        refresh,
        gateway,
        onDaviplataSubmitted,
      }),
  });

const paymentMethodCopy: Readonly<
  Record<EnrollmentMethod, Readonly<{ label: string; title: string; privateFields: string }>>
> = {
  card: { label: "Tarjeta", title: "Pago con tarjeta", privateFields: "Los datos de tu tarjeta" },
  nequi: { label: "Nequi", title: "Pago con Nequi", privateFields: "Tu número de Nequi" },
  daviplata: {
    label: "DaviPlata",
    title: "Pago con DaviPlata",
    privateFields: "Tu documento, número de DaviPlata y código",
  },
};
const PaymentDetails = ({
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
  busy: boolean;
  failed: boolean;
  prepare: () => void;
  submit: (prepared: PreparedEnrollment, email: string, fields?: PaymentFields) => void;
  refresh: (enrollmentId: PreparedEnrollment["enrollmentId"]) => void;
  method: EnrollmentMethod;
}> &
  DaviplataFormActions): JSX.Element => (
  <section aria-label={paymentMethodCopy[method].title}>
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{paymentMethodCopy[method].title}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {failed ? (
          <p role="alert">No pudimos continuar. Revisa los datos o intenta más tarde.</p>
        ) : null}
        <EnrollmentContent
          gateway={gateway}
          onDaviplataSubmitted={onDaviplataSubmitted}
          busy={busy}
          enrollment={enrollment}
          prepare={prepare}
          refresh={refresh}
          submit={submit}
        />
      </CardContent>
      <CardFooter>
        <p className="text-sm text-muted-foreground">
          {paymentMethodCopy[method].privateFields} viajan directamente desde este navegador a
          Wompi. Fidy no los recibe ni los conserva.
        </p>
      </CardFooter>
    </Card>
  </section>
);

const SubscriptionTerms = ({
  offer,
}: Readonly<{ offer: SubscriptionOfferPresentation }>): JSX.Element => (
  <section aria-label="Condiciones de suscripción" className="flex max-w-3xl flex-col gap-2">
    <p>{offer.renewalText}</p>
    <p>{offer.cancellationText}</p>
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

const OfferSelection = ({
  disabled,
  presented,
  selectedId,
  select,
}: Readonly<{
  disabled: boolean;
  presented: ReadonlyArray<SubscriptionOfferPresentation>;
  selectedId: Option.Option<PriceId>;
  select: (id: PriceId) => void;
}>): JSX.Element => (
  <section className="grid gap-4 lg:grid-cols-3" aria-label="Ofertas de suscripción">
    {presented.map((offer) => (
      <OfferButton
        key={offer.id}
        disabled={disabled}
        offer={offer}
        selected={Option.contains(selectedId, offer.id)}
        select={select}
      />
    ))}
  </section>
);

const refreshEnrollmentFlow = (
  gateway: EnrollmentGateway,
  enrollmentId: PreparedEnrollment["enrollmentId"]
): Effect.Effect<PaymentFlowState, EnrollmentInteractionFailed> =>
  Effect.tryPromise({
    try: (signal) => gateway.status(enrollmentId, signal),
    catch: () => new EnrollmentInteractionFailed(),
  }).pipe(Effect.map(enrollmentFlow));

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

const PaymentMethodSelection = ({
  enabledMethods,
  selected,
  disabled,
  select,
}: Readonly<{
  enabledMethods: ReadonlyArray<EnrollmentMethod>;
  selected: EnrollmentMethod;
  disabled: boolean;
  select: (method: EnrollmentMethod) => void;
}>): JSX.Element => (
  <section aria-label="Método de pago" className="flex gap-2">
    {enabledMethods.map((method) => (
      <Button
        key={method}
        type="button"
        aria-pressed={selected === method}
        disabled={disabled}
        onClick={() => select(method)}
      >
        {paymentMethodCopy[method].label}
      </Button>
    ))}
  </section>
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
    gateway={gateway}
    onDaviplataSubmitted={(email, submission) =>
      interaction.start(() => Effect.succeed(submissionFlow(submission, email, Option.none())))
    }
    method={method}
    busy={interaction.busy}
    enrollment={interaction.enrollment}
    failed={interaction.failed}
    prepare={() => interaction.start((gateway) => preparePaymentFlow(gateway, offer.id, method))}
    refresh={(id) => interaction.start((gateway) => refreshEnrollmentFlow(gateway, id))}
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
): ReadonlyArray<EnrollmentMethod> => {
  const availabilityAtom = enrollmentAvailability(gateway);
  const availability = useAtomValue(availabilityAtom);
  return availability._tag === "Success" ? availability.value.enabledMethods : ["card", "nequi"];
};
const makeOfferSelectionActions = (
  input: Readonly<{
    interaction: EnrollmentInteraction;
    method: EnrollmentMethod;
    selectedId: Option.Option<PriceId>;
    setMethod: (method: EnrollmentMethod) => void;
    setSelectedId: (id: Option.Option<PriceId>) => void;
  }>
): Readonly<{ method: (choice: EnrollmentMethod) => void; price: (id: PriceId) => void }> => ({
  method: (choice) => {
    if (input.method === choice) return;
    input.setMethod(choice);
    input.interaction.reset();
    Option.map(input.selectedId, (id) =>
      input.interaction.start((gateway) => preparePaymentFlow(gateway, id, choice))
    );
  },
  price: (id) => {
    input.setSelectedId(Option.some(id));
    input.interaction.reset();
    input.interaction.start((gateway) => preparePaymentFlow(gateway, id, input.method));
  },
});
const ReadyOffersContent = ({
  offers,
  gateway,
}: Readonly<{
  offers: SubscriptionOffers;
  gateway: Option.Option<EnrollmentGateway>;
}>): JSX.Element => {
  const [selectedId, setSelectedId] = useState<Option.Option<PriceId>>(Option.none);
  const [method, setMethod] = useState<EnrollmentMethod>("card");
  const enabledMethods = useEnrollmentMethods(gateway);
  const authorizationLocked = useAtomValue(DaviplataAuthorizationLock.use());
  const interaction = useEnrollmentInteraction(gateway);
  const { enrollment, busy, interrupt } = interaction;
  const select = makeOfferSelectionActions({
    interaction,
    method,
    selectedId,
    setMethod,
    setSelectedId,
  });
  const refreshLifetimeRef = usePaymentRefreshLifetimeRef(interrupt);
  const presented = offers.map(presentSubscriptionOffer);
  const sharedTerms = presentSubscriptionOffer(offers[0]);
  const selectionDisabled =
    authorizationLocked || Option.exists(enrollment, Predicate.isTagged("PaymentSubmission"));
  const selectedOffer = Option.flatMap(selectedId, (id) =>
    EffectArray.findFirst(presented, (offer) => offer.id === id)
  );
  return (
    <div ref={refreshLifetimeRef} className="flex flex-col gap-6">
      <SubscriptionTerms offer={sharedTerms} />
      <PaymentMethodSelection
        enabledMethods={enabledMethods}
        selected={method}
        disabled={busy || selectionDisabled}
        select={select.method}
      />
      <OfferSelection
        disabled={busy || selectionDisabled}
        presented={presented}
        selectedId={selectedId}
        select={select.price}
      />
      {Option.match(selectedOffer, {
        onNone: () => null,
        onSome: (offer) => (
          <PaymentFlowDetails
            key={`${method}:${offer.id}`}
            gateway={gateway}
            offer={offer}
            method={method}
            interaction={interaction}
          />
        ),
      })}
    </div>
  );
};

const ReadyOffers = ({
  offers,
  gateway,
}: Readonly<{
  offers: SubscriptionOffers;
  gateway: Option.Option<EnrollmentGateway>;
}>): JSX.Element => (
  <PaymentFlow.Provider>
    <PaymentStatusRefresh.Provider>
      <DaviplataAuthorizationLock.Provider>
        <ReadyOffersContent gateway={gateway} offers={offers} />
      </DaviplataAuthorizationLock.Provider>
    </PaymentStatusRefresh.Provider>
  </PaymentFlow.Provider>
);

const AuthenticationRequired = (): JSX.Element => (
  <Alert>
    <AlertTitle>Inicia sesión para activar Pro</AlertTitle>
    <AlertDescription className="flex flex-col items-start gap-3">
      <p>Vincula este navegador con tu cuenta de Fidy para continuar.</p>
      <Button render={<a aria-label="Iniciar sesión" href="/auth/pair" />} size="sm">
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
}: Readonly<{
  state: SubscriptionOffersPageState;
  gateway: Option.Option<EnrollmentGateway>;
}>): JSX.Element => {
  switch (state._tag) {
    case "Initial":
      return <p className="text-muted-foreground">La consulta de ofertas aún no se ha iniciado.</p>;
    case "Loading":
      return <LoadingOffers />;
    case "Ready":
      return <ReadyOffers gateway={gateway} offers={state.offers} />;
    case "Refreshing":
      return (
        <>
          <p aria-live="polite" className="text-sm text-muted-foreground">
            Actualizando ofertas…
          </p>
          <ReadyOffers gateway={gateway} offers={state.offers} />
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
          <ReadyOffers gateway={gateway} offers={state.offers} />
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

/** Renders Subscription offers and the direct-browser card enrollment boundary. */
export const SubscriptionOffersView = ({
  state,
  gateway,
}: Readonly<{
  state: SubscriptionOffersPageState;
  gateway: Option.Option<EnrollmentGateway>;
}>): JSX.Element => (
  <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
    <header className="flex max-w-3xl flex-col gap-2">
      <Badge variant="secondary">Fidy Pro</Badge>
      <h1 className="font-heading text-3xl font-semibold tracking-tight">Mejora tu suscripción</h1>
    </header>
    <SubscriptionOffersContent gateway={gateway} state={state} />
  </main>
);

const subscriptionOffersQuery = Atom.family((client: FidyClient) =>
  client.query("subscription", "listSubscriptionOffers", {})
);
const subscriptionStatusQuery = Atom.family((client: FidyClient) =>
  client.query("subscription", "getSubscriptionStatus", {})
);

const billingAttemptLabel = (status: "pending" | "succeeded" | "failed"): string => {
  switch (status) {
    case "pending":
      return "pendiente";
    case "succeeded":
      return "aprobado";
    case "failed":
      return "fallido";
  }
};

const standingDateFormatter = new Intl.DateTimeFormat("es-CO", {
  dateStyle: "long",
  timeZone: "America/Bogota",
});

type StandingViewState =
  | Readonly<{ _tag: "Initial" }>
  | Readonly<{ _tag: "Failure" }>
  | Readonly<{ _tag: "Ready"; standing: SubscriptionStatus }>;

/** Render the closed Subscription standing projection independently of offer loading. */
export const SubscriptionStandingView = ({
  state,
  onRetry,
}: Readonly<{ state: StandingViewState; onRetry: () => void }>): JSX.Element => {
  if (state._tag === "Initial") return <Skeleton className="h-24 w-full" />;
  if (state._tag === "Failure") {
    return (
      <Alert>
        <AlertTitle>Estado no disponible</AlertTitle>
        <AlertDescription>
          No pudimos consultar tu suscripción. Tus datos siguen disponibles.
        </AlertDescription>
        <Button type="button" variant="outline" onClick={onRetry}>
          Reintentar
        </Button>
      </Alert>
    );
  }
  const { accessTier, trialPeriod, paidSubscription, recentAttempts } = state.standing;
  const lastAttempt = recentAttempts[0];
  const periodEnd = Option.isSome(paidSubscription)
    ? paidSubscription.value.endsAt.epochMilliseconds
    : trialPeriod.endsAt.epochMilliseconds;
  const periodLabel = standingDateFormatter.format(periodEnd);
  return (
    <Card aria-label="Estado de la suscripción">
      <CardHeader>
        <CardTitle>Tu acceso: {accessTier === "pro" ? "Pro" : "Gratis"}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <p>
          {Option.isSome(paidSubscription) ? "Último período pagado" : "Período de prueba"}: hasta
          el {periodLabel}.
        </p>
        {Option.isSome(paidSubscription) && (
          <p>
            Precio cobrado: {formatMoney({ locale: "es-CO", money: paidSubscription.value.money })}.
          </p>
        )}
        {lastAttempt !== undefined && (
          <p>Último intento de cobro: {billingAttemptLabel(lastAttempt.status)}.</p>
        )}
        <p className="text-muted-foreground">
          Tu historial permanece disponible aunque termine el acceso Pro. Las cuotas no son un
          bloqueo de suscripción.
        </p>
        <Button type="button" variant="outline" onClick={onRetry}>
          Actualizar estado
        </Button>
      </CardContent>
    </Card>
  );
};

const SubscriptionStanding = (): JSX.Element => {
  const router = useRouter();
  const query = subscriptionStatusQuery(router.options.context.apiClient);
  const status = useAtomValue(query);
  const refresh = useAtomRefresh(query);
  const view = presentCanonicalQuery(status);
  return (
    <SubscriptionStandingView
      state={
        view._tag === "Ready" ? { _tag: "Ready", standing: view.value.data } : { _tag: view._tag }
      }
      onRetry={refresh}
    />
  );
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

const StandingAndOffers = ({ children }: Readonly<{ children: JSX.Element }>): JSX.Element => (
  <>
    <SubscriptionStanding />
    {children}
  </>
);

/** Authenticated route that displays offers and invokes only the direct enrollment transport. */
export const SubscriptionOffersFeature = (): JSX.Element => {
  const router = useRouter();
  const { authentication } = useSession();
  const enrollmentClient = useSubscriptionEnrollmentClient();
  const [gateway] = useState(() => makeEnrollmentGateway(enrollmentClient));
  const offers = subscriptionOffersQuery(router.options.context.apiClient);
  const result = useAtomValue(offers);
  const refresh = useAtomRefresh(offers);
  if (authentication === "expired") {
    return (
      <SubscriptionOffersView gateway={Option.none()} state={{ _tag: "AuthenticationRequired" }} />
    );
  }
  const queryState = presentCanonicalQuery(result);
  switch (queryState._tag) {
    case "Initial":
      return (
        <StandingAndOffers>
          <SubscriptionOffersView
            gateway={Option.none()}
            state={{ _tag: queryState.waiting ? "Loading" : "Initial" }}
          />
        </StandingAndOffers>
      );
    case "Failure":
      return (
        <StandingAndOffers>
          <SubscriptionOffersView
            gateway={Option.none()}
            state={{
              _tag: "LoadFailure",
              boundaryFailure: queryState.failure._tag !== "DeclaredFailure",
              onRetry: refresh,
              waiting: queryState.waiting,
            }}
          />
        </StandingAndOffers>
      );
    case "Ready":
      return (
        <StandingAndOffers>
          <SubscriptionOffersView
            gateway={Option.some(gateway)}
            state={readyOffersState({
              offers: queryState.value.data,
              refreshFailure: Option.isSome(queryState.refreshFailure),
              refreshing: queryState.waiting,
              onRetry: refresh,
            })}
          />
        </StandingAndOffers>
      );
  }
};
