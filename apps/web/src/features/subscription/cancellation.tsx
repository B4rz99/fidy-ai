import { PendingRead } from "@/ui/components/pending-read";
import { useAtomValue } from "@effect/atom-react";
import { DateTime, Option } from "effect";
import { type JSX, type RefCallback, useCallback } from "react";
import type { SubscriptionStatus } from "@/transport/client";
import { Button } from "@/ui/components/button";

import { PaymentFeedback } from "./workspace";

import {
  type Cancellation,
  type CancellationManagement,
  type makeCancellationManagement,
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
const CancellationResult = ({
  value,
  focus,
}: Readonly<{ value: Cancellation; focus: boolean }>): JSX.Element => (
  <PaymentFeedback
    tone={value.sourceCancellation === "void-pending" ? "pending" : "success"}
    title="Renovaciones canceladas"
  >
    <output aria-live="polite" tabIndex={-1} ref={focus ? focusElement : undefined}>
      No habrá nuevas renovaciones de esta suscripción.
    </output>
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
const focusElement: RefCallback<HTMLElement> = (node) => {
  node?.focus();
};
const CancellationReview = ({
  paid,
  busy,
  cancelling,
  confirm,
  back,
}: Readonly<{
  paid: Option.Option.Value<SubscriptionStatus["paidSubscription"]>;
  busy: boolean;
  cancelling: boolean;
  confirm: () => void;
  back: () => void;
}>): JSX.Element => (
  <section aria-label="Revisar cancelación" className="flex flex-col gap-3">
    <h2 ref={focusElement} tabIndex={-1}>
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
      <Button contentLayout="wrap" type="button" variant="outline" disabled={busy} onClick={back}>
        Conservar renovaciones
      </Button>
      <Button
        contentLayout="wrap"
        type="button"
        variant="destructive"
        disabled={busy}
        onClick={confirm}
      >
        Confirmar cancelación
      </Button>
    </div>
    {busy ? (
      <output aria-live="polite" tabIndex={-1} ref={cancelling ? focusElement : undefined}>
        {cancelling ? "Cancelando renovaciones…" : "Actualizando estado…"}
      </output>
    ) : null}
  </section>
);

type CancellationCommand = ReturnType<typeof makeCancellationManagement>;
const CancellationActions = ({
  current,
  reviewing,
  restoreFocus,
  review,
  back,
}: Readonly<{
  current: CancellationManagement;
  reviewing: boolean;
  restoreFocus: boolean;
  review: () => void;
  back: () => void;
}>): JSX.Element => {
  if (current.unavailable && !current.cancelling) {
    return (
      <PaymentFeedback tone="unavailable" title="Renovaciones no disponibles">
        <p>
          No podemos verificar las renovaciones en este momento. Actualiza el estado para continuar.
        </p>
      </PaymentFeedback>
    );
  }
  return Option.match(current.paid, {
    onNone: () => <p>No tienes una suscripción pagada con renovaciones para cancelar.</p>,
    onSome: (paid) =>
      reviewing && !current.uncertain ? (
        <CancellationReview
          paid={paid}
          busy={current.busy}
          cancelling={current.cancelling}
          back={back}
          confirm={current.confirm}
        />
      ) : (
        <Button
          contentLayout="wrap"
          ref={restoreFocus ? focusElement : undefined}
          type="button"
          variant="destructive"
          disabled={current.busy || current.uncertain}
          onClick={review}
        >
          Cancelar renovaciones futuras
        </Button>
      ),
  });
};

const UncertainCancellation = (): JSX.Element => (
  <PaymentFeedback tone="uncertain" title="Cancelación sin verificar">
    <p role="alert" tabIndex={-1} ref={focusElement}>
      No pudimos confirmar el resultado más reciente. Consulta el estado antes de volver a solicitar
      la cancelación. Cualquier resultado mostrado corresponde a la última confirmación disponible.
    </p>
  </PaymentFeedback>
);

export const SubscriptionCancellationManagement = ({
  command,
}: Readonly<{ command: CancellationCommand }>): JSX.Element => {
  const current = useAtomValue(command);
  const mount = current.mount;
  const mounted = useCallback(() => mount(), [mount]);
  const reviewing = current.reviewing;
  const restoreFocus = current.restoreFocus;
  if (current.loading) {
    return (
      <section ref={mounted} aria-label="Renovaciones de la suscripción" className="py-5">
        <PendingRead label="Cargando renovaciones" />
      </section>
    );
  }
  return (
    <section
      ref={mounted}
      aria-label="Renovaciones de la suscripción"
      className="flex flex-col gap-4 py-5"
    >
      {Option.isSome(current.cancellation) ? (
        <CancellationResult
          value={current.cancellation.value}
          focus={current.interacted && !current.uncertain}
        />
      ) : (
        <CancellationActions
          current={current}
          reviewing={reviewing}
          restoreFocus={restoreFocus}
          review={current.review}
          back={current.back}
        />
      )}
      {current.uncertain ? <UncertainCancellation /> : null}
      <div>
        <Button
          contentLayout="wrap"
          type="button"
          variant="outline"
          disabled={current.busy}
          onClick={current.refresh}
        >
          Consultar cancelación
        </Button>
      </div>
    </section>
  );
};
