import { PhoneContent } from "./phone-content";
import { conversations } from "./conversations";

export const PhoneDemo = (): React.JSX.Element => (
  <PhoneContent
    conversation={<div className="conversation-frame">{conversations[0]}</div>}
    controls={
      <>
        <div className="demo-controls" aria-label="Ejemplos de conversación">
          {["Registrar", "Consultar", "Presupuestar"].map((label, index) => (
            <button key={label} type="button" aria-pressed={index === 0} data-scenario={index}>
              {label}
            </button>
          ))}
          <button type="button" aria-label="Repetir animación de la conversación" data-replay>
            ↻ Repetir
          </button>
        </div>
        {conversations.map((conversation, index) => (
          <template key={index} data-scenario={index}>
            {conversation}
          </template>
        ))}
      </>
    }
  />
);
