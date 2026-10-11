import type { ClickKind, Message, Model } from "./model";
import { Message as Messages } from "./model";
import { moveIndicator } from "@/features/public-site/landing/tab-indicator";
import { playConversation } from "@/features/public-site/landing/demo-motion";

const replay = (kind: ClickKind, index: number, model: Model): boolean =>
  kind === "Replay" || model.scenario === index;
export const bindPublicClick = ({
  element,
  kind,
  index,
  current,
  dispatch,
}: Readonly<{
  element: HTMLElement;
  kind: ClickKind;
  index: number;
  current: () => Model;
  dispatch: (message: Message) => void;
}>): (() => void) => {
  const click = (event: MouseEvent): void => {
    const instant = event.detail === 0;
    if (kind === "Feature" && element instanceof HTMLButtonElement) {
      moveIndicator({
        tab: element,
        instant,
      });
    }
    if (kind === "Phone" || kind === "Replay") {
      const shell = element.closest<HTMLElement>(".demo-shell");
      if (shell !== null) {
        shell.dataset.motion = instant ? "instant" : "pointer";
        if (replay(kind, index, current())) {
          playConversation({
            root: shell,
            instant,
          });
        }
      }
    }
    dispatch(
      Messages.Clicked({
        kind,
        index,
        instant,
      })
    );
  };
  element.addEventListener("click", click);
  return (): void => element.removeEventListener("click", click);
};
export const bindPublicNavigation = (header: HTMLElement): (() => void) => {
  const panel = header.querySelector<HTMLElement>(".compact-navigation");
  const click = (event: MouseEvent): void => {
    if (!(event.target instanceof Element) || panel === null) return;
    if (event.target.closest(".nav-toggle") !== null) {
      panel.dataset.motion = event.detail === 0 ? "instant" : "pointer";
    }
    if (event.target.closest(".compact-navigation a") !== null) panel.hidePopover();
  };
  const key = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && panel !== null) panel.dataset.motion = "instant";
  };
  header.addEventListener("click", click);
  header.addEventListener("keydown", key);
  return (): void => {
    header.removeEventListener("click", click);
    header.removeEventListener("keydown", key);
  };
};
export const bindPublicDisclosure = (summary: HTMLElement): (() => void) => {
  const click = (event: MouseEvent): void => {
    const details = summary.closest("details");
    if (details !== null) details.dataset.instant = String(event.detail === 0);
  };
  summary.addEventListener("click", click);
  return (): void => summary.removeEventListener("click", click);
};
