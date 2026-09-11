import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { BigDecimal, DateTime, Option, Schema } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { SubscriptionOffersView } from "./feature";
import {
  isAwaitingPaymentStatus,
  paymentStatusRefreshDelay,
  paymentSubmissionIsTerminal,
} from "./payment-status";
import { type PaymentSubmission, makeEnrollmentGateway } from "./enrollment-gateway";
import {
  BillingEmail,
  CardEnrollmentId,
  CardPaymentSubmission,
  PriceId,
  type SubscriptionEnrollmentClient,
} from "@/transport/client";
import type { SubscriptionOffers } from "./presentation";

const renewalTerms = {
  automaticRenewal: true,
  renewalReminder: "none",
  cancellation: "future-renewals-only",
  paidAccessEnds: "paid-period-end",
} as const;
const paymentMethods = ["card", "nequi", "daviplata"] as const;
const offers: SubscriptionOffers = [
  {
    id: PriceId.make("22700000-0000-4000-8000-000000000001"),
    money: { amount: BigDecimal.fromStringUnsafe("9900"), currency: "COP" },
    billingPeriod: "weekly",
    serviceMarket: "CO",
    taxTreatment: "not-taxable",
    renewalTerms,
    paymentMethods,
  },
  {
    id: PriceId.make("22700000-0000-4000-8000-000000000002"),
    money: { amount: BigDecimal.fromStringUnsafe("28900"), currency: "COP" },
    billingPeriod: "monthly",
    serviceMarket: "CO",
    taxTreatment: "not-taxable",
    renewalTerms,
    paymentMethods,
  },
  {
    id: PriceId.make("22700000-0000-4000-8000-000000000003"),
    money: { amount: BigDecimal.fromStringUnsafe("289900"), currency: "COP" },
    billingPeriod: "yearly",
    serviceMarket: "CO",
    taxTreatment: "not-taxable",
    renewalTerms,
    paymentMethods,
  },
];

const sha256HexCharacters = 64;
const preparedEnrollment = {
  status: "prepared" as const,
  enrollmentId: CardEnrollmentId.make("22700000-0000-4000-8000-000000000090"),
  price: offers[1],
  billingEmail: BillingEmail.make("verified@example.com"),
  contracts: {
    endUserPolicy: {
      kind: "end-user-policy" as const,
      permalink: new URL("https://wompi.co/end-user"),
      displayedText: "Acepto el reglamento de Wompi.",
      contentSha256: "a".repeat(sha256HexCharacters),
      providerContentHash: "d".repeat(sha256HexCharacters),
      observedAt: DateTime.makeUnsafe("2026-03-01T00:00:00Z"),
    },
    personalDataAuthorization: {
      kind: "personal-data-authorization" as const,
      permalink: new URL("https://wompi.co/personal-data"),
      displayedText: "Autorizo el tratamiento de datos personales de Wompi.",
      contentSha256: "b".repeat(sha256HexCharacters),
      providerContentHash: "e".repeat(sha256HexCharacters),
      observedAt: DateTime.makeUnsafe("2026-03-01T00:00:00Z"),
    },
  },
  recurringDisclosure: {
    revision: "wompi-card-enrollment-v1" as const,
    displayedText: "Autorizo los cobros recurrentes de mi suscripción.",
    contentSha256: "c".repeat(sha256HexCharacters),
  },
  wompiPublicKey: "pub_test_12345678",
  paymentSourceMode: "create" as const,
  expiresAt: DateTime.makeUnsafe("2026-03-01T00:15:00Z"),
};
const enrollmentGateway = {
  continue: (): Promise<
    Readonly<{
      status: "source-verifying";
      enrollmentId: typeof preparedEnrollment.enrollmentId;
    }>
  > =>
    Promise.resolve({
      status: "source-verifying",
      enrollmentId: preparedEnrollment.enrollmentId,
    }),
  observeBillingAttempt: (): Promise<PaymentSubmission> =>
    Promise.resolve({
      status: "source-verifying",
      enrollmentId: preparedEnrollment.enrollmentId,
    }),
  prepare: (): Promise<typeof preparedEnrollment> => Promise.resolve(preparedEnrollment),
  submit: (): Promise<
    Readonly<{
      status: "source-verifying";
      enrollmentId: typeof preparedEnrollment.enrollmentId;
    }>
  > =>
    Promise.resolve({
      status: "source-verifying",
      enrollmentId: preparedEnrollment.enrollmentId,
    }),
  status: (): Promise<typeof preparedEnrollment> => Promise.resolve(preparedEnrollment),
};

it("uses adaptive payment-status refresh intervals", () => {
  const firstBackoffRefresh = 3;
  const finalBackoffRefresh = 9;
  expect(paymentStatusRefreshDelay(0)).toBe("1 second");
  expect(paymentStatusRefreshDelay(firstBackoffRefresh)).toBe("5 seconds");
  expect(paymentStatusRefreshDelay(finalBackoffRefresh)).toBe("10 seconds");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

it("gives an unauthenticated User a path to browser login", () => {
  render(
    <SubscriptionOffersView gateway={Option.none()} state={{ _tag: "AuthenticationRequired" }} />
  );

  expect(screen.getByRole("link", { name: "Iniciar sesión" })).toHaveAttribute(
    "href",
    "/auth/pair"
  );
});

it("renders loading and load-failure states", () => {
  const { rerender } = render(
    <SubscriptionOffersView gateway={Option.none()} state={{ _tag: "Loading" }} />
  );
  expect(screen.getByRole("region", { name: "Cargando ofertas" })).toBeVisible();

  rerender(<SubscriptionOffersView gateway={Option.none()} state={{ _tag: "LoadFailure" }} />);
  expect(screen.getByText("No pudimos cargar las ofertas")).toBeVisible();
  expect(screen.getByText("Intenta de nuevo en unos momentos.")).toBeVisible();
});

it("shows preparation failures without retaining a stale enrollment", async () => {
  const gateway = {
    ...enrollmentGateway,
    prepare: vi.fn(() => Promise.reject(new Error("provider unavailable"))),
  };
  render(
    <SubscriptionOffersView gateway={Option.some(gateway)} state={{ _tag: "Ready", offers }} />
  );

  fireEvent.click(screen.getByRole("button", { name: "Elegir mensual" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("No pudimos continuar");
  expect(screen.queryByRole("textbox", { name: "Correo de facturación" })).not.toBeInTheDocument();
});

const enrollmentStatuses = ["available", "refused", "expired", "creating", "verifying"] as const;
it.each(enrollmentStatuses)("renders the %s enrollment status action", async (status) => {
  const enrollment =
    status === "refused"
      ? {
          status,
          enrollmentId: preparedEnrollment.enrollmentId,
          priceId: offers[1].id,
          reason: "provider-declined" as const,
        }
      : { status, enrollmentId: preparedEnrollment.enrollmentId, priceId: offers[1].id };
  const gateway = {
    ...enrollmentGateway,
    prepare: vi.fn(() => Promise.resolve(enrollment)),
    status: vi.fn(() => Promise.resolve(enrollment)),
  };
  render(
    <SubscriptionOffersView gateway={Option.some(gateway)} state={{ _tag: "Ready", offers }} />
  );
  fireEvent.click(screen.getByRole("button", { name: "Elegir mensual" }));

  if (status === "available") {
    expect(await screen.findByText(/quedó disponible/iu)).toBeVisible();
  } else if (status === "refused" || status === "expired") {
    const retry = await screen.findByRole("button", { name: "Preparar una inscripción nueva" });
    expect(screen.getByRole("alert")).toBeVisible();
    fireEvent.click(retry);
    expect(gateway.prepare).toHaveBeenCalledTimes(2);
  } else {
    const refresh = await screen.findByRole("button", { name: "Consultar estado" });
    fireEvent.click(refresh);
    expect(gateway.status).toHaveBeenCalledWith(preparedEnrollment.enrollmentId);
  }
});

it("shows shared renewal terms once without ambiguous payment-method pills", () => {
  render(<SubscriptionOffersView gateway={Option.none()} state={{ _tag: "Ready", offers }} />);

  expect(screen.getByRole("heading", { name: "Mejora tu suscripción" })).toBeVisible();
  expect(screen.getByText("COP 9.900,00/semana")).toBeVisible();
  expect(screen.getByText("COP 28.900,00/mes")).toBeVisible();
  expect(screen.getByText("COP 289.900,00/año")).toBeVisible();
  expect(screen.queryByText(/Elige la frecuencia que prefieras/iu)).not.toBeInTheDocument();
  const terms = within(screen.getByRole("region", { name: "Condiciones de suscripción" }));
  expect(terms.getByText(/se renueva automáticamente/iu)).toBeVisible();
  expect(terms.getByText(/conservarás el acceso hasta terminar el período pagado/iu)).toBeVisible();
  expect(screen.queryByText(/no enviaremos un recordatorio/iu)).not.toBeInTheDocument();
  expect(screen.queryByText(/Precio final|No se cobra IVA/iu)).not.toBeInTheDocument();
  expect(screen.queryByText(/Colombia · Cobro/iu)).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Métodos de pago" })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Elegir mensual" }));

  expect(screen.getByRole("button", { name: "Oferta mensual seleccionada" })).toBeVisible();
  expect(screen.queryByText(/Tarjeta|Nequi|DaviPlata/u)).not.toBeInTheDocument();
});

it("shows the card form with only Wompi's required checks and constrained fields", async () => {
  render(
    <SubscriptionOffersView
      gateway={Option.some(enrollmentGateway)}
      state={{ _tag: "Ready", offers }}
    />
  );
  fireEvent.click(screen.getByRole("button", { name: "Elegir mensual" }));

  const email = await screen.findByRole("textbox", { name: "Correo de facturación" });
  expect(email).toHaveValue("verified@example.com");
  expect(screen.queryByRole("button", { name: "Inscribir tarjeta" })).not.toBeInTheDocument();
  expect(screen.queryByText(/Datos de la tarjeta Visa o Mastercard/u)).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "reglamento" })).toHaveAttribute(
    "href",
    "https://wompi.co/end-user"
  );
  expect(screen.getByRole("link", { name: "tratamiento de datos personales" })).toHaveAttribute(
    "href",
    "https://wompi.co/personal-data"
  );
  expect(screen.queryByText(/wompi\.com\/assets/u)).not.toBeInTheDocument();
  expect(screen.queryByText(/Autorizo a Fidy a cobrar automáticamente/u)).not.toBeInTheDocument();
  expect(screen.queryByText(/cobros recurrentes de mi suscripción/iu)).not.toBeInTheDocument();
  expect(screen.getAllByRole("checkbox")).toHaveLength(2);

  fireEvent.change(screen.getByLabelText("Vencimiento"), {
    target: { value: "12x2030" },
  });
  fireEvent.change(screen.getByLabelText("CVC"), { target: { value: "1b2" } });
  fireEvent.change(screen.getByLabelText("Nombre en la tarjeta"), {
    target: { value: "Ana123 López!" },
  });
  expect(screen.getByLabelText("Vencimiento")).toHaveValue("12/2030");
  expect(screen.queryByLabelText("Mes de vencimiento")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Año de vencimiento")).not.toBeInTheDocument();
  expect(screen.getByLabelText("CVC")).toHaveValue("12");
  expect(screen.getByLabelText("Nombre en la tarjeta")).toHaveValue("Ana López");

  fireEvent.change(email, { target: { value: "billing@example.net" } });
  expect(email).toHaveValue("billing@example.net");
  const save = screen.getByRole("button", { name: "Activar Pro" });
  expect(save).toBeDisabled();
  for (const checkbox of screen.getAllByRole("checkbox")) fireEvent.click(checkbox);
  expect(save).toBeEnabled();
  expect(screen.getByText(/Fidy conservará este correo.*cobros automáticos/iu)).toBeVisible();
});

it("disables Activar Pro immediately until submission handling completes", async () => {
  let visibilityState: DocumentVisibilityState = "hidden";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibilityState);
  const pending = Promise.withResolvers<PaymentSubmission>();
  const continuePayment = vi.fn(() =>
    Promise.resolve<PaymentSubmission>({
      status: "refused",
      enrollmentId: preparedEnrollment.enrollmentId,
      reason: "provider-declined",
    })
  );
  const gateway = {
    ...enrollmentGateway,
    continue: continuePayment,
    submit: vi.fn(() => pending.promise),
  };
  render(
    <SubscriptionOffersView gateway={Option.some(gateway)} state={{ _tag: "Ready", offers }} />
  );
  fireEvent.click(screen.getByRole("button", { name: "Elegir mensual" }));
  await screen.findByRole("textbox", { name: "Correo de facturación" });
  fireEvent.change(screen.getByLabelText("Número de tarjeta"), {
    target: { value: "4111111111111111" },
  });
  fireEvent.change(screen.getByLabelText("Vencimiento"), { target: { value: "12/2030" } });
  fireEvent.change(screen.getByLabelText("CVC"), { target: { value: "123" } });
  fireEvent.change(screen.getByLabelText("Nombre en la tarjeta"), {
    target: { value: "Ana López" },
  });
  for (const checkbox of screen.getAllByRole("checkbox")) fireEvent.click(checkbox);
  fireEvent.click(screen.getByRole("button", { name: "Activar Pro" }));
  expect(await screen.findByRole("button", { name: "Activando Pro…" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Oferta mensual seleccionada" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Elegir semanal" })).toBeDisabled();
  pending.resolve({
    status: "source-verifying",
    enrollmentId: preparedEnrollment.enrollmentId,
  });
  expect(await screen.findByText("Estamos verificando tu fuente de pago.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Activando Pro…" })).toBeDisabled();
  expect(screen.getByLabelText("Número de tarjeta")).toBeDisabled();

  await act(async () => {
    visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
  });
  expect(continuePayment).toHaveBeenCalledWith(
    preparedEnrollment.enrollmentId,
    "verified@example.com"
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "No pudimos iniciar el pago. Puedes intentarlo de nuevo."
  );
});

type BillingAttemptFixture = Readonly<{
  id: string;
  priceId: (typeof offers)[number]["id"];
  money: Readonly<{ amount: string; currency: "COP" }>;
  billingPeriod: (typeof offers)[number]["billingPeriod"];
  serviceMarket: (typeof offers)[number]["serviceMarket"];
  taxTreatment: (typeof offers)[number]["taxTreatment"];
  timeZone: string;
  createdAt: string;
  status: "pending" | "failed" | "succeeded";
  failedAt: Option.Option<string>;
  finalizedAt: Option.Option<string>;
  paidPeriodEndsAt: Option.Option<string>;
  renewalAnchor: Option.Option<string>;
}>;

const defaultBillingAttemptFixture: BillingAttemptFixture = {
  id: "22700000-0000-4000-8000-000000000091",
  priceId: offers[1].id,
  money: { amount: "28900", currency: "COP" },
  billingPeriod: offers[1].billingPeriod,
  serviceMarket: offers[1].serviceMarket,
  taxTreatment: offers[1].taxTreatment,
  timeZone: "America/Bogota",
  createdAt: "2026-03-01T00:00:00Z",
  status: "pending",
  failedAt: Option.none(),
  finalizedAt: Option.none(),
  paidPeriodEndsAt: Option.none(),
  renewalAnchor: Option.none(),
};

const paymentSubmissionFixture = (
  billingAttemptOverrides: Partial<BillingAttemptFixture> = {}
): Extract<PaymentSubmission, { status: "payment-pending" }> => {
  const fixture = { ...defaultBillingAttemptFixture, ...billingAttemptOverrides };
  const commonBillingAttempt = {
    id: fixture.id,
    priceId: fixture.priceId,
    money: fixture.money,
    billingPeriod: fixture.billingPeriod,
    serviceMarket: fixture.serviceMarket,
    taxTreatment: fixture.taxTreatment,
    timeZone: fixture.timeZone,
    createdAt: fixture.createdAt,
  };
  let submission: PaymentSubmission;
  if (fixture.status === "succeeded") {
    submission = Schema.decodeSync(CardPaymentSubmission)({
      status: "payment-pending",
      enrollmentId: preparedEnrollment.enrollmentId,
      billingAttempt: {
        ...commonBillingAttempt,
        status: "succeeded",
        finalizedAt: Option.getOrElse(fixture.finalizedAt, () => "2026-03-01T00:01:00Z"),
        paidPeriodEndsAt: Option.getOrElse(fixture.paidPeriodEndsAt, () => "2026-04-01T00:01:00Z"),
        renewalAnchor: Option.getOrElse(fixture.renewalAnchor, () => "2026-04-01T00:01:00Z"),
      },
    });
  } else if (fixture.status === "failed") {
    submission = Schema.decodeSync(CardPaymentSubmission)({
      status: "payment-pending",
      enrollmentId: preparedEnrollment.enrollmentId,
      billingAttempt: {
        ...commonBillingAttempt,
        status: "failed",
        failedAt: Option.getOrElse(fixture.failedAt, () => "2026-03-01T00:01:00Z"),
      },
    });
  } else {
    submission = Schema.decodeSync(CardPaymentSubmission)({
      status: "payment-pending",
      enrollmentId: preparedEnrollment.enrollmentId,
      billingAttempt: { ...commonBillingAttempt, status: "pending" },
    });
  }
  if (submission.status !== "payment-pending") {
    throw new Error("payment submission fixture did not decode");
  }
  return submission;
};

it("refreshes only nonterminal payment submissions", () => {
  expect(
    isAwaitingPaymentStatus({
      status: "source-verifying",
      enrollmentId: preparedEnrollment.enrollmentId,
    })
  ).toBe(true);
  expect(isAwaitingPaymentStatus(paymentSubmissionFixture())).toBe(true);
  expect(isAwaitingPaymentStatus(paymentSubmissionFixture({ status: "succeeded" }))).toBe(false);
  expect(
    isAwaitingPaymentStatus({
      status: "refused",
      enrollmentId: preparedEnrollment.enrollmentId,
      reason: "provider-declined",
    })
  ).toBe(false);
});

it("releases retained payment requests only for terminal submissions", () => {
  const pending = paymentSubmissionFixture();
  const succeeded = paymentSubmissionFixture({ status: "succeeded" });
  expect(paymentSubmissionIsTerminal(pending)).toBe(false);
  expect(paymentSubmissionIsTerminal(succeeded)).toBe(true);
  expect(
    paymentSubmissionIsTerminal({
      status: "source-verifying",
      enrollmentId: preparedEnrollment.enrollmentId,
    })
  ).toBe(false);
  expect(
    paymentSubmissionIsTerminal({
      status: "refused",
      enrollmentId: preparedEnrollment.enrollmentId,
      reason: "provider-declined",
    })
  ).toBe(true);
});

it("automatically refreshes a visible pending payment without resubmitting it", async () => {
  let visibilityState: DocumentVisibilityState = "hidden";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibilityState);
  const reuseEnrollment = { ...preparedEnrollment, paymentSourceMode: "reuse" as const };
  const pendingSubmission = paymentSubmissionFixture();
  const succeededSubmission = paymentSubmissionFixture({ status: "succeeded" });
  const submit = vi.fn(() => Promise.resolve(pendingSubmission));
  const continuePayment = vi.fn(enrollmentGateway.continue);
  const observePayment = vi.fn(() => Promise.resolve(succeededSubmission));
  const gateway = {
    ...enrollmentGateway,
    prepare: (): Promise<typeof reuseEnrollment> => Promise.resolve(reuseEnrollment),
    submit,
    continue: continuePayment,
    observeBillingAttempt: observePayment,
  };
  render(
    <SubscriptionOffersView gateway={Option.some(gateway)} state={{ _tag: "Ready", offers }} />
  );
  fireEvent.click(screen.getByRole("button", { name: "Elegir mensual" }));
  await act(async () => Promise.resolve());
  expect(screen.getByRole("textbox", { name: "Correo de facturación" })).toBeVisible();
  for (const checkbox of screen.getAllByRole("checkbox")) fireEvent.click(checkbox);
  fireEvent.click(screen.getByRole("button", { name: "Activar Pro" }));
  await act(async () => Promise.resolve());

  expect(screen.queryByText(/Esperando confirmación de Wompi/iu)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Activando Pro…" })).toBeDisabled();
  expect(screen.getByRole("textbox", { name: "Correo de facturación" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Consultar estado" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Oferta mensual seleccionada" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Elegir semanal" })).toBeDisabled();
  expect(observePayment).not.toHaveBeenCalled();

  await act(async () => {
    visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
  });

  expect(observePayment).toHaveBeenCalledWith(
    preparedEnrollment.enrollmentId,
    pendingSubmission.billingAttempt.id
  );
  expect(continuePayment).not.toHaveBeenCalled();
  expect(submit).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Tu pago fue realizado y tu suscripción está activa.")).toBeVisible();
  expect(screen.queryByRole("textbox", { name: "Correo de facturación" })).not.toBeInTheDocument();
});

it.each([
  {
    name: "provider refusal",
    submission: {
      status: "refused" as const,
      enrollmentId: preparedEnrollment.enrollmentId,
      reason: "provider-declined" as const,
    },
    message: "No pudimos iniciar el pago. Puedes intentarlo de nuevo.",
  },
  {
    name: "failed BillingAttempt",
    submission: paymentSubmissionFixture({ status: "failed" }),
    message: "Wompi rechazó el pago. Puedes intentarlo de nuevo.",
  },
])("replaces the form after $name", async ({ submission, message }) => {
  const reuseEnrollment = { ...preparedEnrollment, paymentSourceMode: "reuse" as const };
  const gateway = {
    ...enrollmentGateway,
    prepare: (): Promise<typeof reuseEnrollment> => Promise.resolve(reuseEnrollment),
    submit: (): Promise<PaymentSubmission> => Promise.resolve(submission),
  };
  render(
    <SubscriptionOffersView gateway={Option.some(gateway)} state={{ _tag: "Ready", offers }} />
  );
  fireEvent.click(screen.getByRole("button", { name: "Elegir mensual" }));
  await screen.findByText(/fuente de pago guardada/iu);
  for (const checkbox of screen.getAllByRole("checkbox")) fireEvent.click(checkbox);
  fireEvent.click(screen.getByRole("button", { name: "Activar Pro" }));

  expect(await screen.findByRole("alert")).toHaveTextContent(message);
  expect(screen.queryByRole("textbox", { name: "Correo de facturación" })).not.toBeInTheDocument();
});

it("submits normalized billing data and card fields after both Wompi checks", async () => {
  const submit = vi.fn(enrollmentGateway.submit);
  const gateway = { ...enrollmentGateway, submit };
  render(
    <SubscriptionOffersView gateway={Option.some(gateway)} state={{ _tag: "Ready", offers }} />
  );
  fireEvent.click(screen.getByRole("button", { name: "Elegir mensual" }));

  const email = await screen.findByRole("textbox", { name: "Correo de facturación" });
  fireEvent.change(screen.getByLabelText("Número de tarjeta"), {
    target: { value: "4111 1111 1111 1111" },
  });
  fireEvent.change(screen.getByLabelText("Vencimiento"), { target: { value: "1" } });
  expect(screen.getByLabelText("Vencimiento")).toHaveValue("1");
  fireEvent.change(screen.getByLabelText("Vencimiento"), { target: { value: "12/2030" } });
  fireEvent.change(screen.getByLabelText("CVC"), { target: { value: "123" } });
  fireEvent.change(screen.getByLabelText("Nombre en la tarjeta"), {
    target: { value: "Ana López" },
  });
  fireEvent.change(email, { target: { value: " BILLING@Example.NET " } });
  for (const checkbox of screen.getAllByRole("checkbox")) fireEvent.click(checkbox);
  fireEvent.click(screen.getByRole("button", { name: "Activar Pro" }));

  await vi.waitFor(() => {
    expect(submit).toHaveBeenCalledWith(preparedEnrollment, "billing@example.net", {
      number: "4111111111111111",
      expirationMonth: "12",
      expirationYear: "2030",
      cvc: "123",
      cardholderName: "Ana López",
    });
  });
});

it("derives enrollment operations from the browser enrollment client", async () => {
  const transportFailure = new Error("transport unavailable");
  const service: SubscriptionEnrollmentClient = {
    execute: () => Promise.reject(transportFailure),
  };
  const gateway = makeEnrollmentGateway(service);
  const reuseEnrollment = { ...preparedEnrollment, paymentSourceMode: "reuse" as const };

  await expect(gateway.prepare(offers[1].id)).rejects.toBe(transportFailure);
  await expect(gateway.status(preparedEnrollment.enrollmentId)).rejects.toBe(transportFailure);
  await expect(gateway.submit(reuseEnrollment, "payer@example.com")).rejects.toBe(transportFailure);
  const retainedRequestId = sessionStorage.getItem(
    `fidy.payment-request.${reuseEnrollment.enrollmentId}`
  );
  expect(retainedRequestId).not.toBeNull();
  const refreshedGateway = makeEnrollmentGateway(service);
  await expect(refreshedGateway.submit(reuseEnrollment, "payer@example.com")).rejects.toBe(
    transportFailure
  );
  expect(sessionStorage.getItem(`fidy.payment-request.${reuseEnrollment.enrollmentId}`)).toBe(
    retainedRequestId
  );
  await expect(gateway.submit(preparedEnrollment, "payer@example.com")).rejects.toBeDefined();

  vi.stubGlobal(
    "fetch",
    vi.fn((): Promise<Response> =>
      Promise.resolve(Response.json({ data: { id: "tok_browser_only", brand: "VISA" } }))
    )
  );
  await expect(
    gateway.submit(preparedEnrollment, "payer@example.com", {
      number: "4111111111111111",
      expirationMonth: "12",
      expirationYear: "2030",
      cvc: "123",
      cardholderName: "Ana López",
    })
  ).rejects.toBeDefined();
});

it("reuses a saved payment source without asking for card fields", async () => {
  const reuseEnrollment = { ...preparedEnrollment, paymentSourceMode: "reuse" as const };
  const submit = vi.fn(enrollmentGateway.submit);
  const gateway = {
    ...enrollmentGateway,
    prepare: (): Promise<typeof reuseEnrollment> => Promise.resolve(reuseEnrollment),
    submit,
  };
  render(
    <SubscriptionOffersView gateway={Option.some(gateway)} state={{ _tag: "Ready", offers }} />
  );
  fireEvent.click(screen.getByRole("button", { name: "Elegir mensual" }));

  expect(await screen.findByText(/fuente de pago guardada/iu)).toBeVisible();
  expect(screen.queryByLabelText("Número de tarjeta")).not.toBeInTheDocument();
  for (const checkbox of screen.getAllByRole("checkbox")) fireEvent.click(checkbox);
  fireEvent.click(screen.getByRole("button", { name: "Activar Pro" }));

  await vi.waitFor(() => {
    expect(submit).toHaveBeenCalledWith(reuseEnrollment, "verified@example.com", undefined);
  });
});
