import type { ViewConfiguration, ViewContent } from "../model";
import { PhoneContent } from "./phone-content";
import { conversations } from "./conversations";

/** The phone shell survives scenario changes; each conversation owns its motion scope. */
export const PhoneDemo = (configuration: ViewConfiguration): ViewContent => {
  const { html, model, mounts } = configuration;
  const conversation = conversations[model.scenario];
  return PhoneContent({
    ...configuration,
    conversation: [
      html.div(
        [
          html.Key(String(model.scenario)),
          html.Class("conversation-frame"),
          html.OnMount(mounts.conversation()),
        ],
        conversation === undefined ? [] : conversation(configuration)
      ),
    ],
    controls: [
      html.div(
        [html.Class("demo-controls"), html.AriaLabel("Ejemplos de conversación")],
        [
          ...["Registrar", "Consultar", "Presupuestar"].map((label, index) =>
            html.button(
              [
                html.Type("button"),
                html.Key(label),
                html.AriaPressed(String(model.scenario === index)),
                html.OnMount(
                  mounts.click({
                    kind: "Phone",
                    index,
                  })
                ),
              ],
              [label]
            )
          ),
          html.button(
            [
              html.Type("button"),
              html.AriaLabel("Repetir animación de la conversación"),
              html.OnMount(
                mounts.click({
                  kind: "Replay",
                  index: 0,
                })
              ),
            ],
            ["↻ Repetir"]
          ),
        ]
      ),
    ],
  });
};
