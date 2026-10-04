import { useState } from "react";
import { features } from "./feature-content";
import { enter } from "./motion";

/** Offers pointer and roving-keyboard previews with separate detailed feature pages. */
export const FeatureTabs = (): React.JSX.Element => {
  const [selected, setSelected] = useState(0);
  const [animate, setAnimate] = useState(false);
  return (
    <section className="section wrap product-features" id="funciones">
      {heading}
      <div className="feature-tabs" role="tablist" aria-label="Funciones de Fidy">
        {features.map((feature, index) => (
          <button
            key={feature.slug}
            role="tab"
            id={`feature-tab-${index}`}
            aria-controls="feature-panel"
            aria-selected={selected === index}
            tabIndex={selected === index ? 0 : -1}
            onClick={(event) => {
              setAnimate(event.detail !== 0);
              setSelected(index);
            }}
            onKeyDown={(event) => {
              const next = nextFeature(event.key, index);
              if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              setAnimate(false);
              setSelected(next);
              event.currentTarget.parentElement
                ?.querySelector<HTMLButtonElement>(`#feature-tab-${next}`)
                ?.focus();
            }}
          >
            {feature.label}
          </button>
        ))}
      </div>
      <div
        id="feature-panel"
        className="feature-panel"
        role="tabpanel"
        aria-labelledby={`feature-tab-${selected}`}
        tabIndex={0}
        key={selected}
        ref={animate ? mountPanel : undefined}
      >
        {features[selected]?.content}
      </div>
      <p className="feature-disclosure">Vistas ilustrativas con datos de ejemplo.</p>
    </section>
  );
};

const panelDuration = 220;
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
      De registrar tu plata,
      <br />a entenderla y actuar.
    </h2>
    <p>
      Registros, presupuestos y hallazgos conectados con el asistente, la web y tus propios agentes.
    </p>
  </div>
);

const mountPanel = (node: HTMLDivElement): (() => void) => {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return () => {};
  const animation = enter({ element: node, duration: panelDuration, delay: 0, distance: "6px" });
  return () => animation.cancel();
};
