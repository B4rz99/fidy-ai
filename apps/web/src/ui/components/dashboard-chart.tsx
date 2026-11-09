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
import { ChartTooltip } from "./chart";
import { dashboardCategoryVisual } from "./dashboard-category";

const categorySlotWidthRem = 1.75;

const DashboardTooltipPortal = createContext(Option.none<HTMLDivElement>());

export const DashboardChart = ({
  children,
  categoryCount,
}: Readonly<{ children: ReactNode; categoryCount: number }>): JSX.Element => {
  const [portal, setPortal] = useState(() => Option.none<HTMLDivElement>());
  const bindPortal = useCallback<RefCallback<HTMLDivElement>>((element) => {
    setPortal(Option.fromNullishOr(element));
  }, []);
  return (
    <DashboardTooltipPortal value={portal}>
      <div className="dashboard-chart-frame">
        <div className="dashboard-chart-scroll">
          <div
            className="dashboard-chart"
            style={{ minWidth: `${categoryCount * categorySlotWidthRem}rem` }}
          >
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
