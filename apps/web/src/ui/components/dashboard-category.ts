const categoryVisuals = new Map<string, Readonly<{ emoji: string; fill: string }>>([
  ["10000000-0000-4000-8000-000000000001", { emoji: "🍽️", fill: "var(--chart-6)" }],
  ["10000000-0000-4000-8000-000000000002", { emoji: "🛵", fill: "var(--chart-3)" }],
  ["10000000-0000-4000-8000-000000000003", { emoji: "🛒", fill: "var(--chart-1)" }],
  ["10000000-0000-4000-8000-000000000004", { emoji: "🚌", fill: "var(--chart-4)" }],
  ["10000000-0000-4000-8000-000000000005", { emoji: "🏠", fill: "var(--chart-5)" }],
  ["10000000-0000-4000-8000-000000000006", { emoji: "💡", fill: "var(--chart-2)" }],
  ["10000000-0000-4000-8000-000000000007", { emoji: "🩺", fill: "var(--chart-1)" }],
  ["10000000-0000-4000-8000-000000000008", { emoji: "🎓", fill: "var(--chart-4)" }],
  ["10000000-0000-4000-8000-000000000009", { emoji: "🛍️", fill: "var(--chart-1)" }],
  ["10000000-0000-4000-8000-000000000010", { emoji: "🎮", fill: "var(--chart-2)" }],
  ["10000000-0000-4000-8000-000000000011", { emoji: "✈️", fill: "var(--chart-5)" }],
  ["10000000-0000-4000-8000-000000000012", { emoji: "🧾", fill: "var(--chart-6)" }],
  ["10000000-0000-4000-8000-000000000013", { emoji: "↔️", fill: "var(--chart-2)" }],
  ["10000000-0000-4000-8000-000000000014", { emoji: "🏧", fill: "var(--chart-3)" }],
  ["10000000-0000-4000-8000-000000000015", { emoji: "💰", fill: "var(--chart-1)" }],
  ["10000000-0000-4000-8000-000000000016", { emoji: "📦", fill: "var(--chart-3)" }],
]);

const fallbackVisual = { emoji: "🏷️", fill: "var(--chart-3)" };

export const dashboardCategoryVisual = (key: string): Readonly<{ emoji: string; fill: string }> =>
  categoryVisuals.get(key) ?? fallbackVisual;
