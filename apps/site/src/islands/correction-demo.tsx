import { useState } from "react";

export const CorrectionDemo = (): React.JSX.Element => {
  const [corrected, setCorrected] = useState(false);
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
              <strong>{corrected ? "− $26.000" : "− $28.000"}</strong>
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
          <CorrectionInspector corrected={corrected} onCorrect={() => setCorrected(!corrected)} />
        </div>
      </div>{" "}
    </>
  );
};

const CorrectionInspector = ({
  corrected,
  onCorrect,
}: {
  corrected: boolean;
  onCorrect: () => void;
}): React.JSX.Element => (
  <aside className="detail-inspector">
    <span>{"Detalle de transacción"}</span>
    <h3>{"Crepes"}</h3>
    <dl>
      <dt>{"Monto"}</dt>
      <dd data-correction-amount="">{corrected ? "$26.000 COP" : "$28.000 COP"}</dd>
      <dt>{"Categoría"}</dt>
      <dd>{"Restaurantes"}</dd>
      <dt>{"Fecha"}</dt>
      <dd>{"4 de octubre"}</dd>
    </dl>
    <button className="btn" data-correct="" onClick={onCorrect}>
      {corrected ? "Reiniciar ejemplo" : "Probar una corrección"}
    </button>
    <output data-correction-status="">
      {corrected
        ? "Monto corregido en este ejemplo. Es la misma transacción."
        : "Ejemplo: el monto correcto era $26.000."}
    </output>
  </aside>
);
