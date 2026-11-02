import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/ui/components/button";
import { FidyWordmark } from "@/ui/components/wordmark";
import { useTheme } from "./theme";
import "@/ui/components/connection-recovery.css";

export const ConnectionRecovery = ({
  destination,
}: Readonly<{ destination: "/login" | "/app/transactions" }>): JSX.Element => {
  const { mounted } = useTheme();
  return (
    <div ref={mounted} className="connection-recovery">
      <header className="connection-recovery-header">
        <FidyWordmark />
        <span>Conexión con tu banco</span>
      </header>
      <main className="connection-recovery-content">
        <div className="connection-recovery-layout">
          <section
            className="connection-recovery-message"
            aria-labelledby="connection-recovery-title"
          >
            <h1 id="connection-recovery-title">
              Este enlace no se
              <br />
              puede usar
            </h1>
            <p>
              El enlace de conexión está incompleto o no es válido. Necesitas uno nuevo para
              continuar.
            </p>
            <Button className="connection-recovery-return" render={<Link to={destination} />}>
              Volver a Fidy <span aria-hidden="true">→</span>
            </Button>
          </section>
          <aside
            className="connection-recovery-guide"
            aria-labelledby="connection-recovery-guide-title"
          >
            <h2 id="connection-recovery-guide-title">Cómo continuar</h2>
            <ol>
              <li>
                <strong>Vuelve a tu conversación con Fidy.</strong>
                <br />
                Busca donde solicitaste conectar tu banco.
              </li>
              <li>
                <strong>Pide un nuevo enlace de conexión.</strong>
                <br />
                Abre el enlace completo cuando lo recibas.
              </li>
            </ol>
          </aside>
        </div>
      </main>
    </div>
  );
};
