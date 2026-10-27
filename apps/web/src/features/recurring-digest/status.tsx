import type { JSX, ReactNode } from "react";
import { Alert02Icon, Clock01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@/ui/components/button";
import { Alert, AlertDescription } from "@/ui/components/alert";

type RetryProps = Readonly<{ onRetry: () => void; waiting: boolean }>;

const ReportProblem = ({
  title,
  children,
  kind,
}: Readonly<{
  title: string;
  children: ReactNode;
  kind: "invalid" | "unavailable";
}>): JSX.Element => (
  <section className="recurring-report-problem" role="alert" data-kind={kind}>
    <span className="recurring-report-state-icon" aria-hidden="true">
      <HugeiconsIcon icon={Alert02Icon} size={24} />
    </span>
    <div>
      <h2>{title}</h2>
      {children}
    </div>
  </section>
);

export const InvalidReport = (): JSX.Element => (
  <ReportProblem title="Enlace no válido" kind="invalid">
    <p>Abre el enlace original del informe que recibiste de Fidy.</p>
  </ReportProblem>
);

export const UnavailableReport = ({ onRetry, waiting }: RetryProps): JSX.Element => (
  <ReportProblem title="Informe no disponible" kind="unavailable">
    <p>
      No pudimos consultar este informe. Comprueba que abriste el enlace original con la cuenta que
      lo recibió.
    </p>
    <Button onClick={onRetry} disabled={waiting} type="button">
      {waiting ? "Reintentando…" : "Reintentar"}
    </Button>
  </ReportProblem>
);

export const ReportRefreshFailure = ({ onRetry, waiting }: RetryProps): JSX.Element => (
  <div className="recurring-report-refresh">
    <Alert variant="warning">
      <HugeiconsIcon icon={Alert02Icon} className="size-6" aria-hidden="true" />
      <AlertDescription>
        No pudimos actualizar el informe. La información anterior sigue visible.
      </AlertDescription>
    </Alert>
    <Button onClick={onRetry} disabled={waiting} type="button" variant="outline">
      {waiting ? "Reintentando…" : "Reintentar"}
    </Button>
  </div>
);

export const ReportLoading = (): JSX.Element => (
  <div className="recurring-report-loading">
    <output>
      <span className="recurring-report-state-icon" aria-hidden="true">
        <HugeiconsIcon icon={Clock01Icon} size={24} />
      </span>
      Cargando informe…
    </output>
    <div className="recurring-report-skeleton" aria-hidden="true">
      <span />
      <span />
      <span />
      <span />
    </div>
  </div>
);
