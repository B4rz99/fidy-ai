import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { VisibleReply } from "./visible-reply";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("waits for document visibility and removes its listener when the chat closes", () => {
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  const onVisible = vi.fn();
  const view = render(
    <StrictMode>
      <VisibleReply active onVisible={onVisible}>
        Respuesta
      </VisibleReply>
    </StrictMode>
  );
  expect(screen.getByText("Respuesta")).toBeVisible();
  expect(onVisible).not.toHaveBeenCalled();
  visibility.mockReturnValue("visible");
  fireEvent(document, new Event("visibilitychange"));
  expect(onVisible).toHaveBeenCalledTimes(1);
  view.rerender(
    <VisibleReply active={false} onVisible={onVisible}>
      Respuesta
    </VisibleReply>
  );
  fireEvent(document, new Event("visibilitychange"));
  expect(onVisible).toHaveBeenCalledTimes(1);
});
