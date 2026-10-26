import {
  Cancel01Icon,
  CreditCardIcon,
  CrownIcon,
  HelpCircleIcon,
  InformationCircleIcon,
  Refresh04Icon,
  SmartPhone01Icon,
  Tick02Icon,
  Time02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { DateTime, Option } from "effect";
import type { JSX, ReactNode } from "react";
import type { EnrollmentMethod, SubscriptionStatus } from "@/transport/client";
import { formatMoney } from "@/transport/money";
import { Button } from "@/ui/components/button";
import { Skeleton } from "@/ui/components/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/components/table";
import {
  type PriceId,
  type SubscriptionOfferPresentation,
  paymentMethodCopy,
} from "./presentation";
import "@/ui/components/subscription.css";

export type StandingViewState =
  | Readonly<{ _tag: "Initial" }>
  | Readonly<{ _tag: "Failure" }>
  | Readonly<{ _tag: "Ready"; standing: SubscriptionStatus }>;

export const SubscriptionWorkspace = ({
  children,
}: Readonly<{ children: ReactNode }>): JSX.Element => (
  <main className="subscription-workspace">
    <header className="subscription-header">
      <h1>Suscripción y pagos</h1>
    </header>
    {children}
  </main>
);

export const OfferSelection = ({
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
  <section className="subscription-period-section" aria-labelledby="subscription-period-title">
    <h2 id="subscription-period-title" tabIndex={-1}>
      Elige tu período
    </h2>
    <div className="subscription-offers" aria-label="Ofertas de suscripción">
      {presented.map((offer) => {
        const selected = Option.contains(selectedId, offer.id);
        return (
          <div className="subscription-offer" key={offer.id}>
            <Button
              type="button"
              variant="ghost"
              aria-label={
                selected
                  ? `Oferta ${offer.selectionLabel} seleccionada`
                  : `Elegir ${offer.selectionLabel}`
              }
              aria-pressed={selected}
              disabled={disabled}
              onClick={() => select(offer.id)}
            >
              <span className="subscription-offer-label">
                <span className="subscription-choice-dot" aria-hidden="true" />
                <span>{offer.selectionLabel}</span>
              </span>
              <span className="subscription-offer-price">{offer.moneyText}</span>
              <span className="subscription-offer-period">por {offer.billingUnit}</span>
            </Button>
          </div>
        );
      })}
    </div>
  </section>
);

export const SubscriptionTerms = ({
  offer,
}: Readonly<{ offer: SubscriptionOfferPresentation }>): JSX.Element => (
  <section aria-label="Condiciones de suscripción" className="subscription-terms">
    <p>{offer.renewalText}</p>
    <p>{offer.cancellationText}</p>
  </section>
);

export const PaymentMethodSelection = ({
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
  <section className="subscription-method-section" aria-labelledby="subscription-method-title">
    <h2 id="subscription-method-title">Método de pago</h2>
    <div aria-label="Método de pago" className="subscription-methods">
      {enabledMethods.map((method) => (
        <Button
          key={method}
          type="button"
          variant="outline"
          aria-pressed={selected === method}
          disabled={disabled}
          onClick={() => select(method)}
        >
          <HugeiconsIcon
            icon={method === "card" ? CreditCardIcon : SmartPhone01Icon}
            size={28}
            strokeWidth={1.5}
            aria-hidden="true"
          />
          {paymentMethodCopy[method].label}
        </Button>
      ))}
    </div>
    <p className="subscription-muted">Los métodos disponibles dependen de tu cuenta.</p>
  </section>
);

const SelectedOffer = ({
  offer,
}: Readonly<{ offer: SubscriptionOfferPresentation }>): JSX.Element => (
  <div className="subscription-summary-offer">
    <span className="subscription-status-icon subscription-status-success" aria-hidden="true">
      <HugeiconsIcon icon={CrownIcon} size={34} strokeWidth={1.5} />
    </span>
    <div>
      <h3>Pro {offer.selectionLabel}</h3>
      <p className="subscription-summary-price">
        {offer.moneyText}
        <span> / {offer.billingUnit}</span>
      </p>
    </div>
  </div>
);

export const SubscriptionSummary = ({
  offer,
  checkout,
  paid,
}: Readonly<{
  offer: Option.Option<SubscriptionOfferPresentation>;
  checkout: boolean;
  paid: boolean;
}>): JSX.Element => (
  <aside
    className="subscription-summary"
    aria-label={paid ? "Sobre tu acceso" : "Tu elección"}
    data-checkout={checkout}
  >
    {paid ? (
      <>
        <HugeiconsIcon
          icon={InformationCircleIcon}
          size={32}
          strokeWidth={1.5}
          aria-hidden="true"
        />
        <h2>Sobre tu acceso</h2>
        <p>El período pagado y los intentos de cobro se muestran por separado.</p>
        <p>Un intento pendiente no significa que el pago esté aprobado.</p>
      </>
    ) : (
      <>
        <h2>Tu elección</h2>
        {Option.match(offer, {
          onNone: () => <p>Elige un período para continuar.</p>,
          onSome: (selected) => (
            <>
              <SelectedOffer offer={selected} />
              {checkout ? (
                <div className="subscription-renewal">
                  <HugeiconsIcon
                    icon={Refresh04Icon}
                    size={34}
                    strokeWidth={1.5}
                    aria-hidden="true"
                  />
                  <div>
                    <h3>Renovación automática</h3>
                    <p>{selected.cancellationText}</p>
                  </div>
                </div>
              ) : (
                <p>Cobro recurrente</p>
              )}
            </>
          ),
        })}
      </>
    )}
  </aside>
);

const statusIcons = {
  pending: Time02Icon,
  success: Tick02Icon,
  refused: Cancel01Icon,
  source: CreditCardIcon,
  unavailable: Refresh04Icon,
  uncertain: HelpCircleIcon,
} as const;
export const PaymentFeedback = ({
  tone,
  title,
  children,
}: Readonly<{
  tone: keyof typeof statusIcons;
  title: string;
  children: ReactNode;
}>): JSX.Element => (
  <section className="subscription-feedback" aria-label={title}>
    <span className={`subscription-status-icon subscription-status-${tone}`} aria-hidden="true">
      <HugeiconsIcon icon={statusIcons[tone]} size={36} strokeWidth={1.5} />
    </span>
    <div>
      <h2>{title}</h2>
      <div className="subscription-feedback-content">{children}</div>
    </div>
  </section>
);

const standingDateFormatter = new Intl.DateTimeFormat("es-CO", {
  dateStyle: "long",
  timeZone: "America/Bogota",
});
const attemptDateFormatter = new Intl.DateTimeFormat("es-CO", {
  dateStyle: "medium",
  timeZone: "America/Bogota",
});
const periodLabels = { weekly: "Semanal", monthly: "Mensual", yearly: "Anual" } as const;
const attemptLabels = { pending: "Pendiente", succeeded: "Aprobado", failed: "Fallido" } as const;

const RecentAttempts = ({
  attempts,
}: Readonly<{ attempts: SubscriptionStatus["recentAttempts"] }>): JSX.Element => (
  <section className="subscription-history" aria-labelledby="subscription-history-title">
    <span className="subscription-status-icon" aria-hidden="true">
      <HugeiconsIcon icon={CreditCardIcon} size={32} strokeWidth={1.5} />
    </span>
    <div className="subscription-history-body">
      <h2 id="subscription-history-title">Intentos de cobro recientes</h2>
      <Table aria-labelledby="subscription-history-title">
        <TableHeader>
          <TableRow>
            {["Fecha", "Período", "Importe", "Estado"].map((label) => (
              <TableHead key={label} scope="col">
                {label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {attempts.map((attempt) => (
            <TableRow key={attempt.id}>
              <TableCell>
                <time dateTime={DateTime.formatIso(attempt.createdAt)}>
                  {attemptDateFormatter.format(attempt.createdAt.epochMilliseconds)}
                </time>
              </TableCell>
              <TableCell>{periodLabels[attempt.billingPeriod]}</TableCell>
              <TableCell>{formatMoney({ locale: "es-CO", money: attempt.money })}</TableCell>
              <TableCell>
                <span className="subscription-attempt-status" data-status={attempt.status}>
                  {attemptLabels[attempt.status]}
                </span>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="subscription-muted">
        Tu historial permanece disponible aunque termine el acceso Pro.
      </p>
    </div>
  </section>
);

export const SubscriptionStandingView = ({
  state,
  onRetry,
}: Readonly<{ state: StandingViewState; onRetry: () => void }>): JSX.Element => {
  if (state._tag === "Initial") return <Skeleton className="h-24 w-full" />;
  if (state._tag === "Failure") {
    return (
      <PaymentFeedback tone="unavailable" title="Estado no disponible">
        <p>No pudimos consultar tu suscripción. Tus datos siguen disponibles.</p>
        <Button type="button" variant="outline" onClick={onRetry}>
          Reintentar
        </Button>
      </PaymentFeedback>
    );
  }
  return <ReadyStanding standing={state.standing} onRetry={onRetry} />;
};

const ReadyStanding = ({
  standing,
  onRetry,
}: Readonly<{ standing: SubscriptionStatus; onRetry: () => void }>): JSX.Element => {
  const { accessTier, trialPeriod, paidSubscription, recentAttempts } = standing;
  return (
    <>
      <section className="subscription-standing" aria-label="Estado de la suscripción">
        <span
          className={`subscription-status-icon${accessTier === "pro" ? "" : " subscription-status-success"}`}
          aria-hidden="true"
        >
          <HugeiconsIcon
            icon={accessTier === "pro" ? CrownIcon : Tick02Icon}
            size={32}
            strokeWidth={1.5}
          />
        </span>
        <div className="subscription-standing-copy">
          <h2>
            Tu acceso:{" "}
            {accessTier === "pro" ? (
              <span className="subscription-pro-status">Pro</span>
            ) : (
              <span>Gratis</span>
            )}
          </h2>
          {Option.match(paidSubscription, {
            onNone: () =>
              accessTier === "pro" ? (
                <p>
                  Período de prueba: hasta el{" "}
                  {standingDateFormatter.format(trialPeriod.endsAt.epochMilliseconds)}.
                </p>
              ) : (
                <p>Tu historial sigue disponible.</p>
              ),
            onSome: (paid) => (
              <>
                <p>
                  Último período pagado: hasta el{" "}
                  {standingDateFormatter.format(paid.endsAt.epochMilliseconds)}.
                </p>
                <p>Precio cobrado: {formatMoney({ locale: "es-CO", money: paid.money })}.</p>
              </>
            ),
          })}
        </div>
        <div className="subscription-refresh">
          <Button type="button" variant="outline" onClick={onRetry}>
            <HugeiconsIcon icon={Refresh04Icon} size={24} aria-hidden="true" />
            Actualizar estado
          </Button>
        </div>
      </section>
      {recentAttempts.length > 0 ? <RecentAttempts attempts={recentAttempts} /> : null}
    </>
  );
};
