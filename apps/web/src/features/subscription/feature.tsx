import { useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Data, Effect, Array as EffectArray, Option } from "effect";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { type FormEvent, type JSX, useState } from "react";
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
  type PreparedEnrollment,
  makeEnrollmentGateway,
} from "./enrollment-gateway";

/** Exhaustive rendering state for the authenticated Subscription offer page. */
export type SubscriptionOffersPageState =
  | Readonly<{ _tag: "Loading" }>
  | Readonly<{ _tag: "Ready"; offers: SubscriptionOffers }>
  | Readonly<{ _tag: "LoadFailure" }>;

const LoadingOffers = (): JSX.Element => (
  <section className="grid gap-4 lg:grid-cols-3" aria-label="Cargando ofertas" aria-live="polite">
    <Skeleton className="h-96 w-full" />
    <Skeleton className="h-96 w-full" />
    <Skeleton className="h-96 w-full" />
  </section>
);

const OfferButton = ({
  offer,
  selected,
  select,
}: Readonly<{
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
  fields: CardFields;
  setFields: (fields: CardFields) => void;
}>;

const CardNumberField = ({ fields, setFields }: CardFieldsControlProps): JSX.Element => (
  <CardField
    id="card-number"
    label="Número de tarjeta"
    input={
      <Input
        id="card-number"
        autoComplete="cc-number"
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
const ExpirationField = ({ fields, setFields }: CardFieldsControlProps): JSX.Element => {
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

const CvcField = ({ fields, setFields }: CardFieldsControlProps): JSX.Element => (
  <CardField
    id="card-cvc"
    label="CVC"
    input={
      <Input
        id="card-cvc"
        autoComplete="cc-csc"
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

const CardholderNameField = ({ fields, setFields }: CardFieldsControlProps): JSX.Element => (
  <CardField
    id="cardholder-name"
    label="Nombre en la tarjeta"
    input={
      <Input
        id="cardholder-name"
        autoComplete="cc-name"
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

const CardFieldsForm = ({ fields, setFields }: CardFieldsControlProps): JSX.Element => (
  <fieldset className="grid gap-3 sm:grid-cols-2">
    <legend className="sr-only">Datos de pago</legend>
    <CardNumberField fields={fields} setFields={setFields} />
    <ExpirationField fields={fields} setFields={setFields} />
    <CvcField fields={fields} setFields={setFields} />
    <CardholderNameField fields={fields} setFields={setFields} />
  </fieldset>
);

type EnrollmentDecisions = Readonly<{
  endUserPolicy: boolean;
  personalData: boolean;
}>;

const EnrollmentConsent = ({
  enrollment,
  decisions,
  setDecisions,
}: Readonly<{
  enrollment: PreparedEnrollment;
  decisions: EnrollmentDecisions;
  setDecisions: (decisions: EnrollmentDecisions) => void;
}>): JSX.Element => (
  <div className="flex flex-col gap-2">
    <label className="flex items-start gap-2">
      <input
        checked={decisions.endUserPolicy}
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

const enrollmentSubmitLabel = (
  busy: boolean,
  paymentSourceMode: PreparedEnrollment["paymentSourceMode"]
): string => {
  if (busy) return "Procesando…";
  if (paymentSourceMode === "create") return "Guardar tarjeta";
  return "Confirmar";
};

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

  const submitLabel = enrollmentSubmitLabel(busy, enrollment.paymentSourceMode);

  return (
    <form className="flex flex-col gap-5" onSubmit={onSubmit}>
      {enrollment.paymentSourceMode === "create" ? (
        <CardFieldsForm fields={fields} setFields={setFields} />
      ) : (
        <p>Usaremos de nuevo tu fuente de pago guardada. No necesitas ingresar la tarjeta.</p>
      )}
      <label className="flex flex-col gap-1" htmlFor="billing-email">
        Correo de facturación
        <Input
          id="billing-email"
          autoComplete="email"
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

const EnrollmentContent = ({
  enrollment,
  busy,
  prepare,
  submit,
  refresh,
}: Readonly<{
  enrollment: Option.Option<Enrollment>;
  busy: boolean;
  prepare: () => void;
  submit: (prepared: PreparedEnrollment, email: string, card?: CardFields) => void;
  refresh: (enrollmentId: PreparedEnrollment["enrollmentId"]) => void;
}>): JSX.Element =>
  Option.match(enrollment, {
    onNone: () => (busy ? <p aria-live="polite">Cargando formulario…</p> : <></>),
    onSome: (current) =>
      current.status === "prepared" ? (
        <PreparedEnrollmentForm
          busy={busy}
          enrollment={current}
          submit={(email, card) => submit(current, email, card)}
        />
      ) : (
        <EnrollmentStatusAction busy={busy} current={current} prepare={prepare} refresh={refresh} />
      ),
  });

const PaymentDetails = ({
  enrollment,
  busy,
  failed,
  prepare,
  submit,
  refresh,
}: Readonly<{
  enrollment: Option.Option<Enrollment>;
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

class EnrollmentInteractionFailed extends Data.TaggedError("EnrollmentInteractionFailed")<{}> {}

type EnrollmentInteraction = Readonly<{
  enrollment: Option.Option<Enrollment>;
  busy: boolean;
  failed: boolean;
  start: (work: (gateway: EnrollmentGateway) => Promise<Enrollment>) => void;
  reset: () => void;
}>;

const useEnrollmentInteraction = (
  gateway: Option.Option<EnrollmentGateway>
): EnrollmentInteraction => {
  const [enrollment, setEnrollment] = useState<Option.Option<Enrollment>>(Option.none);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const run = (work: () => Promise<Enrollment>): Promise<void> => {
    setBusy(true);
    setFailed(false);
    return work().then(
      (value) => {
        setEnrollment(Option.some(value));
        setBusy(false);
      },
      () => {
        setFailed(true);
        setBusy(false);
      }
    );
  };
  const start = (work: (gateway: EnrollmentGateway) => Promise<Enrollment>): void => {
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

const ReadyOffers = ({
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
  const selectedOffer = Option.flatMap(selectedId, (id) =>
    EffectArray.findFirst(presented, (offer) => offer.id === id)
  );
  return (
    <div className="flex flex-col gap-6">
      <SubscriptionTerms offer={sharedTerms} />
      <section className="grid gap-4 lg:grid-cols-3" aria-label="Ofertas de suscripción">
        {presented.map((offer) => (
          <OfferButton
            key={offer.id}
            offer={offer}
            selected={Option.contains(selectedId, offer.id)}
            select={(id) => {
              setSelectedId(Option.some(id));
              reset();
              start((availableGateway) => availableGateway.prepare(id));
            }}
          />
        ))}
      </section>
      {Option.match(selectedOffer, {
        onNone: () => null,
        onSome: (offer) => (
          <PaymentDetails
            busy={busy}
            enrollment={enrollment}
            failed={failed}
            prepare={() => start((availableGateway) => availableGateway.prepare(offer.id))}
            refresh={(id) => start((availableGateway) => availableGateway.status(id))}
            submit={(prepared, email, card) =>
              start((availableGateway) => availableGateway.submit(prepared, email, card))
            }
          />
        ),
      })}
    </div>
  );
};

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
  const offers = subscriptionOffersQuery(router.options.context.apiClient);
  const result = useAtomValue(offers);
  const gateway = makeEnrollmentGateway(router.options.context.subscriptionEnrollmentClient);
  if (AsyncResult.isFailure(result)) {
    return <SubscriptionOffersView gateway={Option.none()} state={{ _tag: "LoadFailure" }} />;
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
