import { useState } from "react";
import type { JSX } from "react";
import type { FidyClient } from "@/transport/client";
import type { CaptureStatus } from "./panel-state";
import { RegistryProvider } from "@effect/atom-react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientError } from "effect/http";
import { afterEach, expect, it } from "vitest";
import { makeFidyClient } from "@/transport/client";
import { ManualTransactionCapture } from "./manual-capture";

const CaptureHarness = ({ apiClient }: Readonly<{ apiClient: FidyClient }>): JSX.Element => {
  const [status, onStatus] = useState<CaptureStatus>("idle");
  return (
    <ManualTransactionCapture
      renderForm={(form) => form}
      apiClient={apiClient}
      timeZone="America/Bogota"
      onCreated={() => undefined}
      onCheckHistory={() => undefined}
      status={status}
      onStatus={onStatus}
    />
  );
};
afterEach(cleanup);

it("requires checking history after a capture acknowledgement is lost instead of replaying it", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let captures = 0;
      const client = HttpClient.make((request) => {
        captures += 1;
        return Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request }),
          })
        );
      });
      render(
        <RegistryProvider>
          <CaptureHarness
            apiClient={makeFidyClient({
              apiOrigin: "https://api.test.fidyapp.com",
              httpClient: Layer.succeed(HttpClient.HttpClient, client),
            })}
          />
        </RegistryProvider>
      );
      fireEvent.change(screen.getByLabelText("Monto en COP"), { target: { value: "25000" } });
      fireEvent.click(screen.getByRole("button", { name: "Registrar transacción" }));
      expect(
        yield* Effect.tryPromise(() =>
          screen.findByText(
            "No pudimos confirmar el registro de la transacción. Revisa el historial antes de registrar otro movimiento."
          )
        )
      ).toBeVisible();
      const submit = screen.getByRole("button", { name: "Registrar transacción" });
      expect(submit).toBeDisabled();
      fireEvent.click(submit);
      expect(captures).toBe(1);
    })
  ));
