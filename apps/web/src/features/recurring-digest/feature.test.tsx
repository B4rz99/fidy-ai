import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Cause, Schema } from "effect";
import { AsyncResult } from "effect/reactivity";
import { RecurringDigestReport } from "@/transport/client";
import { RecurringDigestFeature } from "./feature";

const query = vi.hoisted(
  (): Readonly<{ read: ReturnType<typeof vi.fn>; refresh: ReturnType<typeof vi.fn> }> & {
    value: unknown;
  } => ({ value: undefined, refresh: vi.fn(), read: vi.fn(() => "report") })
);
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (): unknown => query.value,
  useAtomRefresh: (): typeof query.refresh => query.refresh,
}));
vi.mock("@tanstack/react-router", () => ({
  useParams: (): Readonly<{ id: string }> => ({ id: "29000000-0000-4000-8000-000000000099" }),
  useRouter: (): unknown => ({ options: { context: { apiClient: { query: query.read } } } }),
}));
afterEach(cleanup);
const identityLength = 12;
const itemCount = 33;
const report = Schema.decodeUnknownSync(RecurringDigestReport)({
  insightEventId: "29000000-0000-4000-8000-000000000099",
  serviceMarket: "CO",
  locale: "es-CO",
  scheduledAt: "2026-10-07T14:00:00Z",
  expiresAt: "2026-10-08T14:00:00Z",
  payload: {
    confirmationDay: {
      localDate: "2026-10-06",
      timeZone: "America/Bogota",
      from: "2026-10-06T05:00:00Z",
      toExclusive: "2026-10-07T05:00:00Z",
    },
    items: Array.from({ length: itemCount }, (_, index) => ({
      confirmationId: `29000000-0000-4000-8000-${String(index).padStart(identityLength, "0")}`,
      seriesId: `29000000-0000-4000-8001-${String(index).padStart(identityLength, "0")}`,
      counterparty: `${String(index).padStart(2, "0")} <script>histórico</script>`,
      money: { amount: "9007199254740993.01", currency: "COP" },
      cadence: { kind: "monthly" },
      confirmedAt: "2026-10-06T19:00:00Z",
    })),
  },
});
it("renders the complete canonical report, exact Money and untrusted labels as text", () => {
  query.value = AsyncResult.success({ data: report, next: [] });
  const { container } = render(<RecurringDigestFeature />);
  expect(within(screen.getByRole("list")).getAllByRole("listitem")).toHaveLength(itemCount);
  expect(screen.getByText("32 <script>histórico</script> · mensual")).toBeVisible();
  expect(container.querySelector("script")).toBeNull();
  expect(screen.getAllByText(/\$.*9.*007.*199.*254.*740.*993/)).toHaveLength(itemCount);
  expect(screen.getByText(/Estos patrones no indican/)).toBeVisible();
  expect(query.read).toHaveBeenCalledWith("insights", "getRecurringDigestReport", {
    params: { id: report.insightEventId },
  });
});
it("shows loading and safe retry states without exposing a failure cause", () => {
  query.value = AsyncResult.initial();
  const { rerender } = render(<RecurringDigestFeature />);
  expect(screen.getByText("Cargando informe…")).toBeVisible();
  query.value = AsyncResult.failure(Cause.die("private financial failure"));
  rerender(<RecurringDigestFeature />);
  expect(screen.queryByText("private financial failure")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
  expect(query.refresh).toHaveBeenCalledOnce();
});
