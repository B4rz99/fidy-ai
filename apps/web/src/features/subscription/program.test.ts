import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { type Cause, Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { AtomRegistry } from "effect/reactivity";
import { afterEach, expect, it, vi } from "vitest";
import { cleanupFoldkit, renderFoldkit } from "@/testing/foldkit";
import { SubscriptionOffers, SubscriptionStatus, makeFidyClient } from "@/transport/client";
import type { DaviplataChallenge } from "./daviplata-challenge";
import type { EnrollmentGateway } from "./enrollment-gateway";
import { mountSubscription } from "./program";
import {
  daviplataEnrollment,
  enrollmentGateway,
  offers,
  preparedEnrollment,
  trialStanding,
} from "./testing-fixtures";

const encodeOffers = Schema.encodeSync(SubscriptionOffers);
const encodeStanding = Schema.encodeSync(SubscriptionStatus);
const response = (url: string): Response =>
  Response.json({
    data: url.endsWith("/offers") ? encodeOffers(offers) : encodeStanding(trialStanding),
    next: [],
  });
const mount = (
  gateway: EnrollmentGateway,
  respond: (url: string) => Response = response
): ReturnType<typeof renderFoldkit> => {
  const client = makeFidyClient({
    apiOrigin: "https://api.test.fidyapp.com",
    httpClient: Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, respond(request.url)))
      )
    ),
  });
  const registry = AtomRegistry.make();
  return renderFoldkit((container) => {
    const dispose = mountSubscription({
      container,
      client,
      resources: registry.get(client.runtime.layer),
      gateway,
    });
    return () => {
      dispose();
      registry.dispose();
    };
  });
};
const click = (name: string): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    const button = yield* Effect.tryPromise(() => screen.findByRole("button", { name }));
    yield* Effect.tryPromise(() => waitFor(() => expect(button).not.toBeDisabled()));
    fireEvent.click(button);
  });
const fill = (label: string, value: string): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    const input = yield* Effect.tryPromise(() => screen.findByLabelText(label));
    fireEvent.input(input, { target: { value } });
  });
const consent = (): void => {
  for (const checkbox of screen.getAllByRole("checkbox")) fireEvent.click(checkbox);
};
const card = (): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* fill("Número de tarjeta", "4242424242424242");
    yield* fill("Vencimiento", "1230");
    yield* fill("CVC", "123");
    yield* fill("Nombre en la tarjeta", "Test Person");
  });
const daviplata = (start: EnrollmentGateway["startDaviplata"]): EnrollmentGateway => ({
  ...enrollmentGateway,
  availability: () => Promise.resolve({ enabledMethods: ["card", "nequi", "daviplata"] }),
  prepare: () => Promise.resolve(daviplataEnrollment),
  startDaviplata: start,
});
const startDavi = (): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* click("DaviPlata");
    yield* click("Elegir mensual");
    yield* fill("Número de cédula", "1122233");
    yield* fill("Número de DaviPlata", "3991111111");
    consent();
    yield* click("Autorizar con DaviPlata");
  });
const challenge = (confirm: DaviplataChallenge["confirm"]): DaviplataChallenge => ({
  confirm,
  resend: () => Promise.resolve({ status: "retry-allowed" }),
  retrySubmission: () => Promise.resolve({ status: "refused" }),
  dispose: vi.fn(),
});
afterEach(() => {
  cleanupFoldkit();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("renders canonical standing and exact prices, and shows DaviPlata only when enabled", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      mount(enrollmentGateway);
      expect(yield* Effect.tryPromise(() => screen.findByText("Tu acceso: Gratis"))).toBeVisible();
      expect(
        yield* Effect.tryPromise(() => screen.findByRole("button", { name: "Elegir mensual" }))
      ).toHaveTextContent(/28.900,00/u);
      expect(screen.queryByRole("button", { name: "DaviPlata" })).not.toBeInTheDocument();
      expect(screen.getByText(/Tu historial permanece disponible/u)).toBeVisible();
    })
  ));
it("requires both Wompi decisions, normalizes fields, and disables duplicate card submission", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const pending = Promise.withResolvers<Awaited<ReturnType<EnrollmentGateway["submit"]>>>();
      const submit = vi.fn<EnrollmentGateway["submit"]>(() => pending.promise);
      mount({ ...enrollmentGateway, submit });
      yield* click("Elegir mensual");
      yield* card();
      yield* fill("Correo de facturación", " BILLING@EXAMPLE.COM ");
      expect(screen.getByRole("button", { name: "Activar Pro" })).toBeDisabled();
      consent();
      yield* click("Activar Pro");
      yield* Effect.tryPromise(() => waitFor(() => expect(submit).toHaveBeenCalledTimes(1)));
      expect(submit.mock.calls[0]?.[1]).toBe("billing@example.com");
      expect(screen.getByRole("button", { name: "Activando Pro…" })).toBeDisabled();
      pending.resolve({
        status: "refused",
        reason: "provider-error",
        enrollmentId: preparedEnrollment.enrollmentId,
      });
      yield* Effect.tryPromise(() =>
        screen.findByText(/No pudimos continuar la autorización o iniciar el pago/u)
      );
      expect(screen.queryByLabelText("CVC")).not.toBeInTheDocument();
    })
  ));
it("reuses a saved source without rendering card fields", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      mount({
        ...enrollmentGateway,
        prepare: () => Promise.resolve({ ...preparedEnrollment, paymentSourceMode: "reuse" }),
      });
      yield* click("Elegir mensual");
      yield* Effect.tryPromise(() => screen.findByText(/Usaremos de nuevo tu fuente de pago/u));
      expect(screen.queryByLabelText("Número de tarjeta")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Correo de facturación")).toHaveValue("verified@example.com");
    })
  ));
it("does not publish document/product or OTP values and retries only an approved Fidy submission", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const values: string[] = [];
      const confirm = vi.fn<DaviplataChallenge["confirm"]>((otp) => {
        values.push(Redacted.value(otp));
        return Promise.resolve({ status: "uncertain", retrySubmission: true });
      });
      const retry = vi.fn<DaviplataChallenge["retrySubmission"]>(() =>
        Promise.resolve({
          status: "submitted",
          submission: {
            status: "refused",
            reason: "provider-error",
            enrollmentId: preparedEnrollment.enrollmentId,
          },
        })
      );
      const start = vi.fn<EnrollmentGateway["startDaviplata"]>(() =>
        Promise.resolve({ ...challenge(confirm), retrySubmission: retry })
      );
      mount(daviplata(start));
      yield* startDavi();
      yield* fill("Código de verificación", "123456");
      yield* click("Confirmar código");
      yield* click("Reintentar envío de la autorización aprobada");
      yield* Effect.tryPromise(() => waitFor(() => expect(retry).toHaveBeenCalledTimes(1)));
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(start).toHaveBeenCalledTimes(1);
      expect(values).toEqual(["123456"]);
      expect(document.body.textContent).not.toContain("1122233");
      expect(document.body.textContent).not.toContain("123456");
    })
  ));
it("offers no repeat authorization or submission after uncertain provider OTP outcome", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const confirm = vi.fn<DaviplataChallenge["confirm"]>(() =>
        Promise.resolve({ status: "uncertain", retrySubmission: false })
      );
      mount(daviplata(() => Promise.resolve(challenge(confirm))));
      yield* startDavi();
      yield* fill("Código de verificación", "123456");
      yield* click("Confirmar código");
      yield* Effect.tryPromise(() => screen.findByText(/No pudimos confirmar el resultado/u));
      expect(
        screen.queryByRole("button", { name: "Reintentar envío de la autorización aprobada" })
      ).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Tarjeta" })).toBeDisabled();
    })
  ));
it.each(["cancel", "unmount"])(
  "aborts pending DaviPlata start on %s and disposes late challenge",
  (action) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const pending = Promise.withResolvers<DaviplataChallenge>();
        const start = vi.fn<EnrollmentGateway["startDaviplata"]>(() => pending.promise);
        const live = challenge(() => Promise.resolve({ status: "retry-allowed" }));
        const mounted = mount(daviplata(start));
        yield* startDavi();
        yield* Effect.tryPromise(() => waitFor(() => expect(start).toHaveBeenCalledTimes(1)));
        if (action === "cancel") yield* click("Cancelar autorización");
        else mounted.unmount();
        yield* Effect.tryPromise(() =>
          waitFor(() => expect(start.mock.calls[0]?.[2].signal.aborted).toBe(true))
        );
        pending.resolve(live);
        yield* Effect.tryPromise(() => waitFor(() => expect(live.dispose).toHaveBeenCalled()));
        expect(screen.queryByLabelText("Código de verificación")).not.toBeInTheDocument();
      })
    )
);
it("cancels pending OTP confirmation and ignores a late success", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const pending = Promise.withResolvers<Awaited<ReturnType<DaviplataChallenge["confirm"]>>>();
      const live = challenge(() => pending.promise);
      mount(daviplata(() => Promise.resolve(live)));
      yield* startDavi();
      yield* fill("Código de verificación", "123456");
      yield* click("Confirmar código");
      yield* click("Cancelar autorización");
      yield* Effect.tryPromise(() =>
        screen.findByText(/No pudimos continuar la autorización o iniciar el pago/u)
      );
      expect(live.dispose).toHaveBeenCalled();
      pending.resolve({
        status: "submitted",
        submission: { status: "source-verifying", enrollmentId: preparedEnrollment.enrollmentId },
      });
      yield* Effect.tryPromise(() => pending.promise);
      expect(screen.queryByText("Estamos verificando tu fuente de pago.")).not.toBeInTheDocument();
    })
  ));
it("clears Nequi input after authorization starts and aborts it on disposal", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const submit = vi.fn<EnrollmentGateway["submit"]>((_prepared, _email, options) => {
        if (
          options !== undefined &&
          Option.isSome(options.fields) &&
          "method" in options.fields.value
        ) {
          options.fields.value.onAwaiting();
        }
        return Promise.withResolvers<Awaited<ReturnType<EnrollmentGateway["submit"]>>>().promise;
      });
      const mounted = mount({
        ...enrollmentGateway,
        prepare: () => Promise.resolve({ ...preparedEnrollment, method: "nequi" }),
        submit,
      });
      yield* click("Nequi");
      yield* click("Elegir mensual");
      yield* fill("Número de Nequi", "3991111111");
      consent();
      yield* click("Autorizar con Nequi");
      yield* Effect.tryPromise(() => screen.findByText(/Aprueba la suscripción en Nequi/u));
      const input = screen.getByLabelText("Número de Nequi");
      expect(input).toHaveValue("");
      expect(screen.getByRole("button", { name: "Tarjeta" })).toBeDisabled();
      const fields = submit.mock.calls[0]?.[2]?.fields;
      mounted.unmount();
      if (fields !== undefined && Option.isSome(fields) && "method" in fields.value) {
        expect(fields.value.signal.aborted).toBe(true);
      }
      expect(input).toHaveValue("");
    })
  ));
it("resumes a verifying enrollment without asking the provider for a new authorization", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const submit = vi.fn(enrollmentGateway.submit);
      const resume = vi.fn<EnrollmentGateway["resume"]>(() =>
        Promise.resolve(
          Option.some({
            billingEmail: "billing@example.com",
            submission: {
              status: "source-verifying",
              enrollmentId: preparedEnrollment.enrollmentId,
            },
          })
        )
      );
      mount({
        ...enrollmentGateway,
        submit,
        resume,
        prepare: () =>
          Promise.resolve({
            status: "verifying",
            method: "card",
            priceId: offers[1].id,
            enrollmentId: preparedEnrollment.enrollmentId,
          }),
      });
      yield* click("Elegir mensual");
      yield* Effect.tryPromise(() => screen.findByText("Estamos verificando tu fuente de pago."));
      expect(resume).toHaveBeenCalledTimes(1);
      expect(submit).not.toHaveBeenCalled();
      expect(screen.queryByLabelText("Número de tarjeta")).not.toBeInTheDocument();
    })
  ));
it("requires fresh consent and a fresh authorization after cancellation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const start = vi.fn<EnrollmentGateway["startDaviplata"]>(() =>
        Promise.resolve(challenge(() => Promise.resolve({ status: "retry-allowed" })))
      );
      mount(daviplata(start));
      yield* startDavi();
      yield* Effect.tryPromise(() => screen.findByLabelText("Código de verificación"));
      yield* click("Cancelar autorización");
      yield* click("Preparar una inscripción nueva");
      yield* fill("Número de cédula", "1122233");
      yield* fill("Número de DaviPlata", "3991111111");
      expect(screen.getByRole("button", { name: "Autorizar con DaviPlata" })).toBeDisabled();
      consent();
      yield* click("Autorizar con DaviPlata");
      yield* Effect.tryPromise(() => waitFor(() => expect(start).toHaveBeenCalledTimes(2)));
      expect(start.mock.calls[0]?.[2].signal.aborted).toBe(true);
      expect(start.mock.calls[1]?.[2].signal.aborted).toBe(false);
    })
  ));
it("reports preparation failure and retries without retaining old private fields", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const prepare = vi
        .fn<EnrollmentGateway["prepare"]>()
        .mockRejectedValueOnce(new Error("private provider failure"))
        .mockResolvedValue(preparedEnrollment);
      mount({ ...enrollmentGateway, prepare });
      yield* click("Elegir mensual");
      yield* Effect.tryPromise(() => screen.findByRole("alert"));
      expect(screen.queryByLabelText("CVC")).not.toBeInTheDocument();
      expect(document.body.textContent).not.toContain("private provider failure");
      yield* click("Preparar una inscripción nueva");
      yield* Effect.tryPromise(() => screen.findByLabelText("CVC"));
      expect(prepare).toHaveBeenCalledTimes(2);
    })
  ));
it("aborts pending preparation on unmount and cannot install its late result", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const pending = Promise.withResolvers<Awaited<ReturnType<EnrollmentGateway["prepare"]>>>();
      const prepare = vi.fn<EnrollmentGateway["prepare"]>(() => pending.promise);
      const mounted = mount({ ...enrollmentGateway, prepare });
      yield* click("Elegir mensual");
      yield* Effect.tryPromise(() => waitFor(() => expect(prepare).toHaveBeenCalledTimes(1)));
      mounted.unmount();
      yield* Effect.tryPromise(() =>
        waitFor(() => expect(prepare.mock.calls[0]?.[2]?.aborted).toBe(true))
      );
      pending.resolve(preparedEnrollment);
      yield* Effect.tryPromise(() => pending.promise);
      expect(screen.queryByLabelText("CVC")).not.toBeInTheDocument();
    })
  ));

it("retries failed canonical offers while keeping standing available", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let fail = true;
      mount(enrollmentGateway, (url) =>
        url.endsWith("/offers") && fail ? Response.json({ malformed: true }) : response(url)
      );
      yield* Effect.tryPromise(() => screen.findByText("No pudimos comunicarnos con Fidy"));
      expect(screen.getByText("Tu acceso: Gratis")).toBeVisible();
      fail = false;
      yield* click("Reintentar carga");
      yield* Effect.tryPromise(() => screen.findByRole("button", { name: "Elegir mensual" }));
    })
  ));
it("preserves standing through a failed refresh and can retry", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let fail = false;
      mount(enrollmentGateway, (url) =>
        !url.endsWith("/offers") && fail ? Response.json({ malformed: true }) : response(url)
      );
      yield* Effect.tryPromise(() => screen.findByText("Tu acceso: Gratis"));
      fail = true;
      yield* click("Actualizar estado");
      yield* Effect.tryPromise(() =>
        screen.findByText(
          "No pudimos actualizar tu suscripción. Mostramos el último estado disponible."
        )
      );
      expect(screen.getByText("Tu acceso: Gratis")).toBeVisible();
      fail = false;
      yield* click("Reintentar");
      yield* Effect.tryPromise(() =>
        waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument())
      );
    })
  ));
