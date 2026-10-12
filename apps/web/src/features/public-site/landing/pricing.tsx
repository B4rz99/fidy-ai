import { useState } from "react";
import { LaunchButton } from "./registration";

const prices = [
  {
    label: "Semanal",
    amount: "$9.900",
    period: "semana",
  },
  { label: "Mensual", amount: "$28.900", period: "mes" },
  { label: "Anual", amount: "$289.900", period: "año" },
] as const;
export const Pricing = (): React.JSX.Element => {
  const [price, setPrice] = useState<(typeof prices)[number]>(prices[1]);
  const [instant, setInstant] = useState(false);
  return (
    <>
      {" "}
      <section className="section peach" id="precios">
        <div className="wrap pricing-layout">
          <div className="pricing-copy">
            <h2>
              {"Más claridad."} <br />
              {"A tu ritmo."}
            </h2>
            <p>
              {
                "Prueba Fidy Pro 7 días sin tarjeta. Después, elige un plan semanal, mensual o anual."
              }
            </p>
            <ul>
              <li>{"Conversa con tu asistente de finanzas."}</li>
              <li>{"Organiza y consulta tus transacciones."}</li>
              <li>{"Sigue tus presupuestos por categoría."}</li>
              <li>{"Consulta tus cifras en la web app."}</li>
            </ul>
          </div>
          <div className="price-card" data-instant={instant}>
            <h3>{"Fidy Pro"}</h3>
            <fieldset className="price-options" aria-label="Periodicidad de cobro">
              {prices.map((option) => (
                <button
                  key={option.period}
                  aria-pressed={option.period === price.period}
                  onClick={(event) => {
                    setInstant(event.detail === 0);
                    setPrice(option);
                  }}
                >
                  {option.label}
                </button>
              ))}
            </fieldset>
            <PriceValue price={price} />
            <LaunchButton dark={false} arrow />
            <p className="price-terms">
              {
                "Renovación automática. Puedes cancelar futuras renovaciones y conservar el acceso hasta terminar el período pagado."
              }
            </p>
          </div>
        </div>
      </section>{" "}
    </>
  );
};

const PriceValue = ({ price }: { price: (typeof prices)[number] }): React.JSX.Element => (
  <div className="price-value" aria-live="polite">
    {prices.map((option) => (
      <div
        className="price-frame"
        key={option.period}
        data-visible={option.period === price.period}
        aria-hidden={option.period !== price.period}
      >
        <strong data-price-amount="">{option.amount}</strong>
        <span>
          {" COP / "}
          <span data-price-period="">{option.period}</span>
        </span>
      </div>
    ))}
  </div>
);
