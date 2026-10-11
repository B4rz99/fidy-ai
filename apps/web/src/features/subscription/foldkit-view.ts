import { Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import { formatMoney } from "@/transport/money";
import { buttonVariants } from "@/ui/button-variants";
import { Message, type Model } from "./model";
import { type InputMount, otpFieldsView, paymentFieldsView } from "./payment-fields-view";
import type { PaymentAction, PaymentMethod, PaymentStage } from "./payment-model";
import { presentSubscriptionOffer } from "./presentation";

type Builder = HtmlBuilder<Message>;
const paymentCopy: Readonly<
  Record<PaymentMethod, Readonly<{ label: string; title: string; privateFields: string }>>
> = {
  card: { label: "Tarjeta", title: "Pago con tarjeta", privateFields: "Los datos de tu tarjeta" },
  nequi: { label: "Nequi", title: "Pago con Nequi", privateFields: "Tu número de Nequi" },
  daviplata: {
    label: "DaviPlata",
    title: "Pago con DaviPlata",
    privateFields: "Tu documento, número de DaviPlata y código",
  },
};
const stageCopy: Readonly<Record<PaymentStage, string>> = {
  Idle: "",
  Preparing: "Cargando formulario…",
  Fields: "",
  Submitting: "",
  AwaitingNequi: "",
  SendingOtp: "Solicitando código a Wompi…",
  Otp: "",
  Confirming: "",
  RetrySubmission: "No pudimos confirmar el resultado. No vuelvas a iniciar la autorización.",
  RetryingSubmission: "Enviando la autorización ya aprobada…",
  Uncertain: "No pudimos confirmar el resultado. No vuelvas a iniciar la autorización.",
  Refused:
    "No pudimos continuar la autorización o iniciar el pago. La autorización pudo vencer o alcanzar su límite.",
  Available: "Tu fuente de pago quedó disponible para cobros recurrentes.",
  Expired: "La inscripción venció.",
  Creating: "Creando tu fuente de pago…",
  Verifying: "Estamos verificando el resultado. No vuelvas a enviar los datos.",
  SourceVerifying: "Estamos verificando tu fuente de pago.",
  PaymentPending: "Estamos verificando tu pago.",
  PaymentSucceeded: "Tu pago fue realizado y tu suscripción está activa.",
  PaymentFailed: "Wompi rechazó el pago. Puedes intentarlo de nuevo.",
};
const actionButton = (
  configuration: Readonly<{
    html: Builder;
    action: PaymentAction;
    label: string;
    disabled: boolean;
  }>
): Html => {
  const { html, action, label, disabled } = configuration;
  return html.button(
    [
      html.Type("button"),
      html.Class(buttonVariants({ variant: "outline" })),
      html.Disabled(disabled),
      html.OnClick(Message.RequestedPayment({ action })),
    ],
    [label]
  );
};
const paymentActions = (model: Model, html: Builder): ReadonlyArray<Html> => {
  const { stage, busy, locked } = model.payment;
  const buttons: Html[] = [];
  if (["SendingOtp", "Otp", "Confirming"].includes(stage)) {
    buttons.push(
      actionButton({ html, action: "Cancel", label: "Cancelar autorización", disabled: false })
    );
  }
  if (stage === "RetrySubmission") {
    buttons.push(
      actionButton({
        html,
        action: "RetrySubmission",
        label: "Reintentar envío de la autorización aprobada",
        disabled: busy,
      })
    );
  }
  if (["Refused", "Expired", "Idle"].includes(stage) && !locked) {
    buttons.push(
      actionButton({
        html,
        action: "Prepare",
        label: "Preparar una inscripción nueva",
        disabled: busy,
      })
    );
  }
  if (["Creating", "Verifying"].includes(stage)) {
    buttons.push(
      actionButton({ html, action: "Refresh", label: "Consultar estado", disabled: busy })
    );
  }
  return buttons;
};
const paymentDetails = (
  configuration: Readonly<{ model: Model; html: Builder; mount: InputMount }>
): Html => {
  const { model, html } = configuration;
  const { stage, method, failed } = model.payment;
  const copy = paymentCopy[method];
  return html.section(
    [html.AriaLabel(copy.title), html.Class("flex flex-col gap-5 rounded-xl border p-6")],
    [
      html.h2([html.Class("text-xl font-semibold")], [copy.title]),
      failed
        ? html.p(
            [html.Role("alert")],
            ["No pudimos continuar. Revisa los datos o intenta más tarde."]
          )
        : null,
      ["Fields", "Submitting", "AwaitingNequi"].includes(stage)
        ? paymentFieldsView(configuration)
        : null,
      ["Otp", "Confirming"].includes(stage) ? otpFieldsView(configuration) : null,
      stageCopy[stage].length > 0
        ? html.output([html.AriaLive("polite")], [stageCopy[stage]])
        : null,
      ...paymentActions(model, html),
      method === "daviplata"
        ? html.p(
            [html.Class("text-sm text-muted-foreground")],
            [
              "No cierres ni recargues esta página: el código y la autorización no pueden recuperarse al volver. Fidy nunca conserva tu documento, número de DaviPlata ni código.",
            ]
          )
        : null,
      html.p(
        [html.Class("text-sm text-muted-foreground")],
        [
          `${copy.privateFields} viajan directamente desde este navegador a Wompi. Fidy no los recibe ni los conserva.`,
        ]
      ),
    ]
  );
};
const offerButton = (
  configuration: Readonly<{
    model: Model;
    html: Builder;
    disabled: boolean;
    offer: ReturnType<typeof presentSubscriptionOffer>;
  }>
): Html => {
  const { model, html, disabled, offer } = configuration;
  const selected = Option.contains(model.selected, offer.id);
  return html.button(
    [
      html.Type("button"),
      html.Class(buttonVariants({ variant: selected ? "secondary" : "default" })),
      html.AriaPressed(String(selected)),
      html.AriaLabel(
        selected ? `Oferta ${offer.selectionLabel} seleccionada` : `Elegir ${offer.selectionLabel}`
      ),
      html.Disabled(disabled),
      html.OnClick(Message.SelectedPrice({ price: offer.id })),
    ],
    [`${offer.moneyText}/${offer.billingUnit}`]
  );
};
const renewalTerms = (
  html: Builder,
  presented: ReadonlyArray<ReturnType<typeof presentSubscriptionOffer>>
): Html =>
  html.section(
    [html.AriaLabel("Condiciones de suscripción"), html.Class("flex flex-col gap-2")],
    [
      html.p([], [presented[0]?.renewalText ?? ""]),
      html.p([], [presented[0]?.cancellationText ?? ""]),
    ]
  );
const offersFeedback = (model: Model): string => {
  if (model.offersStatus === "Loading") return "Cargando ofertas…";
  return model.offersBoundaryFailure
    ? "No pudimos comunicarnos con Fidy"
    : "No pudimos cargar las ofertas";
};
const offers = (model: Model, html: Builder): ReadonlyArray<Html> => {
  if (Option.isNone(model.offers)) {
    return [html.output([], [offersFeedback(model)])];
  }
  const presented = model.offers.value.map(presentSubscriptionOffer);
  const disabled = model.payment.busy || model.payment.locked || model.offersStatus !== "Ready";
  return [
    renewalTerms(html, presented),
    html.section(
      [html.AriaLabel("Método de pago"), html.Class("flex gap-2")],
      model.enabledMethods.map((method) =>
        html.button(
          [
            html.Type("button"),
            html.Class(buttonVariants()),
            html.AriaPressed(String(model.payment.method === method)),
            html.Disabled(disabled),
            html.OnClick(Message.SelectedMethod({ method })),
          ],
          [paymentCopy[method].label]
        )
      )
    ),
    html.section(
      [html.AriaLabel("Ofertas de suscripción"), html.Class("grid gap-4 lg:grid-cols-3")],
      presented.map((offer) => offerButton({ model, html, disabled, offer }))
    ),
  ];
};
const standingDate = new Intl.DateTimeFormat("es-CO", {
  dateStyle: "long",
  timeZone: "America/Bogota",
});
const billingLabels = { pending: "pendiente", succeeded: "aprobado", failed: "fallido" } as const;
const standing = (model: Model, html: Builder): Html => {
  const retry = html.button(
    [
      html.Type("button"),
      html.Class(buttonVariants({ variant: "outline" })),
      html.Disabled(model.standingStatus === "Loading"),
      html.OnClick(Message.RefreshStanding()),
    ],
    [model.standingStatus === "Failed" ? "Reintentar" : "Actualizar estado"]
  );
  if (Option.isNone(model.standing)) {
    return html.section(
      [html.AriaLabel("Estado de la suscripción")],
      [
        html.output(
          [],
          [
            model.standingStatus === "Loading"
              ? "Consultando suscripción…"
              : "No pudimos consultar tu suscripción. Tus datos siguen disponibles.",
          ]
        ),
        retry,
      ]
    );
  }
  return standingDetails(model, html, retry);
};
const standingDetails = (model: Model, html: Builder, retry: Html): Html => {
  const { accessTier, paidSubscription, trialPeriod, recentAttempts } = Option.getOrThrow(
    model.standing
  );
  const paid = Option.isSome(paidSubscription);
  const periodEnd = paid ? paidSubscription.value.endsAt : trialPeriod.endsAt;
  return html.section(
    [
      html.AriaLabel("Estado de la suscripción"),
      html.Class("flex flex-col gap-3 rounded-xl border p-6"),
    ],
    [
      html.h2([], [`Tu acceso: ${accessTier === "pro" ? "Pro" : "Gratis"}`]),
      html.p(
        [],
        [
          `${paid ? "Último período pagado" : "Período de prueba"}: hasta el ${standingDate.format(periodEnd.epochMilliseconds)}.`,
        ]
      ),
      paid
        ? html.p(
            [],
            [
              `Precio cobrado: ${formatMoney({ locale: "es-CO", money: paidSubscription.value.money })}.`,
            ]
          )
        : null,
      recentAttempts[0] !== undefined
        ? html.p([], [`Último intento de cobro: ${billingLabels[recentAttempts[0].status]}.`])
        : null,
      model.standingStatus === "Failed"
        ? html.p(
            [html.Role("alert")],
            ["No pudimos actualizar tu suscripción. Mostramos el último estado disponible."]
          )
        : null,
      html.p(
        [],
        [
          "Tu historial permanece disponible aunque termine el acceso Pro. Las cuotas no son un bloqueo de suscripción.",
        ]
      ),
      retry,
    ]
  );
};
export const subscriptionView = (
  configuration: Readonly<{ model: Model; html: Builder; mount: InputMount }>
): Html => {
  const { model, html } = configuration;
  return html.main(
    [html.Class("mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8")],
    [
      standing(model, html),
      html.header(
        [],
        [
          html.p([], ["Fidy Pro"]),
          html.h1([html.Class("text-3xl font-semibold")], ["Mejora tu suscripción"]),
        ]
      ),
      model.offersStatus === "Failed" && Option.isSome(model.offers)
        ? html.p(
            [html.Role("alert")],
            ["No pudimos actualizar las ofertas. Mostramos las últimas ofertas disponibles."]
          )
        : null,
      ...offers(model, html),
      model.offersStatus === "Failed"
        ? html.button(
            [
              html.Type("button"),
              html.Class(buttonVariants()),
              html.OnClick(Message.RefreshOffers()),
            ],
            ["Reintentar carga"]
          )
        : null,
      Option.isSome(model.selected) ? paymentDetails(configuration) : null,
    ]
  );
};
