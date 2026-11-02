import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { DateTime, Option } from "effect";
import { type JSX, type RefCallback, useState } from "react";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import type { FidyClient, SubscriptionStatus } from "@/transport/client";
import { Button } from "@/ui/components/button";
import { PaymentFeedback } from "./workspace";

import {
  type Cancellation,
  type makeCancellationCommand,
  subscriptionStatusQuery,
} from "./cancellation-command";

const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  dateStyle: "long",
  timeZone: "America/Bogota",
});
const sourceMessages: Readonly<Record<Cancellation["sourceCancellation"], string>> = {
  detached: "La fuente de pago reutilizable quedó desvinculada de los cobros de Fidy.",
  "void-pending":
    "Fidy detuvo las renovaciones. La anulación de la fuente de pago en Wompi sigue pendiente; consulta el estado para verificarla.",
  voided: "Wompi confirmó la anulación de la fuente de pago reutilizable.",
};
const CancellationResult = ({ value }: Readonly<{ value: Cancellation }>): JSX.Element => (
  <PaymentFeedback
    tone={value.sourceCancellation === "void-pending" ? "pending" : "success"}
    title="Renovaciones canceladas"
  >
    <output aria-live="polite">No habrá nuevas renovaciones de esta suscripción.</output>
    <p>
      Período pagado hasta el{" "}
      <time dateTime={DateTime.formatIso(value.paidThrough)}>
        {dateFormatter.format(value.paidThrough.epochMilliseconds)}
      </time>
      . La cancelación conserva ese acceso.
    </p>
    <p>{sourceMessages[value.sourceCancellation]}</p>
    <p>Tu historial de pagos permanece disponible.</p>
  </PaymentFeedback>
);
const focusReviewHeading: RefCallback<HTMLHeadingElement> = (node) => {
  node?.focus();
};
const CancellationReview = ({
  paid,
  busy,
  confirm,
  back,
}: Readonly<{
  paid: Option.Option.Value<SubscriptionStatus["paidSubscription"]>;
  busy: boolean;
  confirm: () => void;
  back: () => void;
}>): JSX.Element => (
  <section aria-label="Revisar cancelación" className="flex flex-col gap-3">
    <h2 ref={focusReviewHeading} tabIndex={-1}>
      ¿Cancelar renovaciones futuras?
    </h2>
    <p>
      Detendremos las próximas renovaciones. Conservarás el acceso del período pagado hasta el{" "}
      {dateFormatter.format(paid.endsAt.epochMilliseconds)}.
    </p>
    <p>
      Desvincularemos la fuente de pago reutilizable de los cobros de Fidy. Si requiere anulación en
      Wompi, te mostraremos si está pendiente o confirmada.
    </p>
    <p>
      Tu historial de pagos se conserva. Cancelar no solicita un reembolso ni revierte cobros ya
      iniciados.
    </p>
    <div className="flex flex-wrap gap-3">
      <Button type="button" variant="outline" disabled={busy} onClick={back}>
        Conservar renovaciones
      </Button>
      <Button type="button" variant="destructive-outline" disabled={busy} onClick={confirm}>
        {busy ? "Cancelando renovaciones…" : "Confirmar cancelación"}
      </Button>
    </div>
  </section>
);

type CancellationInteraction = Readonly<{
  cancellation: Option.Option<Cancellation>;
  paid: SubscriptionStatus["paidSubscription"];
  unavailable: boolean;
  uncertain: boolean;
  busy: boolean;
  dispatch: (action: "cancel" | "refresh") => void;
}>;
type CancellationCommand = ReturnType<typeof makeCancellationCommand>;
const useCancellation = (
  client: FidyClient,
  command: CancellationCommand
): CancellationInteraction => {
  const query = client.pipe(subscriptionStatusQuery);
  const initial = useAtomValue(query).pipe(presentCanonicalQuery);
  const result = useAtomValue(command);
  const observed = presentCanonicalQuery(result);
  const dispatch = useAtomSet(command);
  const initialStanding =
    initial._tag === "Ready" ? Option.some(initial.value.data) : Option.none<SubscriptionStatus>();
  const cancellation = Option.orElse(
    Option.flatMap(initialStanding, (value) => value.cancellation),
    () => (observed._tag === "Ready" ? observed.value : Option.none<Cancellation>())
  );
  const stale = initial._tag === "Ready" && Option.isSome(initial.refreshFailure);
  return {
    cancellation,
    paid: Option.flatMap(initialStanding, (value) => value.paidSubscription),
    unavailable: Option.isNone(initialStanding) || stale,
    uncertain: result._tag === "Failure",
    busy: result.waiting || initial.waiting,
    dispatch,
  };
};
const CancellationActions = ({
  current,
  reviewing,
  review,
  back,
}: Readonly<{
  current: CancellationInteraction;
  reviewing: boolean;
  review: () => void;
  back: () => void;
}>): JSX.Element => {
  if (current.unavailable) {
    return (
      <p>
        No podemos verificar las renovaciones en este momento. Actualiza el estado para continuar.
      </p>
    );
  }
  return Option.match(current.paid, {
    onNone: () => <p>No tienes una suscripción pagada con renovaciones para cancelar.</p>,
    onSome: (paid) =>
      reviewing && !current.uncertain ? (
        <CancellationReview
          paid={paid}
          busy={current.busy}
          back={back}
          confirm={() => current.dispatch("cancel")}
        />
      ) : (
        <Button
          type="button"
          variant="destructive-outline"
          disabled={current.busy || current.uncertain}
          onClick={review}
        >
          Cancelar renovaciones futuras
        </Button>
      ),
  });
};

export const SubscriptionCancellationManagement = ({
  client,
  command,
}: Readonly<{ client: FidyClient; command: CancellationCommand }>): JSX.Element => {
  const current = useCancellation(client, command);
  const [reviewing, setReviewing] = useState(false);
  return (
    <section aria-label="Renovaciones de la suscripción" className="flex flex-col gap-4 py-5">
      {Option.match(current.cancellation, {
        onSome: (value) => <CancellationResult value={value} />,
        onNone: () => (
          <CancellationActions
            current={current}
            reviewing={reviewing}
            review={() => setReviewing(true)}
            back={() => setReviewing(false)}
          />
        ),
      })}
      {current.uncertain ? (
        <p role="alert">
          No pudimos confirmar el resultado más reciente. Consulta el estado antes de volver a
          solicitar la cancelación. Cualquier resultado mostrado corresponde a la última
          confirmación disponible.
        </p>
      ) : null}
      <div>
        <Button
          type="button"
          variant="outline"
          disabled={current.busy}
          onClick={() => {
            setReviewing(false);
            current.dispatch("refresh");
          }}
        >
          Consultar cancelación
        </Button>
      </div>
    </section>
  );
};
