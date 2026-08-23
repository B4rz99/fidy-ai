import { useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Array as EffectArray, Option } from "effect";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { type JSX, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/ui/components/alert";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/ui/components/card";
import type { FidyClient } from "@/transport/client";
import { Skeleton } from "@/ui/components/skeleton";
import {
  type PriceRevisionId,
  type SubscriptionOfferPresentation,
  type SubscriptionOffers,
  presentSubscriptionOffer,
} from "./presentation";

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
  select: (id: PriceRevisionId) => void;
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

const PaymentMethods = ({
  offer,
}: Readonly<{ offer: SubscriptionOfferPresentation }>): JSX.Element => (
  <section aria-label="Métodos de pago">
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Métodos de pago para la inscripción</h2>
        </CardTitle>
        <CardDescription>
          Elegiste la oferta {offer.selectionLabel}. La selección todavía no genera ningún cobro.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        {offer.paymentMethodLabels.map((method) => (
          <Badge key={method} variant="outline">
            {method}
          </Badge>
        ))}
      </CardContent>
      <CardFooter>
        <p className="text-sm text-muted-foreground">
          El ingreso de un método de pago pertenece al siguiente paso de inscripción.
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

const ReadyOffers = ({ offers }: Readonly<{ offers: SubscriptionOffers }>): JSX.Element => {
  const [selectedId, setSelectedId] = useState<Option.Option<PriceRevisionId>>(Option.none);
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
            select={(id) => setSelectedId(Option.some(id))}
          />
        ))}
      </section>
      {Option.match(selectedOffer, {
        onNone: () => null,
        onSome: (offer) => <PaymentMethods offer={offer} />,
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
}: Readonly<{ state: SubscriptionOffersPageState }>): JSX.Element => {
  switch (state._tag) {
    case "Loading":
      return <LoadingOffers />;
    case "Ready":
      return <ReadyOffers offers={state.offers} />;
    case "LoadFailure":
      return <LoadFailure />;
  }
};

/** Renders Subscription offers and retains selection only in browser memory. */
export const SubscriptionOffersView = ({
  state,
}: Readonly<{ state: SubscriptionOffersPageState }>): JSX.Element => (
  <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
    <header className="flex max-w-3xl flex-col gap-2">
      <Badge variant="secondary">Fidy Pro</Badge>
      <h1 className="font-heading text-3xl font-semibold tracking-tight">Mejora tu suscripción</h1>
    </header>
    <SubscriptionOffersContent state={state} />
  </main>
);

const subscriptionOffersQuery = Atom.family((client: FidyClient) =>
  client.query("subscription", "listSubscriptionOffers", {})
);

/** Authenticated route that displays the current Subscription offers. */
export const SubscriptionOffersFeature = (): JSX.Element => {
  const router = useRouter();
  const offers = subscriptionOffersQuery(router.options.context.apiClient);
  const result = useAtomValue(offers);
  if (AsyncResult.isFailure(result)) {
    return <SubscriptionOffersView state={{ _tag: "LoadFailure" }} />;
  }
  return AsyncResult.isSuccess(result) ? (
    <SubscriptionOffersView state={{ _tag: "Ready", offers: result.value.data }} />
  ) : (
    <SubscriptionOffersView state={{ _tag: "Loading" }} />
  );
};
