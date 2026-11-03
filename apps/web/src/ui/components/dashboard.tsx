import { Link } from "@tanstack/react-router";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  type ComponentProps,
  type JSX,
  type ReactNode,
  type RefCallback,
  createContext,
  useCallback,
  useContext,
  useState,
} from "react";
import { Option, Schema } from "effect";
import type { XAxisTickContentProps } from "recharts";
import { Button } from "./button";
import { ChartTooltip } from "./chart";
import { CategoryVisual } from "./category-visual";
import { DirectionIndicator } from "./icon-indicator";
import { Progress } from "./progress";
import "./dashboard.css";
import { dashboardCategoryVisual } from "./dashboard-category";

export const DashboardCard = ({
  title,
  children,
  editing,
  kind,
}: Readonly<{
  title: ReactNode;
  children: ReactNode;
  editing: boolean;
  kind: string;
}>): JSX.Element => (
  <section
    data-slot="card"
    className="dashboard-card"
    data-widget-type={kind}
    data-editing={editing || undefined}
  >
    <header className="dashboard-card-header">{title}</header>
    <div className="dashboard-card-content">{children}</div>
  </section>
);

export const DashboardCurrency = ({ children }: Readonly<{ children: ReactNode }>): JSX.Element => (
  <span className="dashboard-currency">{children}</span>
);
export const DashboardPeriod = ({ children }: Readonly<{ children: ReactNode }>): JSX.Element => (
  <p className="dashboard-period">{children}</p>
);

export const DashboardFigures = ({
  currency,
  inflow,
  outflow,
}: Readonly<{
  currency: string;
  inflow: string;
  outflow: string;
}>): JSX.Element => (
  <section className="dashboard-figures" aria-label={`Resumen ${currency}`}>
    <DashboardCurrency>{currency}</DashboardCurrency>
    <dl className="dashboard-figure-values">
      <div>
        <dt>Ingresos</dt>
        <dd>{inflow}</dd>
      </div>
      <div>
        <dt>Gastos</dt>
        <dd>{outflow}</dd>
      </div>
    </dl>
  </section>
);

export const DashboardBudget = ({
  currency,
  category,
  spent,
  cap,
  progress,
  utilization,
  status,
  over,
}: Readonly<{
  currency: string;
  category: string;
  spent: string;
  cap: string;
  progress: number;
  utilization: Option.Option<string>;
  status: string;
  over: boolean;
}>): JSX.Element => (
  <section className="dashboard-budget" aria-label={`${category} ${currency}`}>
    <DashboardCurrency>{currency}</DashboardCurrency>
    <div className="dashboard-budget-labels">
      <span>{category} · Gastado</span>
      <span>Presupuesto</span>
    </div>
    <div className="dashboard-budget-values">
      <strong>{spent}</strong>
      <span>{cap}</span>
    </div>
    <Progress
      value={progress}
      aria-label={`Presupuesto de ${category}`}
      data-over={over || undefined}
    />
    <div className="dashboard-budget-status">
      <span>{Option.getOrElse(utilization, () => "")}</span>
      <span>{status}</span>
    </div>
  </section>
);

type RecentRow = Readonly<{
  id: string;
  date: string;
  counterparty: string;
  category: string;
  inflow: boolean;
  money: string;
  currency: string;
}>;
export type DashboardRecentGroup = Readonly<{ date: string; rows: ReadonlyArray<RecentRow> }>;
const RecentDirection = ({ inflow }: Readonly<{ inflow: boolean }>): JSX.Element => (
  <DirectionIndicator inflow={inflow} />
);
const RecentRow = ({ row }: Readonly<{ row: RecentRow }>): JSX.Element => (
  <Link
    to="/app/transactions"
    search={{ date: row.date }}
    className="dashboard-recent-row rounded-md focus-visible:outline-2 focus-visible:outline-ring"
    aria-label={`${row.counterparty}, ${row.category}, ${row.inflow ? "Ingreso" : "Gasto"}, ${row.money} ${row.currency}`}
  >
    <div className="dashboard-recent-identity">
      <span className="dashboard-recent-identity-icon">
        <CategoryVisual label={row.category} bubble large={false} />
      </span>
      <span>
        <span>{row.counterparty}</span>
        <small>{row.category}</small>
      </span>
    </div>
    <div className="dashboard-recent-category">
      <CategoryVisual label={row.category} bubble large={false} />
      <span>{row.category}</span>
    </div>
    <div className="dashboard-recent-type">
      <RecentDirection inflow={row.inflow} />
      <span>{row.inflow ? "Ingreso" : "Gasto"}</span>
    </div>
    <div className="dashboard-recent-amount">
      <span className="dashboard-recent-inline-direction">
        <RecentDirection inflow={row.inflow} />
      </span>
      <span title={row.currency}>{row.money}</span>
      <HugeiconsIcon icon={ArrowRight01Icon} size={16} strokeWidth={1.5} aria-hidden="true" />
    </div>
  </Link>
);
export const DashboardRecentList = ({
  groups,
}: Readonly<{ groups: ReadonlyArray<DashboardRecentGroup> }>): JSX.Element => (
  <div className="dashboard-recent-scroll" aria-label="Transacciones del Widget">
    <div className="dashboard-recent-grid">
      {groups.map((group) => (
        <section key={group.date} className="dashboard-recent-group" aria-label={group.date}>
          <div className="dashboard-recent-date">{group.date}</div>
          {group.rows.map((row) => (
            <RecentRow row={row} key={row.id} />
          ))}
        </section>
      ))}
    </div>
  </div>
);

export const DashboardCustomizeAction = (props: ComponentProps<typeof Button>): JSX.Element => (
  <Button {...props} className="dashboard-personalize" variant="outline" />
);

const DashboardTooltipPortal = createContext(Option.none<HTMLDivElement>());

export const DashboardChart = ({
  children,
  dense,
}: Readonly<{ children: ReactNode; dense: boolean }>): JSX.Element => {
  const [portal, setPortal] = useState(() => Option.none<HTMLDivElement>());
  const bindPortal = useCallback<RefCallback<HTMLDivElement>>((element) => {
    setPortal(Option.fromNullishOr(element));
  }, []);
  return (
    <DashboardTooltipPortal value={portal}>
      <div className="dashboard-chart-frame">
        <div className="dashboard-chart-scroll">
          <div className="dashboard-chart" data-dense={dense || undefined}>
            {children}
          </div>
        </div>
        <div className="dashboard-chart-tooltip" ref={bindPortal} />
      </div>
    </DashboardTooltipPortal>
  );
};

export const DashboardAxisTick = ({
  x,
  y,
  payload,
  category,
  labels,
}: Partial<Pick<XAxisTickContentProps, "x" | "y" | "payload">> &
  Readonly<{
    category: boolean;
    labels: ReadonlyArray<Readonly<{ key: string; label: string }>>;
  }>): JSX.Element => {
  const key = Option.getOrElse(Schema.decodeUnknownOption(Schema.String)(payload?.value), () => "");
  const label = labels.find((row) => row.key === key)?.label ?? key;
  return (
    <g transform={`translate(${x ?? 0},${y ?? 0})`}>
      <title>{label}</title>
      {category ? (
        <svg
          className="dashboard-category-emoji"
          aria-label={label}
          x="-0.75em"
          width="1.5em"
          height="1.5em"
        >
          <text textAnchor="middle" x="50%" y="1em">
            {dashboardCategoryVisual(key).emoji}
          </text>
        </svg>
      ) : (
        <text textAnchor="middle" fill="var(--fidy-text-muted)" fontSize={11} dy={12}>
          {label}
        </text>
      )}
    </g>
  );
};
export const DashboardTooltip = (props: ComponentProps<typeof ChartTooltip>): JSX.Element => {
  const portal = useContext(DashboardTooltipPortal);
  return (
    <ChartTooltip
      {...props}
      portal={Option.getOrUndefined(portal)}
      wrapperStyle={{ width: "max-content", maxWidth: "100%" }}
      contentStyle={{
        background: "var(--fidy-background-surface)",
        borderColor: "var(--application-line)",
        borderRadius: 12,
        whiteSpace: "normal",
        overflowWrap: "anywhere",
      }}
      itemStyle={{ color: "var(--fidy-text-primary)" }}
      labelStyle={{ color: "var(--fidy-text-primary)" }}
    />
  );
};
