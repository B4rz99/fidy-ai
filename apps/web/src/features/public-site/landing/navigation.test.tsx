import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Header } from "./navigation";

afterEach(() => {
  cleanup();
});

it("keeps compact navigation named and dismisses it when a destination is selected", () => {
  render(<Header />);
  // Native closed popovers are excluded from the accessibility tree in JSDOM too.
  const panel = screen.getByLabelText("Navegación compacta");
  const hide = vi.fn();
  Object.defineProperty(panel, "hidePopover", { value: hide });
  expect(screen.getByRole("navigation", { name: "Principal" })).toBeInTheDocument();
  const trigger = screen.getByRole("button", { name: "Menú de navegación" });
  fireEvent.click(trigger, { detail: 1 });
  expect(panel).toHaveAttribute("data-motion", "pointer");
  fireEvent.keyDown(trigger, { key: "Escape" });
  expect(panel).toHaveAttribute("data-motion", "instant");
  fireEvent.click(trigger, { detail: 0 });
  expect(panel).toHaveAttribute("data-motion", "instant");
  const destination = panel.querySelector("a");
  if (destination === null) throw new Error("Compact navigation destination missing");
  fireEvent.keyDown(destination, { key: "Tab" });
  fireEvent.keyDown(destination, { key: "Escape" });
  fireEvent.click(destination);
  expect(hide).toHaveBeenCalledOnce();
});
