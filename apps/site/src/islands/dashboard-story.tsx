import { useState } from "react";

type StoryStage = "pending" | "recorded";

const storyStages: Readonly<
  Record<
    StoryStage,
    Readonly<{
      revealed: boolean;
      next: StoryStage;
      action: string;
      statusClass: string;
      status: string;
    }>
  >
> = {
  pending: {
    revealed: false,
    next: "recorded",
    action: "Registrar ejemplo",
    statusClass: "story-status empty-status",
    status: "",
  },
  recorded: {
    revealed: true,
    next: "pending",
    action: "↻ Reiniciar ejemplo",
    statusClass: "story-status",
    status: "Una transacción de $28.000 registrada en Restaurantes. Tu presupuesto ya la incluye.",
  },
};

type StoryValues = Readonly<Record<StoryStage, string>>;

const storyStageOrder: ReadonlyArray<StoryStage> = ["pending", "recorded"];

export const DashboardStory = (): React.JSX.Element => {
  const [stage, setStage] = useState<StoryStage>("pending");
  const [transition, setTransition] = useState<"animated" | "instant">("animated");

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
          <div
            className="story-demo"
            data-recorded={storyStages[stage].revealed}
            data-transition={transition}
          >
            {"\n      "}
            <StoryChat
              stage={stage}
              onRecord={(event) => {
                setTransition(event.detail === 0 ? "instant" : "animated");
                setStage(storyStages[stage].next);
              }}
            />
            {"\n      "}
            <div className="story-arrow" aria-hidden="true">
              {"→"}
            </div>
            {"\n      "}
            <StoryResult stage={stage} />
            {"\n    "}
          </div>
          {"\n  "}
        </div>
      </section>{" "}
    </>
  );
};

const StoryChat = ({
  stage,
  onRecord,
}: {
  stage: StoryStage;
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
    <div className="story-reply" aria-hidden={!storyStages[stage].revealed}>
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
      {storyStages[stage].action}
    </button>
    {"\n        "}
    <small className="story-note">{"Pruébalo. Solo cambia esta demostración."}</small>
    {"\n      "}
  </div>
);

const StoryMetrics = ({ stage }: { stage: StoryStage }): React.JSX.Element => (
  <div className="metrics">
    <div className="metric">
      <small>{"Gastos registrados · COP"}</small>
      <strong data-story-total="">
        <StoryValue stage={stage} values={{ pending: "$1.056.000", recorded: "$1.084.000" }} />
      </strong>
      <small>{"Basado en tus transacciones"}</small>
    </div>
    {"\n          "}
    <div className="metric">
      <small>{"Restaurantes · COP"}</small>
      <strong data-story-category="">
        <StoryValue stage={stage} values={{ pending: "$356.000", recorded: "$384.000" }} />
      </strong>
      <em data-story-remaining="">
        <StoryValue
          stage={stage}
          values={{ pending: "$244.000 disponibles", recorded: "$216.000 disponibles" }}
        />
      </em>
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

const StoryLedger = ({ stage }: { stage: StoryStage }): React.JSX.Element => (
  <div className="story-ledger">
    <div className="story-ledger-head">
      <strong>{"Última transacción"}</strong>
      <span>{"Categoría"}</span>
      <span>{"Valor"}</span>
    </div>
    <div className="story-row" aria-hidden={!storyStages[stage].revealed}>
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

const StoryResult = ({ stage }: { stage: StoryStage }): React.JSX.Element => (
  <div className="story-result">
    <div className="dashboard" id="story-dashboard">
      {"\n        "}
      <div className="dash-top">
        <b>
          {"fidy"}
          <span className="dashboard-accent">{"."}</span>
        </b>
        <span>{"Tus finanzas · Octubre"}</span>
      </div>
      {"\n        "}
      <div className="story-dashboard-body">
        <div className="story-dashboard-heading">
          <strong>{"Tu mes, en perspectiva."}</strong>
          <span className="story-badge">
            <StoryValue
              stage={stage}
              values={{ pending: "Antes del mensaje", recorded: "Ejemplo registrado ✓" }}
            />
          </span>
        </div>
        {"\n          "}
        <StoryMetrics stage={stage} />
        {"\n          "}
        <StoryLedger stage={stage} />
        {"\n          "}
        <output className={storyStages[stage].statusClass} aria-live="polite">
          {storyStages[stage].status}
        </output>
        {"\n        "}
      </div>
    </div>
  </div>
);

const StoryValue = ({
  stage,
  values,
}: {
  stage: StoryStage;
  values: StoryValues;
}): React.JSX.Element => (
  <span className="story-value">
    {storyStageOrder.map((shown) => (
      <span key={shown} aria-hidden={shown !== stage} data-visible={shown === stage}>
        {values[shown]}
      </span>
    ))}
  </span>
);
