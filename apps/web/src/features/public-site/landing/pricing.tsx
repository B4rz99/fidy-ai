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
            <p>{"Todo Fidy Pro. Paga por semana, mes o año."}</p>
            <ul>
              <li>{"Conversa con tu asistente de finanzas."}</li>
              <li>{"Organiza y consulta tus transacciones."}</li>
              <li>{"Sigue tus presupuestos por categoría."}</li>
              <li>{"Consulta tus cifras en la web app."}</li>
            </ul>
          </div>
          <div className="price-card">
            <h3>{"Fidy Pro"}</h3>
            <fieldset className="price-options" aria-label="Periodicidad de cobro">
              {prices.map((option) => (
                <button
                  key={option.period}
                  aria-pressed={option.period === price.period}
                  onClick={() => setPrice(option)}
                >
                  {option.label}
                </button>
              ))}
            </fieldset>
            <div className="price-value" aria-live="polite">
              <strong data-price-amount="">{price.amount}</strong>
              <span>
                {" COP / "}
                <span data-price-period="">{price.period}</span>
              </span>
            </div>
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
