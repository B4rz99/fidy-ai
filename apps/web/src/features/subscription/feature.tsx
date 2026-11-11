import { PendingRead } from "@/ui/components/pending-read";
import { SubscriptionCancellationManagement } from "./cancellation";
import { makeCancellationCommand, subscriptionStatusQuery } from "./cancellation-command";
import { Button } from "@/ui/components/button";
import { Alert, AlertDescription, AlertTitle } from "@/ui/components/alert";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { lazyRouteComponent, useRouter } from "@tanstack/react-router";
import { Array as EffectArray, Option } from "effect";
import { Atom } from "effect/reactivity";
import { type EnrollmentInteraction, makeEnrollmentInteraction } from "./interaction";
import { SubscriptionConsentBoundary } from "./consent-boundary";
import { DaviplataAuthorizationLock } from "./daviplata-activity";
import { type JSX, type RefCallback, Suspense, useState } from "react";
import { useSession } from "@/session/session-context";
import { useSubscriptionEnrollmentClient } from "@/session/subscription-enrollment-context";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { type FidyClient } from "@/transport/client";
import { CanonicalQueryRetry } from "@/ui/canonical-query-feedback";
import {
  type SubscriptionOfferPresentation,
  type SubscriptionOffers,
  paymentMethodCopy,
  presentSubscriptionOffer,
} from "./presentation";
import { type EnrollmentGateway, makeEnrollmentGateway } from "./enrollment-gateway";
import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  OfferSelection,
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

const PaymentDetails = lazyRouteComponent(() => import("./payment-details"), "PaymentDetails");
type SubscriptionStandingPresentation = Readonly<{
  state: StandingViewState;
  refresh: () => void;
  management: JSX.Element;
}>;
const hasNonTrialPro = (state: StandingViewState): boolean =>
  state._tag === "Ready" &&
  state.standing.accessTier === "pro" &&
  (state.standing.hasProGrant || Option.isSome(state.standing.paidSubscription));
const showBillingManagement = (state: StandingViewState): boolean =>
  state._tag !== "Ready" ||
  !state.standing.hasProGrant ||
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
  const [atom] = useState(() =>
    makeEnrollmentInteraction({
      offers,
      gateway,
      authorizationLock,
    })
  );
  const interaction = useAtomValue(atom);
  const presented = offers.map(presentSubscriptionOffer);
  const selectedOffer = Option.orElse(
    Option.map(interaction.checkoutPrice, presentSubscriptionOffer),
    () =>
      Option.flatMap(interaction.selectedId, (id) =>
        EffectArray.findFirst(presented, (offer) => offer.id === id)
      )
  );
  const currentSelection = offers.some((offer) =>
    Option.contains(interaction.selectedId, offer.id)
  );
  const act = (action: () => void): void => {
    interaction.updateOffers(offers);
    action();
  };
  return {
    ...interaction,
    canContinue:
      !interaction.disabled &&
      currentSelection &&
      interaction.enabledMethods.includes(interaction.method),
    selectPrice: (id) => act(() => interaction.selectPrice(id)),
    selectMethod: (method) => act(() => interaction.selectMethod(method)),
    continueToPayment: () => act(interaction.continueToPayment),
    prepare: (replacing) => act(() => interaction.prepare(replacing)),
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
          <PendingRead label="Consultando métodos de pago" />
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
        <Suspense fallback={<PendingRead label="Cargando formulario" />}>
          <PaymentDetails
            key={`${selection.method}:${offer.id}`}
            gateway={gateway}
            offer={offer}
            method={selection.method}
            enrollment={selection.enrollment}
            busy={selection.busy}
            failed={selection.failed}
            needsRecovery={selection.needsRecovery}
            awaitingObservation={selection.awaitingObservation}
            prepare={selection.prepare}
            submit={selection.submit}
            refresh={selection.refresh}
            onDaviplataSubmitted={selection.submittedDaviplata}
            onDaviplataUncertain={selection.uncertainDaviplata}
          />
        </Suspense>
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
  const paid = hasNonTrialPro(standing.state);
  const resolved = standing.state._tag === "Ready";
  const checkout = selection.checkout;
  return (
    <div
      ref={lifetimeRef}
      className="subscription-columns"
      data-checkout={checkout}
      data-method={selection.method}
      data-paid={paid}
    >
      <div className="subscription-main">
        {checkout ? (
          <Checkout selection={selection} gateway={props.gateway} />
        ) : (
          <>
            <SubscriptionStandingView state={standing.state} onRetry={standing.refresh} />
            {showBillingManagement(standing.state) && standing.management}
            {resolved && !paid && (
              <OfferOverview
                selection={selection}
                terms={presentSubscriptionOffer(props.offers[0])}
              />
            )}
          </>
        )}
      </div>
      {resolved && (
        <SubscriptionSummary
          offer={selection.selectedOffer}
          checkout={checkout}
          paid={paid}
          granted={standing.state.standing.hasProGrant}
        />
      )}
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
const OffersRefreshFeedback = ({
  state,
}: Readonly<{ state: SubscriptionOffersPageState }>): JSX.Element => (
  <>
    {state._tag === "Refreshing" ? (
      <p aria-live="polite" className="sr-only">
        Actualizando ofertas…
      </p>
    ) : null}
    {state._tag === "RefreshFailure" ? (
      <CanonicalQueryRetry
        description="Mostramos las últimas ofertas disponibles."
        onRetry={state.onRetry}
        retryLabel="Reintentar actualización"
        retryingLabel="Reintentando…"
        title="No pudimos actualizar las ofertas"
        waiting={state.waiting}
      />
    ) : null}
  </>
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
      return <PendingRead label="Cargando ofertas" />;
    case "Ready":
    case "Refreshing":
    case "RefreshFailure":
      return (
        <>
          <OffersRefreshFeedback state={state} />
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
  <div className="subscription-columns" data-paid={hasNonTrialPro(standing.state)}>
    <div className="subscription-main">
      <SubscriptionStandingView state={standing.state} onRetry={standing.refresh} />
      {showBillingManagement(standing.state) && standing.management}
      <div className="subscription-offers-feedback">{children}</div>
    </div>
    {standing.state._tag === "Ready" && (
      <SubscriptionSummary
        paid={hasNonTrialPro(standing.state)}
        granted={standing.state.standing.hasProGrant}
        offer={Option.none()}
        checkout={false}
      />
    )}
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
const useSubscriptionStanding = (): SubscriptionStandingPresentation => {
  const router = useRouter();
  const client = router.options.context.apiClient;
  const [cancellation] = useState(() => client.pipe(makeCancellationCommand));
  const query = subscriptionStatusQuery(client);
  const status = useAtomValue(query);
  const refresh = useAtomRefresh(query);
  const view = presentCanonicalQuery(status);
  return {
    state:
      view._tag === "Ready"
        ? {
            _tag: "Ready",
            standing: view.value.data,
          }
        : {
            _tag: view._tag,
          },
    refresh,
    management: <SubscriptionCancellationManagement client={client} command={cancellation} />,
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
  if (refreshFailure) {
    return {
      _tag: "RefreshFailure",
      offers,
      onRetry,
      waiting: refreshing,
    };
  }
  if (refreshing) {
    return {
      _tag: "Refreshing",
      offers,
    };
  }
  return {
    _tag: "Ready",
    offers,
  };
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
        state={{
          _tag: "AuthenticationRequired",
        }}
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
          state={{
            _tag: queryState.waiting ? "Loading" : "Initial",
          }}
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

SubscriptionOffersFeature.preloadInteractions = (): Promise<void> =>
  Promise.resolve(PaymentDetails.preload?.()).then(() => undefined);
