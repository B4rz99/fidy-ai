import { useState } from "react";
import { PhoneContent } from "./phone-content";
import { conversations } from "./conversations";
import { playConversation } from "./motion";

const animateChat = (node: HTMLDivElement) => {
  playConversation(node);
  return (): void =>
    node.getAnimations({ subtree: true }).forEach((animation) => animation.cancel());
};

/** Changes synthetic conversations without changing the phone's dimensions. */
export const PhoneDemo = (): React.JSX.Element => {
  const [scenario, setScenario] = useState(0);
  return (
    <PhoneContent
      conversation={
        <div key={scenario} className="conversation-frame" ref={animateChat}>
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
                setScenario(index);
                if (scenario === index) {
                  const shell = event.currentTarget.closest(".demo-shell");
                  if (shell !== null) playConversation(shell);
                }
              }}
            >
              {label}
            </button>
          ))}
          <button
            aria-label="Repetir animación de la conversación"
            onClick={(event) => {
              if (event.detail !== 0) {
                const shell = event.currentTarget.closest(".demo-shell");
                if (shell !== null) playConversation(shell);
              }
            }}
          >
            ↻ Repetir
          </button>
        </div>
      }
    />
  );
};
