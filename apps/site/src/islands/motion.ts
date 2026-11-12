const entranceDuration = 500;
const reducedDuration = 160;
const heroStagger = 60;
const cardStagger = 50;
const cardDuration = 300;
const demoDuration = 600;
const visibilityThreshold = 0.12;
const entranceTargets =
  ".hero-copy,.coin,#demo,.section-head,.agent-system,.faq > div,.closing > *";
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

const flipCoin = (coin: Element): ReadonlyArray<Animation> => {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return [];
  return [
    coin.animate(
      [
        { transform: "perspective(600px) rotate(13deg) rotateY(0deg)" },
        { transform: "perspective(600px) rotate(13deg) rotateY(360deg)" },
      ],
      { duration: 900, delay: 0, easing: "cubic-bezier(0.77, 0, 0.175, 1)" }
    ),
  ];
};

const revealHero = (target: Element): ReadonlyArray<Animation> => {
  if (supportsScrollMotion()) return [];
  return [...target.querySelectorAll(":scope > *")].map((element, index) =>
    enter({ element, duration: entranceDuration, distance: "5%", delay: index * heroStagger })
  );
};

const revealSection = (target: Element): ReadonlyArray<Animation> => {
  if (target.matches(".coin")) {
    return flipCoin(target);
  }
  if (target.matches(".hero-copy")) {
    return revealHero(target);
  }
  if (target.matches(".agent-system")) {
    return [...target.querySelectorAll(".agent-entry")].map((card, index) =>
      enter({
        element: card,
        duration: cardDuration,
        delay: index * cardStagger,
        distance: "8px",
      })
    );
  }
  const isDemo = target.id === "demo";
  if (!isDemo && supportsScrollMotion()) return [];
  return [
    enter({
      element: target,
      delay: 0,
      duration: isDemo ? demoDuration : entranceDuration,
      distance: isDemo ? "3%" : "4%",
    }),
  ];
};

/** Disposing is terminal and cancels only animations created by this mount. */
export const mountMotion = (root: HTMLDivElement): (() => void) => {
  const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
  let stopped = false;
  const runs = new Map<Element, Set<Animation>>();
  const cancelTarget = (target: Element): void => {
    const animations = runs.get(target);
    runs.delete(target);
    animations?.forEach((animation) => animation.cancel());
  };
  const cancel = (): void => {
    for (const target of runs.keys()) cancelTarget(target);
  };
  const revealed = new Set<Element>();
  const reveal = (target: Element): void => {
    const animations = new Set(revealSection(target));
    if (animations.size === 0) return;
    runs.set(target, animations);
    for (const animation of animations) {
      const release = (): void => {
        if (stopped || runs.get(target) !== animations) return;
        animations.delete(animation);
        if (animations.size === 0) runs.delete(target);
      };
      animation.finished.then(release, release);
    }
  };
  const eligible = (entry: IntersectionObserverEntry): boolean =>
    !document.hidden &&
    entry.intersectionRatio >= visibilityThreshold &&
    !revealed.has(entry.target);
  const observer = new IntersectionObserver(
    (entries) => {
      if (stopped) return;
      for (const entry of entries) {
        if (!entry.isIntersecting) {
          revealed.delete(entry.target);
          cancelTarget(entry.target);
          continue;
        }
        if (!eligible(entry)) continue;
        revealed.add(entry.target);
        reveal(entry.target);
      }
    },
    { threshold: [0, visibilityThreshold] }
  );
  root.querySelectorAll(entranceTargets).forEach((element) => observer.observe(element));
  preference.addEventListener("change", cancel);
  document.addEventListener("visibilitychange", cancel);
  return (): void => {
    if (stopped) return;
    stopped = true;
    observer.disconnect();
    preference.removeEventListener("change", cancel);
    document.removeEventListener("visibilitychange", cancel);
    cancel();
    revealed.clear();
  };
};
