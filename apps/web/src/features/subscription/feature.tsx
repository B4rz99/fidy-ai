import { SubscriptionInputDecoration } from "@/ui/components/subscription-input-decoration";
import { Input } from "@/ui/components/input";
import { Button } from "@/ui/components/button";
import { Alert, AlertDescription, AlertTitle } from "@/ui/components/alert";
import {
  OffersSkeleton,
  PaymentFormSkeleton,
  PaymentMethodsSkeleton,
} from "@/ui/components/subscription-loading";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Array as EffectArray, Option, Redacted } from "effect";
import { Atom } from "effect/reactivity";
import {
  type EnrollmentInteraction,
  type PaymentFlowView,
  type PaymentSubmissionView,
  makeEnrollmentInteraction,
} from "./interaction";
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
  useRef,
  useState,
} from "react";
import { useSession } from "@/session/session-context";
import { useSubscriptionEnrollmentClient } from "@/session/subscription-enrollment-context";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { type EnrollmentMethod, type FidyClient } from "@/transport/client";
import { CanonicalQueryRetry } from "@/ui/canonical-query-feedback";
import {
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
import { isAwaitingPaymentStatus } from "./payment-status";
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
  refresh: () => void;
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
      <Button disabled={busy} onClick={() => refresh()} type="button" variant="outline">
        Consultar estado
      </Button>
    </PaymentFeedback>
  );
};

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

const TerminalPaymentFeedback = ({
  current,
  busy,
  prepare,
}: Readonly<{
  current: PaymentSubmissionView;
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
      {canRetry && current.canReplaceCard && (
        <Button disabled={busy} onClick={() => prepare(true)} type="button" variant="outline">
          Usar otra tarjeta
        </Button>
      )}
    </div>
  );
};

const renderPaymentEnrollment = (
  input: DaviplataFormActions & {
    current: PaymentFlowView;
    offer: SubscriptionOfferPresentation;
    busy: boolean;
    prepare: (replaceFailedSource?: boolean) => void;
    submit: (email: string, fields?: PaymentFields) => void;
    refresh: () => void;
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
        <Button disabled={busy} onClick={() => refresh()} type="button" variant="outline">
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
          submit={submit}
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
  method,
  gateway,
  onDaviplataSubmitted,
  enrollment,
  busy,
  prepare,
  submit,
  refresh,
}: Readonly<{
  enrollment: Option.Option<PaymentFlowView>;
  offer: SubscriptionOfferPresentation;
  method: EnrollmentMethod;
  busy: boolean;
  prepare: (replaceFailedSource?: boolean) => void;
  submit: (email: string, fields?: PaymentFields) => void;
  refresh: () => void;
}> &
  DaviplataFormActions): JSX.Element =>
  Option.match(enrollment, {
    onNone: () => (busy ? <PaymentFormSkeleton method={method} /> : <></>),
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
  needsRecovery,
  prepare,
  submit,
  refresh,
}: Readonly<{
  enrollment: Option.Option<PaymentFlowView>;
  offer: SubscriptionOfferPresentation;
  busy: boolean;
  failed: boolean;
  needsRecovery: boolean;
  prepare: (replaceFailedSource?: boolean) => void;
  submit: (email: string, fields?: PaymentFields) => void;
  refresh: () => void;
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
    {needsRecovery ? (
      <Button type="button" disabled={busy} variant="outline" onClick={refresh}>
        Consultar estado
      </Button>
    ) : null}
    <EnrollmentContent
      method={method}
      offer={offer}
      gateway={gateway}
      onDaviplataSubmitted={onDaviplataSubmitted}
      busy={busy || needsRecovery}
      enrollment={enrollment}
      prepare={prepare}
      refresh={refresh}
      submit={submit}
    />
  </section>
);

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
type SubscriptionSelection = EnrollmentInteraction &
  Readonly<{
    presented: ReadonlyArray<SubscriptionOfferPresentation>;
    selectedOffer: Option.Option<SubscriptionOfferPresentation>;
  }>;
const useSubscriptionSelection = ({ offers, gateway }: ReadyOffersProps): SubscriptionSelection => {
  const authorizationLock = DaviplataAuthorizationLock.use();
  const [atom] = useState(() => makeEnrollmentInteraction({ offers, gateway, authorizationLock }));
  const interaction = useAtomValue(atom);
  const presented = offers.map(presentSubscriptionOffer);
  const selectedOffer = Option.flatMap(interaction.selectedId, (id) =>
    EffectArray.findFirst(presented, (offer) => offer.id === id)
  );
  return {
    ...interaction,
    presented,
    selectedOffer,
    changeSelection: () => {
      const changed = interaction.changeSelection();
      if (changed) {
        requestAnimationFrame(() => document.getElementById("subscription-period-title")?.focus());
      }
      return changed;
    },
  };
};
const methodAvailabilityMessage = (
  selection: Pick<SubscriptionSelection, "methodsWaiting" | "methodsFailed">
): string => {
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
        {selection.methodsWaiting ? (
          <PaymentMethodsSkeleton />
        ) : (
          <p aria-live="polite" className="subscription-muted">
            {methodAvailabilityMessage(selection)}
          </p>
        )}
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
        <PaymentDetails
          key={`${selection.method}:${offer.id}`}
          gateway={gateway}
          offer={offer}
          method={selection.method}
          enrollment={selection.enrollment}
          busy={selection.busy}
          failed={selection.failed}
          needsRecovery={selection.needsRecovery}
          prepare={selection.prepare}
          submit={selection.submit}
          refresh={selection.refresh}
          onDaviplataSubmitted={selection.submittedDaviplata}
        />
      ),
    })}
  </>
);
const useEnrollmentLifetime = (interaction: EnrollmentInteraction): RefCallback<HTMLDivElement> => {
  const [lifetimeRef] = useState<RefCallback<HTMLDivElement>>(
    () => (): ReturnType<RefCallback<HTMLDivElement>> => interaction.mount()
  );
  return lifetimeRef;
};
const ReadyOffersContent = (props: ReadyOffersProps): JSX.Element => {
  const selection = useSubscriptionSelection(props);
  const lifetimeRef = useEnrollmentLifetime(selection);
  const { standing } = props;
  const paid = hasPaidAccess(standing.state);
  return (
    <div
      ref={lifetimeRef}
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
  <DaviplataAuthorizationLock.Provider>
    <ReadyOffersContent gateway={gateway} offers={offers} standing={standing} />
  </DaviplataAuthorizationLock.Provider>
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
    case "Loading":
      return <OffersSkeleton />;
    case "Ready":
      return <ReadyOffers gateway={gateway} offers={state.offers} standing={standing} />;
    case "Refreshing":
      return (
        <>
          <p aria-live="polite" className="sr-only">
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
