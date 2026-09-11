import { make as makeScopedAtom, useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Data, Effect, Array as EffectArray, Option } from "effect";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { type FormEvent, type JSX, useState } from "react";
import { useSession } from "@/session/session-context";
import { Alert, AlertDescription, AlertTitle } from "@/ui/components/alert";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/ui/components/card";
import { Input } from "@/ui/components/input";
import { type FidyClient } from "@/transport/client";
import { Skeleton } from "@/ui/components/skeleton";
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
  type PaymentSubmission,
  type PreparedEnrollment,
  makeEnrollmentGateway,
} from "./enrollment-gateway";
import { isAwaitingPaymentStatus, paymentStatusRefreshDelay } from "./payment-status";

/** Exhaustive rendering state for the authenticated Subscription offer page. */
export type SubscriptionOffersPageState =
  | Readonly<{ _tag: "Loading" }>
  | Readonly<{ _tag: "Ready"; offers: SubscriptionOffers }>
  | Readonly<{ _tag: "AuthenticationRequired" }>
  | Readonly<{ _tag: "LoadFailure" }>;

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
    className="h-auto w-full py-6 font-heading text-xl font-semibold tabular-nums"
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

type EnrollmentDecisions = Readonly<{
  endUserPolicy: boolean;
  personalData: boolean;
}>;

const EnrollmentConsent = ({
  enrollment,
  decisions,
  disabled,
  setDecisions,
}: Readonly<{
  enrollment: PreparedEnrollment;
  decisions: EnrollmentDecisions;
  disabled: boolean;
  setDecisions: (decisions: EnrollmentDecisions) => void;
}>): JSX.Element => (
  <div className="flex flex-col gap-2">
    <label className="flex items-start gap-2">
      <input
        checked={decisions.endUserPolicy}
        disabled={disabled}
        onChange={(event) => setDecisions({ ...decisions, endUserPolicy: event.target.checked })}
        type="checkbox"
      />
      <span>
        Acepto el{" "}
        <a
          className="underline underline-offset-2"
          href={enrollment.contracts.endUserPolicy.permalink.href}
          rel="noreferrer"
          target="_blank"
        >
          reglamento
        </a>{" "}
        de Wompi.
      </span>
    </label>
    <label className="flex items-start gap-2">
      <input
        checked={decisions.personalData}
        disabled={disabled}
        onChange={(event) => setDecisions({ ...decisions, personalData: event.target.checked })}
        type="checkbox"
      />
      <span>
        Autorizo el{" "}
        <a
          className="underline underline-offset-2"
          href={enrollment.contracts.personalDataAuthorization.permalink.href}
          rel="noreferrer"
          target="_blank"
        >
          tratamiento de datos personales
        </a>{" "}
        de Wompi.
      </span>
    </label>
  </div>
);

const emptyCardFields: CardFields = {
  number: "",
  cvc: "",
  expirationMonth: "",
  expirationYear: "",
  cardholderName: "",
};
const emptyDecisions: EnrollmentDecisions = {
  endUserPolicy: false,
  personalData: false,
};
const allDecisionsAccepted = (decisions: EnrollmentDecisions): boolean =>
  decisions.endUserPolicy && decisions.personalData;

const enrollmentSubmitLabel = (busy: boolean): string => (busy ? "Activando Pro…" : "Activar Pro");

const PreparedEnrollmentForm = ({
  enrollment,
  busy,
  submit,
}: Readonly<{
  enrollment: PreparedEnrollment;
  busy: boolean;
  submit: (billingEmail: string, card?: CardFields) => void;
}>): JSX.Element => {
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
        <p>Usaremos de nuevo tu fuente de pago guardada. No necesitas ingresar la tarjeta.</p>
      )}
      <label className="flex flex-col gap-1" htmlFor="billing-email">
        Correo de facturación
        <Input
          id="billing-email"
          autoComplete="email"
          disabled={busy}
          required
          type="email"
          value={billingEmail}
          onChange={(event) => setBillingEmail(event.target.value)}
        />
      </label>
      <p className="text-sm text-muted-foreground">
        Fidy conservará este correo y lo compartirá con Wompi para los cobros automáticos
        posteriores de tu fuente de pago reutilizable.
      </p>
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
    return <output>Tu tarjeta quedó disponible para cobros recurrentes.</output>;
  }
  if (current.status === "refused" || current.status === "expired") {
    return (
      <div className="flex flex-col gap-2">
        <p role="alert">
          {current.status === "refused"
            ? "No pudimos inscribir la tarjeta."
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
          ? "Estamos verificando el resultado. No vuelvas a enviar la tarjeta."
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
      prepared: PreparedEnrollment;
    }>;

type PaymentSubmissionFlowState = Extract<PaymentFlowState, { _tag: "PaymentSubmission" }>;

const enrollmentFlow = (value: Enrollment): PaymentFlowState => ({ _tag: "Enrollment", value });
const submissionFlow = (
  value: PaymentSubmission,
  billingEmail: string,
  prepared: PreparedEnrollment
): PaymentSubmissionFlowState => ({
  _tag: "PaymentSubmission",
  value,
  billingEmail,
  prepared,
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
      try: () =>
        current.value.status === "payment-pending"
          ? gateway.observeBillingAttempt(
              current.value.enrollmentId,
              current.value.billingAttempt.id
            )
          : gateway.continue(current.value.enrollmentId, current.billingEmail),
      catch: () => new EnrollmentInteractionFailed(),
    }).pipe(Effect.option);
    if (Option.isSome(refreshed)) {
      current = submissionFlow(refreshed.value, current.billingEmail, current.prepared);
      yield* Effect.sync(() => publish(current));
    }
  }
});

type PaymentStatusRefreshCommand = Readonly<{
  gateway: EnrollmentGateway;
  initial: PaymentSubmissionFlowState;
  publish: (current: PaymentSubmissionFlowState) => void;
}>;

const PaymentStatusRefresh = makeScopedAtom(() =>
  Atom.fn<PaymentStatusRefreshCommand>()(
    ({ gateway, initial, publish }) => refreshPaymentUntilTerminal(gateway, initial, publish),
    { concurrent: false }
  )
);

const PaymentFlow = makeScopedAtom(() => Atom.make<Option.Option<PaymentFlowState>>(Option.none()));

const renderPaymentEnrollment = (input: {
  current: PaymentFlowState;
  busy: boolean;
  prepare: () => void;
  submit: (prepared: PreparedEnrollment, email: string, card?: CardFields) => void;
  refresh: (enrollmentId: PreparedEnrollment["enrollmentId"]) => void;
}): JSX.Element => {
  const { current, busy, prepare, submit, refresh } = input;
  if (current._tag === "PaymentSubmission") {
    if (!isAwaitingPaymentStatus(current.value)) {
      return <PaymentSubmissionStatus submission={current.value} />;
    }
    return (
      <div className="flex flex-col gap-5">
        <PreparedEnrollmentForm
          busy
          enrollment={current.prepared}
          submit={(email, card) => submit(current.prepared, email, card)}
        />
        <PaymentSubmissionStatus submission={current.value} />
      </div>
    );
  }
  const enrollment = current.value;
  if (enrollment.status === "prepared") {
    return (
      <div className="flex flex-col gap-5">
        <PreparedEnrollmentForm
          busy={busy}
          enrollment={enrollment}
          submit={(email, card) => submit(enrollment, email, card)}
        />
      </div>
    );
  }
  return (
    <EnrollmentStatusAction busy={busy} current={enrollment} prepare={prepare} refresh={refresh} />
  );
};

const EnrollmentContent = ({
  enrollment,
  busy,
  prepare,
  submit,
  refresh,
}: Readonly<{
  enrollment: Option.Option<PaymentFlowState>;
  busy: boolean;
  prepare: () => void;
  submit: (prepared: PreparedEnrollment, email: string, card?: CardFields) => void;
  refresh: (enrollmentId: PreparedEnrollment["enrollmentId"]) => void;
}>): JSX.Element =>
  Option.match(enrollment, {
    onNone: () => (busy ? <p aria-live="polite">Cargando formulario…</p> : <></>),
    onSome: (current) => renderPaymentEnrollment({ current, busy, prepare, submit, refresh }),
  });

const PaymentDetails = ({
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
  submit: (prepared: PreparedEnrollment, email: string, card?: CardFields) => void;
  refresh: (enrollmentId: PreparedEnrollment["enrollmentId"]) => void;
}>): JSX.Element => (
  <section aria-label="Pago con tarjeta">
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Pago con tarjeta</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {failed ? (
          <p role="alert">No pudimos continuar. Revisa los datos o intenta más tarde.</p>
        ) : null}
        <EnrollmentContent
          busy={busy}
          enrollment={enrollment}
          prepare={prepare}
          refresh={refresh}
          submit={submit}
        />
      </CardContent>
      <CardFooter>
        <p className="text-sm text-muted-foreground">
          Los datos de tu tarjeta viajan directamente desde este navegador a Wompi. Fidy no los
          recibe ni los conserva.
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
  start: (work: (gateway: EnrollmentGateway) => Promise<PaymentFlowState>) => void;
  reset: () => void;
}>;

const useEnrollmentInteraction = (
  gateway: Option.Option<EnrollmentGateway>
): EnrollmentInteraction => {
  const [enrollment, setEnrollment] = useAtom(PaymentFlow.use());
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const refreshPaymentStatus = useAtomSet(PaymentStatusRefresh.use());
  const startAutomaticRefresh = (value: PaymentFlowState): void => {
    if (value._tag !== "PaymentSubmission" || !isAwaitingPaymentStatus(value.value)) return;
    Option.match(gateway, {
      onNone: () => undefined,
      onSome: (availableGateway) =>
        refreshPaymentStatus({
          gateway: availableGateway,
          initial: value,
          publish: (current) => setEnrollment(Option.some(current)),
        }),
    });
  };
  const run = (work: () => Promise<PaymentFlowState>): Promise<void> => {
    setBusy(true);
    setFailed(false);
    return work().then(
      (value) => {
        setEnrollment(Option.some(value));
        setBusy(false);
        startAutomaticRefresh(value);
      },
      () => {
        setFailed(true);
        setBusy(false);
      }
    );
  };
  const start = (work: (gateway: EnrollmentGateway) => Promise<PaymentFlowState>): void => {
    Option.match(gateway, {
      onNone: () => undefined,
      onSome: (availableGateway) =>
        Effect.runFork(
          Effect.tryPromise({
            try: () => run(() => work(availableGateway)),
            catch: () => new EnrollmentInteractionFailed(),
          }).pipe(Effect.ignore)
        ),
    });
  };
  const reset = (): void => {
    setEnrollment(Option.none());
    setFailed(false);
  };
  return { enrollment, busy, failed, start, reset };
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

const ReadyOffersContent = ({
  offers,
  gateway,
}: Readonly<{
  offers: SubscriptionOffers;
  gateway: Option.Option<EnrollmentGateway>;
}>): JSX.Element => {
  const [selectedId, setSelectedId] = useState<Option.Option<PriceId>>(Option.none);
  const { enrollment, busy, failed, start, reset } = useEnrollmentInteraction(gateway);
  const presented = offers.map(presentSubscriptionOffer);
  const sharedTerms = presentSubscriptionOffer(offers[0]);
  const selectionDisabled = Option.exists(
    enrollment,
    (current) => current._tag === "PaymentSubmission"
  );
  const selectedOffer = Option.flatMap(selectedId, (id) =>
    EffectArray.findFirst(presented, (offer) => offer.id === id)
  );
  return (
    <div className="flex flex-col gap-6">
      <SubscriptionTerms offer={sharedTerms} />
      <OfferSelection
        disabled={busy || selectionDisabled}
        presented={presented}
        selectedId={selectedId}
        select={(id) => {
          setSelectedId(Option.some(id));
          reset();
          start((availableGateway) => availableGateway.prepare(id).then(enrollmentFlow));
        }}
      />
      {Option.match(selectedOffer, {
        onNone: () => null,
        onSome: (offer) => (
          <PaymentDetails
            busy={busy}
            enrollment={enrollment}
            failed={failed}
            prepare={() =>
              start((availableGateway) => availableGateway.prepare(offer.id).then(enrollmentFlow))
            }
            refresh={(id) =>
              start((availableGateway) => availableGateway.status(id).then(enrollmentFlow))
            }
            submit={(prepared, email, card) =>
              start((availableGateway) =>
                availableGateway
                  .submit(prepared, email, card)
                  .then((submission) => submissionFlow(submission, email, prepared))
              )
            }
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
      <ReadyOffersContent gateway={gateway} offers={offers} />
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

const LoadFailure = (): JSX.Element => (
  <Alert variant="destructive">
    <AlertTitle>No pudimos cargar las ofertas</AlertTitle>
    <AlertDescription>Intenta de nuevo en unos momentos.</AlertDescription>
  </Alert>
);

const SubscriptionOffersContent = ({
  state,
  gateway,
}: Readonly<{
  state: SubscriptionOffersPageState;
  gateway: Option.Option<EnrollmentGateway>;
}>): JSX.Element => {
  switch (state._tag) {
    case "Loading":
      return <LoadingOffers />;
    case "Ready":
      return <ReadyOffers gateway={gateway} offers={state.offers} />;
    case "AuthenticationRequired":
      return <AuthenticationRequired />;
    case "LoadFailure":
      return <LoadFailure />;
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

/** Authenticated route that displays offers and invokes only the direct enrollment transport. */
export const SubscriptionOffersFeature = (): JSX.Element => {
  const router = useRouter();
  const { authentication } = useSession();
  const offers = subscriptionOffersQuery(router.options.context.apiClient);
  const result = useAtomValue(offers);
  const gateway = makeEnrollmentGateway(router.options.context.subscriptionEnrollmentClient);
  if (AsyncResult.isFailure(result)) {
    const state: SubscriptionOffersPageState =
      authentication === "expired" ? { _tag: "AuthenticationRequired" } : { _tag: "LoadFailure" };
    return <SubscriptionOffersView gateway={Option.none()} state={state} />;
  }
  return AsyncResult.isSuccess(result) ? (
    <SubscriptionOffersView
      gateway={Option.some(gateway)}
      state={{ _tag: "Ready", offers: result.value.data }}
    />
  ) : (
    <SubscriptionOffersView gateway={Option.none()} state={{ _tag: "Loading" }} />
  );
};
