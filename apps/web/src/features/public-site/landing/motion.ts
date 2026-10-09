const entranceDuration = 500;
const reducedDuration = 160;
const bubbleDuration = 280;
const bubbleStagger = 550;
const heroStagger = 60;
const cardStagger = 50;
const cardDuration = 300;
const demoDuration = 600;
const ease = "cubic-bezier(0.23, 1, 0.32, 1)";

const supportsScrollMotion = (): boolean =>
  typeof CSS !== "undefined" &&
  typeof CSS.supports === "function" &&
  CSS.supports("animation-timeline: view()");

/** Animates a finite entrance, respecting the current reduced-motion preference. */
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
          { opacity: 0, transform: `translateY(${distance})` },
          { opacity: 1, transform: "translateY(0)" },
        ],
    {
      duration: reduced ? reducedDuration : duration,
      delay: reduced ? 0 : delay,
      easing: ease,
      fill: "backwards",
    }
  );
};

/** Restarts only this illustrative chat, cancelling any interrupted sequence. */
export const playConversation = (root: Element): void => {
  root.querySelectorAll(".bubble").forEach((bubble, index) => {
    bubble.getAnimations().forEach((animation) => animation.cancel());
    enter({
      element: bubble,
      duration: bubbleDuration,
      delay: index * bubbleStagger,
      distance: "8%",
    });
  });
};

/** Gives the decorative coin one flip without changing its layout or resting angle. */
const flipCoin = (root: Element): void => {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  root
    .querySelector(".coin")
    ?.animate(
      [
        { transform: "perspective(600px) rotate(13deg) rotateY(0deg)" },
        { transform: "perspective(600px) rotate(13deg) rotateY(360deg)" },
      ],
      { duration: 900, delay: demoDuration, easing: "cubic-bezier(0.77, 0, 0.175, 1)" }
    );
};

/** Reveals each marketing group once, without delaying its interactions. */
const revealSection = (target: Element): void => {
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
  if (isDemo) {
    playConversation(target);
    flipCoin(target);
  }
};

/** Owns browser animation resources for one mounted landing, including Strict Mode cleanup. */
export const mountMotion = (root: HTMLDivElement): (() => void) => {
  const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
  const cancel = (): void =>
    root.getAnimations({ subtree: true }).forEach((animation) => {
      if (typeof CSSAnimation !== "undefined" && animation instanceof CSSAnimation) return;
      animation.cancel();
    });
  if (!supportsScrollMotion()) {
    root
      .querySelectorAll(".hero-copy > *")
      .forEach((element, index) =>
        enter({ element, duration: entranceDuration, distance: "5%", delay: index * heroStagger })
      );
  }
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        revealSection(entry.target);
      }
    },
    { threshold: 0.12 }
  );
  root
    .querySelectorAll("#demo,.section-head,.agent-system,.faq > div,.closing > *")
    .forEach((element) => observer.observe(element));
  const stop = (): void => {
    observer.disconnect();
    cancel();
  };
  preference.addEventListener("change", stop);
  return (): void => {
    stop();
    preference.removeEventListener("change", stop);
  };
};
