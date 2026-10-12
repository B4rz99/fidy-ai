import * as React from "react";
// Dashboard presentation is already route-lazy.
// react-doctor-disable-next-line prefer-dynamic-import
import * as RechartsPrimitive from "recharts";
import { cn } from "@/ui/class-names";

/** Theme labels and colors consumed by the shadcn ChartContainer source. */
export type ChartConfig = Readonly<
  Record<string, Readonly<{ label: React.ReactNode; color: string }>>
>;

type ChartContainerProps = Readonly<{
  children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>["children"];
  className: string;
  config: ChartConfig;
}>;

const ChartStyle = ({
  id,
  config,
}: Readonly<{ id: string; config: ChartConfig }>): React.JSX.Element => (
  <style>
    {`[data-chart=${id}] {${Object.entries(config)
      .map(([key, item]) => `--color-${key}: ${item.color};`)
      .join("")}}`}
  </style>
);

/** Responsive shadcn chart frame; Recharts remains directly composable inside it. */
const ChartContainer = ({
  className,
  children,
  config,
}: ChartContainerProps): React.JSX.Element => {
  const uniqueId = React.useId().replaceAll(":", "");
  const chartId = `chart-${uniqueId}`;
  return (
    <div
      className={cn(
        "flex aspect-video justify-center text-xs [&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-border/50 [&_.recharts-layer]:outline-hidden [&_.recharts-surface]:outline-hidden",
        className
      )}
      data-chart={chartId}
      data-slot="chart"
    >
      <ChartStyle id={chartId} config={config} />
      <RechartsPrimitive.ResponsiveContainer initialDimension={{ width: 320, height: 200 }}>
        {children}
      </RechartsPrimitive.ResponsiveContainer>
    </div>
  );
};

const ChartTooltip = RechartsPrimitive.Tooltip;

export { ChartContainer, ChartStyle, ChartTooltip };
