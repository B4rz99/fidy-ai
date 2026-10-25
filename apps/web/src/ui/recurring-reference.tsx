import { type JSX, useState } from "react";
import { Button } from "@/ui/components/button";
import {
  RecurringColumns,
  RecurringContextPanel,
  RecurringSurface,
  RecurringThemeControl,
} from "@/ui/components/recurring";
import "@/ui/components/application.css";

export const RecurringReference = ({
  dark,
  toggleTheme,
}: Readonly<{ dark: boolean; toggleTheme: () => void }>): JSX.Element => {
  const [open, setOpen] = useState(false);
  return (
    <section
      aria-label="Composición aprobada de recurrentes"
      className="application-shell signed-in-theme"
    >
      <RecurringSurface>
        <header data-recurring-slot="page-header">
          <h1>Recurrentes</h1>
          <Button onClick={() => setOpen(true)}>Nuevo recurrente</Button>
          <nav data-recurring-slot="tabs" aria-label="Ejemplo de vistas de recurrentes">
            <Button aria-pressed>Mensual</Button>
            <Button>Todos los recurrentes</Button>
          </nav>
        </header>
        <RecurringColumns
          open={open}
          panel={
            <RecurringContextPanel
              themeControl={
                <RecurringThemeControl theme={dark ? "dark" : "light"} toggle={toggleTheme} />
              }
              title="Nuevo recurrente"
              open={open}
              onClose={() => setOpen(false)}
            >
              <p>Panel contextual de ejemplo. No crea un plan ni mueve dinero.</p>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancelar
              </Button>
            </RecurringContextPanel>
          }
        >
          <div data-recurring-slot="content">
            <h2>Octubre de 2026</h2>
            <section
              data-recurring-slot="occurrence-group"
              aria-label="Ejemplo de próximos movimientos"
            >
              <h3>Próximos</h3>
              <p>Arriendo · 31 oct · COP 1.000.000</p>
            </section>
          </div>
        </RecurringColumns>
      </RecurringSurface>
    </section>
  );
};
