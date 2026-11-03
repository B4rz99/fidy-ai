import { Button } from "@/ui/components/button";
import type { JSX } from "react";
import { preservedDates, preservesOccurrence, restoredDates } from "./edit-scope";
import { type Occurrence, type Workspace, money } from "./model";

export const EditScope = ({
  item,
  document,
  scope,
  id,
  reviewTracking,
}: Readonly<{
  item: Occurrence;
  document: Workspace["document"];
  scope: "once" | "forward";
  id: string;
  reviewTracking: () => void;
}>): JSX.Element => {
  const dates = preservedDates({ document, planId: item.planId, from: item.date });
  const restored = restoredDates({ document, planId: item.planId, from: item.date });
  return (
    <section aria-label="Alcance del cambio" className="my-4 grid gap-2 text-sm" aria-live="polite">
      {scope === "once" ? (
        <OnceScope id={id} tracked={item.fulfillments.length > 0} reviewTracking={reviewTracking} />
      ) : (
        <div id={id} className="grid gap-2">
          <p>
            El plan se actualizará desde {item.date}. Las fechas sin ajustes individuales ni
            seguimiento usarán los nuevos datos. Las fechas omitidas seguirán omitidas.
          </p>
          <SelectedScope item={item} document={document} />
          {restored.length > 0 ? (
            <p>
              Las fechas que volviste a incluir sin ajustes individuales seguirán el nuevo plan,
              aunque tengan seguimiento: {restored.join(", ")}. Los importes reales registrados no
              cambian.
            </p>
          ) : null}
          <p>
            Al guardar también pueden conservarse fechas con pagos o ingresos detectados
            automáticamente, aunque no aparezcan en esta lista.
          </p>
          {dates.length > 0 ? (
            <p>
              Ajustes, seguimiento y omisiones ya registrados que se conservan: {dates.join(", ")}.
              Los cambios no modifican transacciones.
            </p>
          ) : (
            <p>Los cambios no modifican transacciones.</p>
          )}
        </div>
      )}
    </section>
  );
};

const SelectedScope = ({
  item,
  document,
}: Readonly<{ item: Occurrence; document: Workspace["document"] }>): JSX.Element => {
  if (item.status === "skipped") {
    return <p>Esta fecha seguirá omitida. Para incluirla, usa Volver a incluir.</p>;
  }
  if (!preservesOccurrence({ document, item })) return <UnprotectedScope item={item} />;
  const adjusted = document.exceptions.some(
    (entry) =>
      entry.planId === item.planId && entry.date === item.date && entry.replacement !== undefined
  );
  const tracked = item.fulfillments.length > 0;
  const expectation =
    item.plan.money === undefined ? "un importe por confirmar" : money(item.plan.money);
  return (
    <p>
      Esta fecha conserva {expectation}
      {adjusted ? " por su ajuste individual" : " por su seguimiento registrado"}.
      {tracked ? " Tiene seguimiento registrado." : ""} Para corregir solo esta fecha, elige Solo
      esta vez{tracked ? " y revisa primero los registros vinculados" : ""}.
    </p>
  );
};

const UnprotectedScope = ({ item }: Readonly<{ item: Occurrence }>): JSX.Element => {
  if (item.fulfillments.length > 0) {
    return (
      <p>
        Esta fecha se volvió a incluir sin un ajuste individual. Su expectativa actual es{" "}
        {item.plan.money === undefined ? "por confirmar" : money(item.plan.money)} y seguirá el
        nuevo plan, aunque tenga seguimiento. Los importes reales registrados no cambian.
      </p>
    );
  }
  return (
    <p>
      Esta fecha no tiene ajustes ni seguimiento protegidos. Su expectativa seguirá el calendario
      que guardes; si cambias las fechas, puede dejar de generarse.
    </p>
  );
};

const OnceScope = ({
  id,
  tracked,
  reviewTracking,
}: Readonly<{ id: string; tracked: boolean; reviewTracking: () => void }>): JSX.Element => (
  <>
    <p id={id}>
      {tracked
        ? "Esta fecha ya tiene seguimiento registrado y no se puede editar solo esta vez. Revisa las transacciones vinculadas y las marcas manuales. Si el seguimiento es incorrecto, usa Desvincular transacción en los vínculos y Revertir en las marcas manuales de esta fecha antes de editarla. Esto solo retira el seguimiento: no elimina transacciones ni revierte pagos reales."
        : "Los cambios se aplican solo a esta fecha. Las próximas fechas conservan sus datos."}
    </p>
    {tracked ? (
      <Button variant="outline" onClick={reviewTracking}>
        Revisar seguimiento
      </Button>
    ) : null}
  </>
);
