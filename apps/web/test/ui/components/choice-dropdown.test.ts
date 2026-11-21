import { Effect, Option } from "effect";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ChoiceDropdown, InlineChoiceDropdown } from "@/ui/components/choice-dropdown";

const reactWork = (work: () => void): Promise<void> => Promise.resolve(act(work));

it.each(["field", "inline"] as const)(
  "%s choice menus read the latest options only when opened",
  (kind) =>
    Effect.runPromise(
      Effect.gen(function* () {
        vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        const change = vi.fn();
        const label = vi.fn((name: string) => name);

        const render = (name: string): Promise<void> => {
          const options = [
            {
              value: "nuevo",
              get label(): string {
                return label(name);
              },
            },
          ];

          const props = {
            label: "Filtrar",
            disabled: false,
            leading: null,
            value: "actual",
            onChange: change,
          };

          const inlineProps = {
            ...props,
            children: "Categorías",
            getOptions: (): typeof options => options,
          };

          return reactWork(() =>
            root.render(
              kind === "field"
                ? createElement(ChoiceDropdown, {
                    ...props,
                    id: "categorias",
                    width: "auto",
                    triggerLabel: Option.some("Categorías"),
                    options,
                  })
                : createElement(InlineChoiceDropdown, inlineProps)
            )
          );
        };

        try {
          yield* Effect.tryPromise(() => render("Anterior"));
          yield* Effect.tryPromise(() => render("Mercado"));
          const trigger = container.querySelector("button");
          expect(trigger?.textContent).toBe("Categorías");
          expect(label).not.toHaveBeenCalled();
          yield* Effect.tryPromise(() => reactWork(() => trigger?.click()));
          const option = document.querySelector<HTMLElement>('[role="menuitemradio"]');
          expect(option?.textContent).toBe("Mercado");

          if (option === null) {
            throw Error("Missing Category choice");
          }

          yield* Effect.tryPromise(() => reactWork(() => option.click()));
          expect(change).toHaveBeenCalledExactlyOnceWith("nuevo");
        } finally {
          yield* Effect.tryPromise(() => reactWork(() => root.unmount()));
          container.remove();
          vi.unstubAllGlobals();
        }
      })
    )
);
