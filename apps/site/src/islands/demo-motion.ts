import { enter } from "./motion";

const bubbleDuration = 280;
const bubbleStagger = 550;
const previewDuration = 300;
const previewStagger = 60;
const channelStagger = 160;
const fillDuration = 500;
const reducedDuration = 160;
const visibilityThreshold = 0.35;
const easing = (element: Element): string =>
  getComputedStyle(element).getPropertyValue("--ease-out").trim();
const reducedMotion = (): boolean => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Settles the demonstration without cancelling the page's native scroll animations. */
const settle = (root: Element): void => {
  root.getAnimations({ subtree: true }).forEach((animation) => {
    if (typeof CSSAnimation !== "undefined" && animation instanceof CSSAnimation) return;
    animation.cancel();
  });
};

const fill = (element: Element, axis: "X" | "Y", delay: number): void => {
  const reduced = reducedMotion();
  element.animate(
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

/** Reveals the result only after the chat explains it; keyboard selection settles immediately. */
export const playConversation = ({
  root,
  instant,
}: {
  root: HTMLElement;
  instant: boolean;
}): void => {
  settle(root);
  if (instant) return;
  const bubbles = root.querySelectorAll(".bubble");
  bubbles.forEach((element, index) =>
    enter({ element, duration: bubbleDuration, delay: index * bubbleStagger, distance: "8px" })
  );
  const resultDelay = (bubbles.length - 1) * bubbleStagger + bubbleDuration;
  const note = root.querySelector(".floating-note");
  const reduced = reducedMotion();
  note?.animate(
    reduced
      ? [{ opacity: 0 }, { opacity: 1 }]
      : [
          { opacity: 0, transform: "translateY(8px) rotate(4deg)" },
          { opacity: 1, transform: "translateY(0) rotate(4deg)" },
        ],
    {
      duration: reduced ? reducedDuration : previewDuration,
      delay: reduced ? 0 : resultDelay,
      easing: easing(root),
      fill: "backwards",
    }
  );
  const track = root.querySelector(".mini-track span");
  if (track !== null) fill(track, "X", resultDelay + previewDuration);
};

/** Plays once on entry and settles on departure, backgrounding, or preference changes. */
const mountDemonstration = (root: HTMLElement, play: () => void): (() => void) => {
  let played = false;
  const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
  const stop = (): void => settle(root);
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting || entry.intersectionRatio < visibilityThreshold) {
          stop();
        } else if (!played && !document.hidden) {
          played = true;
          play();
        }
      }
    },
    { threshold: visibilityThreshold }
  );
  observer.observe(root);
  preference.addEventListener("change", stop);
  document.addEventListener("visibilitychange", stop);
  return (): void => {
    observer.disconnect();
    preference.removeEventListener("change", stop);
    document.removeEventListener("visibilitychange", stop);
    stop();
  };
};

/** Keeps the phone shell stable while each selected conversation owns its animation lifetime. */
export const mountConversation = (node: HTMLDivElement): (() => void) => {
  const shell = node.closest<HTMLElement>(".demo-shell");
  if (shell === null) return () => {};
  return mountDemonstration(shell, () =>
    playConversation({ root: shell, instant: shell.dataset.motion === "instant" })
  );
};

const playPreview = (root: HTMLElement): void => {
  root
    .querySelectorAll(".feature-record,.feature-budget > strong,.feature-budget > p,.feature-foot")
    .forEach((element, index) =>
      enter({ element, duration: previewDuration, delay: index * previewStagger, distance: "8px" })
    );
  root
    .querySelectorAll(".feature-conversation > *")
    .forEach((element, index) =>
      enter({ element, duration: bubbleDuration, delay: index * bubbleStagger, distance: "8px" })
    );
  root
    .querySelectorAll(".feature-track i")
    .forEach((element) => fill(element, "X", previewDuration));
  root
    .querySelectorAll(".feature-chart i")
    .forEach((element, index) => fill(element, "Y", index * previewStagger));
};

/** Animates only the illustrative artwork; the feature explanation remains readable. */
export const mountPreview = (node: HTMLDivElement): (() => void) => {
  const art = node.querySelector<HTMLElement>(".feature-art");
  if (art === null) return () => {};
  return mountDemonstration(art, () => playPreview(art));
};

/** Explains the shared context once, without running a decorative loop. */
export const mountChannels = (node: HTMLDivElement): (() => void) =>
  mountDemonstration(node, () => {
    node.querySelectorAll(".channel-card,.channel-connector").forEach((element, index) =>
      enter({
        element,
        duration: previewDuration,
        delay: index * channelStagger,
        distance: "8px",
      })
    );
  });
