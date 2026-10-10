import { useState } from "react";
import { PhoneContent } from "./phone-content";
import { conversations } from "./conversations";
import { mountConversation, playConversation } from "./demo-motion";

/** Changes synthetic conversations without changing the phone's dimensions. */
export const PhoneDemo = (): React.JSX.Element => {
  const [scenario, setScenario] = useState(0);
  return (
    <PhoneContent
      conversation={
        <div key={scenario} className="conversation-frame" ref={mountConversation}>
          {conversations[scenario]}
        </div>
      }
      controls={
        <div className="demo-controls" aria-label="Ejemplos de conversación">
          {["Registrar", "Consultar", "Presupuestar"].map((label, index) => (
            <button
              key={label}
              aria-pressed={scenario === index}
              onClick={(event) => {
                const shell = event.currentTarget.closest<HTMLElement>(".demo-shell");
                if (shell !== null) {
                  shell.dataset.motion = event.detail === 0 ? "instant" : "pointer";
                  if (scenario === index) playConversation(shell, event.detail === 0);
                }
                setScenario(index);
              }}
            >
              {label}
            </button>
          ))}
          <button
            aria-label="Repetir animación de la conversación"
            onClick={(event) => {
              const shell = event.currentTarget.closest<HTMLElement>(".demo-shell");
              if (shell !== null) playConversation(shell, event.detail === 0);
            }}
          >
            ↻ Repetir
          </button>
        </div>
      }
    />
  );
};
