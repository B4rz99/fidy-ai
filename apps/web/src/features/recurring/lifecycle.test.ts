// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { IanaTimeZone, RecurringPlanId } from "@/transport/client";
import { PlanLifecycle } from "./lifecycle";
import { type Edit, type Plan, planStatus } from "./model";

const base = {
  id: RecurringPlanId.make("24000000-0000-4000-8000-000000017240"),
  pauses: [],
  revisions: [
    {
      from: "2026-01-01",
      plan: {
        name: "Netflix",
        kind: "expense",
        currency: "COP",
        amountMode: "unknown",
        frequency: "monthly",
        firstDate: "2026-01-01",
        timeZone: IanaTimeZone.make("America/Bogota"),
      },
    },
  ] as const,
};
const stopped: Plan = { ...base, stoppedOn: "2026-01-12" };
const scheduledStop: Plan = { ...base, stoppedOn: "2099-01-01" };
const active: Plan = { ...base };

type Root = ReturnType<typeof createRoot>;
const render = (plan: Plan): { container: HTMLDivElement; edits: Edit[]; root: Root } => {
  const container = window.document.createElement("div");
  const root = createRoot(container);
  const edits: Edit[] = [];
  act(() => {
    root.render(
      createElement(PlanLifecycle, {
        plan,
        status: planStatus(plan),
        disabled: false,
        save: (edit: Edit) => edits.push(edit),
      })
    );
  });
  return { container, edits, root };
};
const button = (container: HTMLDivElement, label: string): HTMLButtonElement => {
  const found = Array.from(container.querySelectorAll("button")).find(
    (entry) => entry.textContent === label
  );
  if (found === undefined) throw new Error(`Missing button ${label}`);
  return found;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

it("offers to resume a stopped plan and explains the untracked period", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const { container, edits, root } = render(stopped);
  try {
    expect(container.textContent).toContain("No generó fechas desde el 12 de enero de 2026.");
    act(() => button(container, "Reanudar seguimiento").click());
    const saved = edits[0];
    if (saved?.kind !== "lifecycle") {
      throw new Error("Expected a lifecycle edit");
    }
    expect(saved).toMatchObject({ planId: stopped.id, action: "resume" });
    expect(saved.date).toHaveLength("2026-01-01".length);
  } finally {
    act(() => root.unmount());
  }
});

it("dates the untracked period from an open pause when the plan stopped while paused", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const pausedThenStopped: Plan = {
    ...base,
    pauses: [{ from: "2026-01-05" }],
    stoppedOn: "2026-01-12",
  };
  const { container, root } = render(pausedThenStopped);
  try {
    expect(container.textContent).toContain("No generó fechas desde el 5 de enero de 2026.");
  } finally {
    act(() => root.unmount());
  }
});

it("offers to cancel a scheduled stop that has not taken effect", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const { container, edits, root } = render(scheduledStop);
  try {
    expect(container.textContent).toContain("Detiene las fechas a partir del 1 de enero de 2099.");
    act(() => button(container, "Cancelar detención").click());
    const saved = edits[0];
    if (saved?.kind !== "lifecycle") {
      throw new Error("Expected a lifecycle edit");
    }
    expect(saved).toMatchObject({ planId: scheduledStop.id, action: "resume" });
  } finally {
    act(() => root.unmount());
  }
});

it("keeps pause as the only lifecycle action while the plan is active", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const { container, root } = render(active);
  try {
    expect(button(container, "Pausar plan")).toBeDefined();
    expect(container.textContent).not.toContain("Reanudar seguimiento");
  } finally {
    act(() => root.unmount());
  }
});
