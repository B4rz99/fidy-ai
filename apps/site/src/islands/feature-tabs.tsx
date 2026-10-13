import { useState } from "react";
import { features } from "./feature-content";
import { mountIndicator, moveIndicator } from "./tab-indicator";
import { mountPreview } from "./demo-motion";

/** Offers pointer and roving-keyboard previews with separate detailed feature pages. */
export const FeatureTabs = (): React.JSX.Element => {
  const [selected, setSelected] = useState(0);
  const [animate, setAnimate] = useState(true);
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
              setAnimate(event.detail !== 0);
              setSelected(index);
            }}
            onKeyDown={(event) => {
              const next = nextFeature(event.key, index);
              if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              setAnimate(false);
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
        role="tabpanel"
        aria-labelledby={`feature-tab-${selected}`}
        tabIndex={0}
        key={selected}
        ref={animate ? mountPreview : undefined}
      >
        {features[selected]?.content}
      </div>
    </section>
  );
};

const nextFeature = (key: string, index: number): number => {
  if (key === "ArrowRight") return (index + 1) % features.length;
  if (key === "ArrowLeft") return (index + features.length - 1) % features.length;
  if (key === "Home") return 0;
  if (key === "End") return features.length - 1;
  return index;
};

const heading = (
  <div className="section-head">
    <h2>
      De registrar tu plata, <br />a entenderla y actuar.
    </h2>
    <p>Dale contexto a cada gasto, sigue tu presupuesto y encuentra lo que merece tu atención.</p>
  </div>
);
