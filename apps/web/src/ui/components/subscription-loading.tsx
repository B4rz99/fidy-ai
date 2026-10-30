import type { JSX } from "react";
import { LoadingRegion } from "./loading-skeletons";
import { Skeleton } from "./skeleton";
import "./subscription.css";

export const SubscriptionStandingSkeleton = (): JSX.Element => (
  <LoadingRegion label="Cargando suscripción">
    <div className="subscription-standing">
      <Skeleton className="size-[58px] rounded-full" />
      <div className="subscription-standing-copy grid gap-2">
        <Skeleton className="h-[30px] w-40" />
        <Skeleton className="h-[26px] w-full" />
      </div>
      <Skeleton className="h-11 w-28" />
    </div>
  </LoadingRegion>
);
export const PaymentMethodsSkeleton = (): JSX.Element => (
  <LoadingRegion label="Consultando métodos de pago">
    <div className="subscription-methods">
      {[0, 1, 2].map((method) => (
        <Skeleton key={method} className="h-[62px] w-36 max-w-full" />
      ))}
    </div>
  </LoadingRegion>
);
const PaymentField = (): JSX.Element => (
  <div className="subscription-field">
    <Skeleton className="h-6 w-32" />
    <Skeleton className="h-[52px] w-full" />
  </div>
);
export const PaymentFormSkeleton = ({
  method,
}: Readonly<{ method: "card" | "nequi" | "daviplata" }>): JSX.Element => (
  <LoadingRegion label="Cargando formulario">
    <div className="subscription-form">
      <PaymentField />
      {method === "card" ? (
        <>
          <PaymentField />
          <div className="subscription-card-fields">
            <PaymentField />
            <PaymentField />
            <PaymentField />
          </div>
        </>
      ) : (
        <>
          <PaymentField />
          {method === "daviplata" ? (
            <div className="subscription-document-fields">
              <PaymentField />
              <PaymentField />
            </div>
          ) : null}
        </>
      )}
      <div className="subscription-consents">
        {[0, 1].map((consent) => (
          <div key={consent} className="subscription-consent">
            <Skeleton className="size-5 shrink-0" />
            <Skeleton className="h-12 w-full" />
          </div>
        ))}
      </div>
      <div className="subscription-form-actions">
        <Skeleton className="h-[52px] w-full" />
      </div>
    </div>
  </LoadingRegion>
);
export const OffersSkeleton = (): JSX.Element => (
  <LoadingRegion label="Cargando ofertas">
    <div className="subscription-columns" data-checkout="false" data-paid="false">
      <div className="subscription-main">
        <SubscriptionStandingSkeleton />
        <section className="subscription-period-section">
          <h2>
            <Skeleton className="h-[35px] w-52" />
          </h2>
          <div className="subscription-offers">
            {[0, 1, 2].map((offer) => (
              <div key={offer} className="subscription-offer">
                <div data-slot="button">
                  <span className="subscription-offer-label">
                    <Skeleton className="size-[26px] shrink-0 rounded-full" />
                    <Skeleton className="h-6 w-20" />
                  </span>
                  <Skeleton className="subscription-offer-price h-9 w-32" />
                  <Skeleton className="subscription-offer-period h-5 w-28" />
                </div>
              </div>
            ))}
          </div>
        </section>
        <div className="subscription-terms">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="mt-2 h-5 w-4/5" />
        </div>
        <section className="subscription-method-section">
          <h2>
            <Skeleton className="h-[35px] w-56" />
          </h2>
          <PaymentMethodsSkeleton />
          <Skeleton className="h-5 w-3/4" />
        </section>
        <div className="subscription-continue">
          <Skeleton className="h-[52px] w-full max-w-[350px]" />
        </div>
      </div>
      <aside className="subscription-summary" data-checkout="false">
        <Skeleton className="size-8" />
        <Skeleton className="mt-6 h-9 w-44" />
        <div className="mt-3 grid gap-2">
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-3/4" />
        </div>
      </aside>
    </div>
  </LoadingRegion>
);
