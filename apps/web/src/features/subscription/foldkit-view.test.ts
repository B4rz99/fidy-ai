import { screen } from "@testing-library/dom";
import { type Cause, Effect, Option } from "effect";
import { Mount, Runtime, type Update } from "foldkit";
import { afterEach, expect, it } from "vitest";
import { cleanupFoldkit, renderFoldkit } from "@/testing/foldkit";
import { subscriptionView } from "./foldkit-view";
import { Message, Model, initialModel } from "./model";
import { PaymentField, type PaymentStage } from "./payment-model";
import { offers, trialStanding } from "./testing-fixtures";

afterEach(cleanupFoldkit);
const input = Mount.define("SubscriptionViewTestInput", {
  args: { field: PaymentField },
  messages: [Message.Mounted],
  execute: () => Effect.succeed(Message.Mounted()),
});
const render = (model: Model): Effect.Effect<HTMLElement, Cause.UnknownError> => {
  const { container } = renderFoldkit((target) => {
    const handle = Runtime.embed(
      Runtime.makeElement({
        Model,
        container: target,
        devTools: false,
        init: (): Update.Return<Model, Message> => ({ model }),
        update: (current, _message: Message): Update.Return<Model, Message> => ({ model: current }),
        view: (current, html) => subscriptionView({ model: current, html, mount: input }),
      })
    );
    return handle.dispose;
  });
  return Effect.tryPromise(() =>
    screen.findByRole("heading", { name: "Mejora tu suscripción" })
  ).pipe(Effect.as(container));
};
const ready: Model = {
  ...initialModel,
  offers: Option.some(offers),
  offersStatus: "Ready",
  standing: Option.some(trialStanding),
  standingStatus: "Ready",
};

it.each([
  [false, "No pudimos cargar las ofertas"],
  [true, "No pudimos comunicarnos con Fidy"],
] as const)("shows the appropriate empty offer failure and retry action", (boundary, copy) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* render({
        ...initialModel,
        offersStatus: "Failed",
        offersBoundaryFailure: boundary,
        standingStatus: "Failed",
      });
      expect(screen.getByText(copy)).toBeVisible();
      expect(screen.getByRole("button", { name: "Reintentar carga" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Reintentar" })).toBeEnabled();
    })
  )
);

it("keeps stale offers visible and disabled with an explicit update warning", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* render({ ...ready, offersStatus: "Failed" });
      expect(screen.getByRole("alert")).toHaveTextContent("últimas ofertas");
      expect(
        screen
          .getAllByRole("button", { name: /^Elegir/u })
          .every((button) => button.hasAttribute("disabled"))
      ).toBe(true);
    })
  ));

it.each([
  "Idle",
  "Expired",
  "Creating",
  "Verifying",
  "RetrySubmission",
  "Uncertain",
] satisfies ReadonlyArray<PaymentStage>)("renders safe payment recovery controls for %s", (stage) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* render({
        ...ready,
        selected: Option.some(offers[1].id),
        payment: { ...ready.payment, stage, locked: stage === "Uncertain" },
      });
      if (stage === "Creating" || stage === "Verifying") {
        expect(screen.getByRole("button", { name: "Consultar estado" })).toBeEnabled();
      } else if (stage === "RetrySubmission") {
        expect(
          screen.getByRole("button", { name: "Reintentar envío de la autorización aprobada" })
        ).toBeEnabled();
      } else if (stage === "Uncertain") {
        expect(
          screen.queryByRole("button", { name: "Preparar una inscripción nueva" })
        ).not.toBeInTheDocument();
      } else {
        expect(
          screen.getByRole("button", { name: "Preparar una inscripción nueva" })
        ).toBeEnabled();
      }
      expect(screen.queryByLabelText("Número de tarjeta")).not.toBeInTheDocument();
    })
  )
);

it("distinguishes a paid subscription and retains its last known state after refresh failure", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const standing: Model["standing"] = Option.some({
        ...trialStanding,
        accessTier: "pro",
        paidSubscription: Option.some({
          priceId: offers[1].id,
          billingPeriod: offers[1].billingPeriod,
          serviceMarket: offers[1].serviceMarket,
          taxTreatment: offers[1].taxTreatment,
          renewalAnchor: trialStanding.trialPeriod.startedAt,
          startsAt: trialStanding.trialPeriod.startedAt,
          endsAt: trialStanding.trialPeriod.endsAt,
          money: offers[1].money,
        }),
      });
      yield* render({ ...ready, standing, standingStatus: "Failed" });
      expect(screen.getByRole("heading", { name: "Tu acceso: Pro" })).toBeVisible();
      expect(screen.getByRole("alert")).toHaveTextContent("último estado disponible");
      expect(screen.getByText(/Precio cobrado/u)).toBeVisible();
    })
  ));
