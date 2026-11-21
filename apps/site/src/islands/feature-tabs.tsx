import { useState } from "react";
import { features } from "./feature-content";
import { mountIndicator, moveIndicator } from "./tab-indicator";
import { mountPreview } from "./demo-motion";

export const FeatureTabs = (): React.JSX.Element => {
  const [selected, setSelected] = useState(0);
  const [motion, setMotion] = useState<"animated" | "instant">("animated");

  return (
    <section className="section wrap product-features" id="funciones">
      {heading}
      <div
        ref={mountIndicator}
        className="feature-tabs"
        role="tablist"
        aria-label="Funciones de Fidy"
      >
        {features.map((feature, index) => (
          <button
            key={feature.slug}
            role="tab"
            id={`feature-tab-${index}`}
            aria-controls="feature-panel"
            aria-selected={selected === index}
            tabIndex={selected === index ? 0 : -1}
            onClick={(event) => {
              moveIndicator({ tab: event.currentTarget, instant: event.detail === 0 });
              setMotion(event.detail === 0 ? "instant" : "animated");
              setSelected(index);
            }}
            onKeyDown={(event) => {
              const next = featureNavigation.get(event.key)?.(index);

              if (next === undefined) return;
              event.preventDefault();
              setMotion("instant");
              setSelected(next);

              const target = event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(
                `#feature-tab-${next}`
              );

              if (target != null) {
                moveIndicator({ tab: target, instant: true });
                target.focus();
              }
            }}
          >
            {feature.label}
          </button>
        ))}
        <span className="feature-indicator" aria-hidden="true" />
      </div>
      <div
        id="feature-panel"
        className="feature-panel"
        data-animate={motion === "animated"}
        role="tabpanel"
        aria-labelledby={`feature-tab-${selected}`}
        tabIndex={0}
        key={selected}
        ref={motion === "animated" ? mountPreview : undefined}
      >
        {features[selected]?.content}
      </div>
    </section>
  );
};

const featureNavigation = new Map<string, (index: number) => number>([
  ["ArrowRight", (index): number => (index + 1) % features.length],
  ["ArrowLeft", (index): number => (index + features.length - 1) % features.length],
  ["Home", (): number => 0],
  ["End", (): number => features.length - 1],
]);

const heading = (
  <div className="section-head">
    <h2>
      De registrar tu plata, <br />a entenderla y actuar.
    </h2>
    <p>Dale contexto a cada gasto, sigue tu presupuesto y encuentra lo que merece tu atención.</p>
  </div>
);
