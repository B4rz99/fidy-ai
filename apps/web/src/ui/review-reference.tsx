import { type JSX, useState } from "react";
import { Button } from "@/ui/components/button";
import { CalendarField } from "@/ui/components/calendar-field";
import {
  ReviewDraftFooter,
  ReviewFullState,
  ReviewNotice,
  ReviewWorkspaceLayout,
} from "@/ui/components/review-workspace";

export const ReviewReference = (): JSX.Element => {
  const [date, setDate] = useState("2026-10-24");
  return (
    <section id="review" className="scroll-mt-6">
      <h2 className="mb-4 text-xl font-semibold">Revisión de ingesta</h2>
      <ReviewWorkspaceLayout>
        <ReviewNotice text="Confirma la moneda de esta transacción." error={false}>
          {null}
        </ReviewNotice>
        <div data-review="fields" className="my-4 max-w-sm">
          <CalendarField
            id="reference-review-date"
            label="Fecha del movimiento"
            value={date}
            timeZone="America/Bogota"
            disabled={false}
            required
            appearance="review"
            onChange={setDate}
          />
        </div>
        <ReviewFullState
          state="empty"
          title="Todo al día"
          description="Cuando haya material por completar, aparecerá aquí."
        >
          {null}
        </ReviewFullState>
        <ReviewDraftFooter
          feedback={<span>Borrador guardado</span>}
          actions={
            <>
              <Button variant="ghost">Omitir</Button>
              <Button>Confirmar</Button>
            </>
          }
        />
      </ReviewWorkspaceLayout>
    </section>
  );
};
