import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Schema } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { OAuthReview } from "@/transport/client";
import { OAuthReviewView } from "./view";

afterEach(cleanup);
const review = Schema.decodeSync(OAuthReview)({
  requestId: "10000000-0000-4000-8000-000000000001",
  claimedClientName: "<img src=x onerror=alert(1)>",
  scopes: ["read"],
  permissions: [
    {
      scope: "read",
      label: "Consultar tus datos",
      description: "Consultar tus datos financieros en Fidy.",
    },
  ],
  reviewedAt: "2026-10-03T12:00:00.000Z",
  requestExpiresAt: "2026-10-03T12:10:00.000Z",
  connectAvailable: true,
});
it("renders unverified claims as text, shows only requested permissions and submits only the non-empty reviewed subset and absolute expiration", () => {
  const cancel = vi.fn();
  const connect = vi.fn();
  const { container } = render(
    <OAuthReviewView
      review={review}
      cancelling={false}
      cancel={cancel}
      connecting={false}
      connect={connect}
    />
  );
  expect(screen.getByText(review.claimedClientName)).toBeVisible();
  expect(container.querySelector("img")).toBeNull();
  expect(screen.queryByText("Crear y modificar tus datos")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "90 días" })).toHaveAttribute("aria-pressed", "true");
  expect(container.querySelector('time[datetime="2027-01-01T12:00:00.000Z"]')).toHaveTextContent(
    "1 de enero de 2027"
  );
  fireEvent.click(screen.getByRole("button", { name: "7 días" }));
  expect(container.querySelector('time[datetime="2026-10-10T12:00:00.000Z"]')).toHaveTextContent(
    "10 de octubre de 2026"
  );
  fireEvent.click(screen.getByRole("button", { name: "Conectar" }));
  expect(connect).toHaveBeenCalledWith(
    expect.objectContaining({
      requestId: review.requestId,
      scopes: ["read"],
      lifetimeDays: 7,
      reviewedAt: review.reviewedAt,
    })
  );
  fireEvent.click(screen.getByRole("checkbox"));
  expect(screen.getByRole("alert")).toHaveTextContent("Selecciona al menos un permiso.");
  expect(screen.getByRole("button", { name: "Conectar" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
  expect(cancel).toHaveBeenCalledOnce();
});
