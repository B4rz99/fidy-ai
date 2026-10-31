import type { JSX } from "react";

const introductions = {
  nequi: {
    heading: "Antes de autorizar",
    description: "Ingresa la información para continuar con la suscripción.",
  },
  daviplata: {
    heading: "Datos de autorización",
    description:
      "Completa tus datos para continuar con la autorización en DaviPlata a través de Wompi.",
  },
};
export const SubscriptionIntroduction = ({
  method,
}: Readonly<{ method: keyof typeof introductions }>): JSX.Element => (
  <div>
    <h3 className="subscription-form-heading">{introductions[method].heading}</h3>
    <p className="subscription-form-description">{introductions[method].description}</p>
  </div>
);
