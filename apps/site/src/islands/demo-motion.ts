import { enter } from "./motion";

const bubbleDuration = 280;
const bubbleStagger = 550;
const previewDuration = 300;
const previewStagger = 60;
const fillDuration = 500;
const reducedDuration = 160;
const visibilityThreshold = 0.35;
const easing = (element: Element): string =>
  getComputedStyle(element).getPropertyValue("--ease-out").trim();
const reducedMotion = (): boolean => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const fill = (element: Element, axis: "X" | "Y", delay: number): Animation => {
  const reduced = reducedMotion();
  return element.animate(
    reduced
      ? [{ opacity: 0 }, { opacity: 1 }]
      : [{ transform: `scale${axis}(0)` }, { transform: `scale${axis}(1)` }],
    {
      duration: reduced ? reducedDuration : fillDuration,
      delay: reduced ? 0 : delay,
      easing: easing(element),
      fill: "backwards",
    }
  );
};

const playConversation = (root: HTMLElement): ReadonlyArray<Animation> => {
  const animations: Animation[] = [];
  const bubbles = root.querySelectorAll(".bubble");
  bubbles.forEach((element, index) =>
    animations.push(
      enter({ element, duration: bubbleDuration, delay: index * bubbleStagger, distance: "8px" })
    )
  );
  const resultDelay = (bubbles.length - 1) * bubbleStagger + bubbleDuration;
  const note = root.querySelector(".floating-note");
  const reduced = reducedMotion();
  if (note !== null) {
    animations.push(
      note.animate(
        reduced
          ? [{ opacity: 0 }, { opacity: 1 }]
          : [
              { opacity: 0, translate: "0 8px" },
              { opacity: 1, translate: "0 0" },
            ],
        {
          duration: reduced ? reducedDuration : previewDuration,
          delay: reduced ? 0 : resultDelay,
          easing: easing(root),
          fill: "backwards",
        }
      )
    );
  }
  const track = root.querySelector(".mini-track span");
  if (track !== null) animations.push(fill(track, "X", resultDelay + previewDuration));
  return animations;
};

const mountDemonstration = (
  root: HTMLElement,
  play: () => ReadonlyArray<Animation>
): {
  replay: (instant: boolean, replace?: () => void) => void;
  dispose: () => void;
} => {
  let played = false;
  let stopped = false;
  let handles = new Set<Animation>();
  const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
  const settle = (): void => {
    const previous = handles;
    handles = new Set();
    for (const animation of previous) animation.cancel();
  };
  const replay = (instant: boolean, replace?: () => void): void => {
    if (stopped) return;
    played = true;
    settle();
    replace?.();
    if (instant || document.hidden) return;
    const generation = handles;
    for (const animation of play()) {
      generation.add(animation);
      const release = (): boolean => generation.delete(animation);
      animation.finished.then(release, release);
    }
  };
  const observer = new IntersectionObserver(
    (entries) => {
      if (stopped) return;
      for (const entry of entries) {
        if (!entry.isIntersecting) {
          played = false;
          delete root.dataset.motion;
          settle();
        } else if (entry.intersectionRatio >= visibilityThreshold && !played && !document.hidden) {
          replay(root.dataset.motion === "instant");
        }
      }
    },
    { threshold: [0, visibilityThreshold] }
  );
  const changePolicy = (): void => replay(true);
  observer.observe(root);
  preference.addEventListener("change", changePolicy);
  document.addEventListener("visibilitychange", changePolicy);
  return {
    replay,
    dispose: (): void => {
      if (stopped) return;
      stopped = true;
      observer.disconnect();
      preference.removeEventListener("change", changePolicy);
      document.removeEventListener("visibilitychange", changePolicy);
      settle();
    },
  };
};

export const mountConversation = (shell: HTMLElement): ReturnType<typeof mountDemonstration> =>
  mountDemonstration(shell, () => playConversation(shell));

const playPreview = (root: HTMLElement): ReadonlyArray<Animation> => {
  const animations: Animation[] = [];
  root
    .querySelectorAll(".feature-record,.feature-budget > strong,.feature-budget > p,.feature-foot")
    .forEach((element, index) =>
      animations.push(
        enter({
          element,
          duration: previewDuration,
          delay: index * previewStagger,
          distance: "8px",
        })
      )
    );
  root
    .querySelectorAll(".feature-conversation > *")
    .forEach((element, index) =>
      animations.push(
        enter({ element, duration: bubbleDuration, delay: index * bubbleStagger, distance: "8px" })
      )
    );
  root
    .querySelectorAll(".feature-track i")
    .forEach((element) => animations.push(fill(element, "X", previewDuration)));
  root
    .querySelectorAll(".feature-chart i")
    .forEach((element, index) => animations.push(fill(element, "Y", index * previewStagger)));
  return animations;
};

export const mountPreview = (node: HTMLDivElement): (() => void) => {
  const art = node.querySelector<HTMLElement>(".feature-art");
  if (art === null) return () => {};
  return mountDemonstration(art, () => playPreview(art)).dispose;
};
