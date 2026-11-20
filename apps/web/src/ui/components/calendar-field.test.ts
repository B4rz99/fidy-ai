// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { CalendarField } from "./calendar-field";

it("opens the selected month on first use and returns the chosen local date", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const change = vi.fn();
  try {
    await act(() =>
      root.render(
        createElement(CalendarField, {
          appearance: "field",
          id: "fecha",
          value: "2026-11-15",
          label: "Fecha",
          timeZone: "America/Bogota",
          disabled: false,
          required: true,
          onChange: change,
        })
      )
    );
    const trigger = container.querySelector("button");
    if (!trigger) throw new Error("Missing calendar trigger");
    await act(() => {
      trigger.focus();
      trigger.click();
    });
    await act(() => import("./calendar").then(() => undefined));
    const nextDay = document.querySelector<HTMLElement>('[data-day="2026-11-16"] button');
    expect(nextDay).toBeInstanceOf(HTMLElement);
    await act(() => nextDay?.click());
    expect(change).toHaveBeenCalledExactlyOnceWith("2026-11-16");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  } finally {
    await act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
