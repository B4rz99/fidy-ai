import { useState } from "react";

type CorrectionStageName = "original" | "corrected";

type CorrectionStage = Readonly<{
  row: string;
  amount: string;
  action: string;
  status: string;
  next: CorrectionStageName;
}>;

const correctionStages: Readonly<Record<CorrectionStageName, CorrectionStage>> = {
  original: {
    row: "− $28.000",
    amount: "$28.000 COP",
    action: "Probar una corrección",
    status: "Ejemplo: el monto correcto era $26.000.",
    next: "corrected",
  },
  corrected: {
    row: "− $26.000",
    amount: "$26.000 COP",
    action: "Reiniciar ejemplo",
    status: "Monto corregido en este ejemplo. Es la misma transacción.",
    next: "original",
  },
};

export const CorrectionDemo = (): React.JSX.Element => {
  const [stage, setStage] = useState<CorrectionStageName>("original");
  const correction = correctionStages[stage];

  return (
    <>
      {" "}
      <div className="detail-ledger">
        <div className="detail-app-title">
          <b>{"Transacciones"}</b>
          <span>{"Octubre · COP"}</span>
        </div>
        <div className="detail-ledger-grid">
          <div>
            <div className="detail-table-head">
              <span>{"Transacción"}</span>
              <span>{"Fecha"}</span>
              <span>{"Valor"}</span>
            </div>
            <div className="detail-table-row is-selected">
              <span>
                <b>{"Crepes"}</b>
                <small>{"Restaurantes"}</small>
              </span>
              <span>{"04 oct"}</span>
              <strong>{correction.row}</strong>
            </div>
            <div className="detail-table-row ">
              <span>
                <b>{"Mercado"}</b>
                <small>{"Mercado"}</small>
              </span>
              <span>{"03 oct"}</span>
              <strong>{"− $156.000"}</strong>
            </div>
            <div className="detail-table-row ">
              <span>
                <b>{"Transporte"}</b>
                <small>{"Transporte"}</small>
              </span>
              <span>{"03 oct"}</span>
              <strong>{"− $12.000"}</strong>
            </div>
            <div className="detail-table-row ">
              <span>
                <b>{"Café"}</b>
                <small>{"Restaurantes"}</small>
              </span>
              <span>{"02 oct"}</span>
              <strong>{"− $8.500"}</strong>
            </div>
          </div>
          <CorrectionInspector
            correction={correction}
            onCorrect={() => setStage(correction.next)}
          />
        </div>
      </div>{" "}
    </>
  );
};

const CorrectionInspector = ({
  correction,
  onCorrect,
}: {
  correction: CorrectionStage;
  onCorrect: () => void;
}): React.JSX.Element => (
  <aside className="detail-inspector">
    <span>{"Detalle de transacción"}</span>
    <h3>{"Crepes"}</h3>
    <dl>
      <dt>{"Monto"}</dt>
      <dd data-correction-amount="">{correction.amount}</dd>
      <dt>{"Categoría"}</dt>
      <dd>{"Restaurantes"}</dd>
      <dt>{"Fecha"}</dt>
      <dd>{"4 de octubre"}</dd>
    </dl>
    <button className="btn" data-correct="" onClick={onCorrect}>
      {correction.action}
    </button>
    <output data-correction-status="">{correction.status}</output>
  </aside>
);
