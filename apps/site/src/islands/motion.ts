const entranceDuration = 500;
const reducedDuration = 160;
const heroStagger = 60;
const cardStagger = 50;
const cardDuration = 300;
const demoDuration = 600;
const visibilityThreshold = 0.12;
const ease = "cubic-bezier(0.23, 1, 0.32, 1)";

const supportsScrollMotion = (): boolean =>
  typeof CSS !== "undefined" &&
  typeof CSS.supports === "function" &&
  CSS.supports("animation-timeline: view()");

export const enter = ({
  element,
  duration,
  delay,
  distance,
}: {
  element: Element;
  duration: number;
  delay: number;
  distance: string;
}): Animation => {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return element.animate(
    reduced
      ? [{ opacity: 0 }, { opacity: 1 }]
      : [
          { opacity: 0, translate: `0 ${distance}` },
          { opacity: 1, translate: "0 0" },
        ],
    {
      duration: reduced ? reducedDuration : duration,
      delay: reduced ? 0 : delay,
      easing: ease,
      fill: "backwards",
    }
  );
};

const flipCoin = (coin: Element): void => {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  coin.getAnimations().forEach((animation) => animation.cancel());
  coin.animate(
    [
      { transform: "perspective(600px) rotate(13deg) rotateY(0deg)" },
      { transform: "perspective(600px) rotate(13deg) rotateY(360deg)" },
    ],
    { duration: 900, delay: 0, easing: "cubic-bezier(0.77, 0, 0.175, 1)" }
  );
};

const revealHero = (target: Element): void => {
  if (supportsScrollMotion()) return;
  target
    .querySelectorAll(":scope > *")
    .forEach((element, index) =>
      enter({ element, duration: entranceDuration, distance: "5%", delay: index * heroStagger })
    );
};

const revealSection = (target: Element): void => {
  if (target.matches(".coin")) {
    flipCoin(target);
    return;
  }
  if (target.matches(".hero-copy")) {
    revealHero(target);
    return;
  }
  if (target.matches(".agent-system")) {
    target.querySelectorAll(".agent-entry").forEach((card, index) =>
      enter({
        element: card,
        duration: cardDuration,
        delay: index * cardStagger,
        distance: "8px",
      })
    );
    return;
  }
  const isDemo = target.id === "demo";
  if (!isDemo && supportsScrollMotion()) return;
  enter({
    element: target,
    delay: 0,
    duration: isDemo ? demoDuration : entranceDuration,
    distance: isDemo ? "3%" : "4%",
  });
};

/** Owns mounted browser animations; cleanup also supports Strict Mode replay. */
export const mountMotion = (root: HTMLDivElement): (() => void) => {
  const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
  const cancel = (): void =>
    root.getAnimations({ subtree: true }).forEach((animation) => {
      if (typeof CSSAnimation !== "undefined" && animation instanceof CSSAnimation) return;
      animation.cancel();
    });
  const revealed = new Set<Element>();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) {
          revealed.delete(entry.target);
          continue;
        }
        if (entry.intersectionRatio < visibilityThreshold || revealed.has(entry.target)) continue;
        revealed.add(entry.target);
        revealSection(entry.target);
      }
    },
    { threshold: [0, visibilityThreshold] }
  );
  root
    .querySelectorAll(".hero-copy,.coin,#demo,.section-head,.agent-system,.faq > div,.closing > *")
    .forEach((element) => observer.observe(element));
  const stop = (): void => {
    observer.disconnect();
    cancel();
  };
  preference.addEventListener("change", cancel);
  return (): void => {
    stop();
    preference.removeEventListener("change", cancel);
  };
};
