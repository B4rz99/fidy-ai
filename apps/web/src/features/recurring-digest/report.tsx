import type { JSX, ReactNode } from "react";
import { makeCompactDateFormatter } from "@/ui/compact-date";
import { Calendar03Icon, InformationCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { RecurringDigestReport } from "@/transport/client";
import { formatMoney } from "@/transport/money";
import { Alert, AlertDescription } from "@/ui/components/alert";
import "./report.css";

export const HistoricalReport = ({
  report,
  recovery,
}: Readonly<{ report: RecurringDigestReport; recovery: ReactNode }>): JSX.Element => {
  const day = report.payload.confirmationDay;
  const date = makeCompactDateFormatter(report.locale)(day.localDate);
  return (
    <div className="recurring-report-columns">
      <div className="recurring-report-main">
        <section className="recurring-report-heading" aria-labelledby="historical-patterns">
          <span className="settings-section-icon" aria-hidden="true">
            <HugeiconsIcon icon={Calendar03Icon} size={26} />
          </span>
          <div>
            <h2 id="historical-patterns" className="settings-section-title">
              Patrones históricos
            </h2>
            <p className="recurring-report-desktop-description">
              Todos los patrones confirmados en este informe.
            </p>
            <p className="recurring-report-mobile-date">
              Confirmados el <time dateTime={day.localDate}>{date}</time>
            </p>
          </div>
        </section>
        <div className="recurring-report-items">
          {recovery}
          <div className="recurring-report-labels" aria-hidden="true">
            <span>Comercio</span>
            <span>Frecuencia</span>
            <span>Importe</span>
          </div>
          <HistoricalItems report={report} />
        </div>
      </div>
      <ReportContext report={report} date={date} />
    </div>
  );
};

const HistoricalItems = ({ report }: Readonly<{ report: RecurringDigestReport }>): JSX.Element => (
  <ul aria-label="Todos los patrones confirmados">
    {report.payload.items.map((item) => (
      <li key={item.confirmationId}>
        <span className="recurring-report-counterparty">{item.counterparty}</span>
        <span className="recurring-report-cadence">Mensual</span>
        <span className="recurring-report-money">
          {formatMoney({ locale: report.locale, money: item.money })} {item.money.currency}
        </span>
      </li>
    ))}
  </ul>
);

const ReportContext = ({
  report,
  date,
}: Readonly<{ report: RecurringDigestReport; date: string }>): JSX.Element => (
  <aside className="recurring-report-context" aria-label="Sobre este informe">
    <div className="recurring-report-metadata">
      <h2>Sobre este informe</h2>
      <Alert variant="information" role="note" className="px-3 py-3">
        <HugeiconsIcon icon={InformationCircleIcon} className="size-6" aria-hidden="true" />
        <AlertDescription>Estos patrones no indican que los cargos sigan activos.</AlertDescription>
      </Alert>
      <dl>
        <div className="recurring-report-day">
          <dt>Día de confirmación</dt>
          <dd>
            <time dateTime={report.payload.confirmationDay.localDate}>{date}</time>
          </dd>
        </div>
        <div>
          <dt>Zona horaria</dt>
          <dd>{report.payload.confirmationDay.timeZone}</dd>
        </div>
      </dl>
    </div>
    <p className="recurring-report-footer">
      El informe conserva los datos registrados cuando se confirmaron estos patrones.
    </p>
  </aside>
);
