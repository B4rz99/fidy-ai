import { useState } from "react";

export const DashboardStory = (): React.JSX.Element => {
  const [recorded, setRecorded] = useState(false);
  const [instant, setInstant] = useState(false);
  return (
    <>
      {" "}
      <section className="section dark-section dashboard-story" id="claridad">
        <div className="wrap">
          {"\n    "}
          <div className="story-heading">
            <h2>
              {"Una transacción."}
              <br />
              {"Un mismo contexto."}
            </h2>
            <p>
              {
                "Registra con el asistente y revisa el resultado en la web. Tus agentes autorizados pueden consultar esa misma transacción y su efecto en el presupuesto."
              }
            </p>
          </div>
          {"\n    "}
          <div className="story-demo" data-recorded={recorded} data-instant={instant}>
            {"\n      "}
            <StoryChat
              recorded={recorded}
              onRecord={(event) => {
                setInstant(event.detail === 0);
                setRecorded(!recorded);
              }}
            />
            {"\n      "}
            <div className="story-arrow" aria-hidden="true">
              {"→"}
            </div>
            {"\n      "}
            <StoryResult recorded={recorded} />
            {"\n    "}
          </div>
          {"\n  "}
        </div>
      </section>{" "}
    </>
  );
};

const StoryChat = ({
  recorded,
  onRecord,
}: {
  recorded: boolean;
  onRecord: React.MouseEventHandler<HTMLButtonElement>;
}): React.JSX.Element => (
  <div className="story-chat">
    <div className="story-chat-head">
      <span className="avatar">{"f"}</span>
      <div>
        <strong>{"fidy"}</strong>
        <small>{"Asistente en WhatsApp"}</small>
      </div>
    </div>
    {"\n        "}
    <div className="story-message">
      {"Pagué $28.000 de almuerzo en Crepes."}
      <small>{"Mensaje de ejemplo"}</small>
    </div>
    {"\n        "}
    <div className="story-reply" aria-hidden={!recorded}>
      <strong>{"Listo, quedó registrado."}</strong>
      <span>
        {"Crepes · Restaurantes"}
        <br />
        {"$28.000 COP"}
      </span>
    </div>
    {"\n        "}
    <button
      className="btn green"
      id="story-trigger"
      aria-controls="story-dashboard"
      onClick={onRecord}
    >
      {recorded ? "↻ Reiniciar ejemplo" : "Registrar ejemplo"}
    </button>
    {"\n        "}
    <small className="story-note">{"Pruébalo. Solo cambia esta demostración."}</small>
    {"\n      "}
  </div>
);

const StoryMetrics = ({ recorded }: { recorded: boolean }): React.JSX.Element => (
  <div className="metrics">
    <div className="metric">
      <small>{"Gastos registrados · COP"}</small>
      <strong data-story-total="">{recorded ? "$1.084.000" : "$1.056.000"}</strong>
      <small>{"Basado en tus transacciones"}</small>
    </div>
    {"\n          "}
    <div className="metric">
      <small>{"Restaurantes · COP"}</small>
      <strong data-story-category="">{recorded ? "$384.000" : "$356.000"}</strong>
      <em data-story-remaining="">{recorded ? "$216.000 disponibles" : "$244.000 disponibles"}</em>
      <div className="budget-bar">
        <i className="story-progress"></i>
      </div>
      <div className="category">
        <span>{"Presupuesto"}</span>
        <span>{"$600.000"}</span>
      </div>
    </div>
  </div>
);

const StoryLedger = ({ recorded }: { recorded: boolean }): React.JSX.Element => (
  <div className="story-ledger">
    <div className="story-ledger-head">
      <strong>{"Última transacción"}</strong>
      <span>{"Categoría"}</span>
      <span>{"Valor"}</span>
    </div>
    <div className="story-row" aria-hidden={!recorded}>
      <span className="story-row-name">
        {"Crepes"}
        <small>{"Almuerzo · hoy"}</small>
      </span>
      <span>{"Restaurantes"}</span>
      <strong>{"− $28.000"}</strong>
    </div>
    <p className="story-empty">{"Tu próxima transacción aparecerá aquí."}</p>
  </div>
);

const StoryResult = ({ recorded }: { recorded: boolean }): React.JSX.Element => (
  <div className="story-result">
    <div className="dashboard" id="story-dashboard">
      {"\n        "}
      <div className="dash-top">
        <b>
          {"fidy"}
          <span style={{ color: "#7cb243" }}>{"."}</span>
        </b>
        <span>{"Tus finanzas · Octubre"}</span>
      </div>
      {"\n        "}
      <div className="story-dashboard-body">
        <div className="story-dashboard-heading">
          <strong>{"Tu mes, en perspectiva."}</strong>
          <span className="story-badge">
            {recorded ? "Ejemplo registrado ✓" : "Antes del mensaje"}
          </span>
        </div>
        {"\n          "}
        <StoryMetrics recorded={recorded} />
        {"\n          "}
        <StoryLedger recorded={recorded} />
        {"\n          "}
        <output
          className={recorded ? "story-status" : "story-status empty-status"}
          aria-live="polite"
        >
          {recorded
            ? "Una transacción de $28.000 registrada en Restaurantes. Tu presupuesto ya la incluye."
            : ""}
        </output>
        {"\n        "}
      </div>
    </div>
  </div>
);
