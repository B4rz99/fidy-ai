import { mountConversation, playConversation } from "../islands/demo-motion";

export const mountPhoneDemo = (shell: HTMLElement): (() => void) => {
  const frame = shell.querySelector<HTMLDivElement>(".conversation-frame");
  if (frame === null) return () => {};
  const templates = [...shell.querySelectorAll<HTMLTemplateElement>("template[data-scenario]")];
  const buttons = [...shell.querySelectorAll<HTMLButtonElement>("button[data-scenario]")];
  let stopConversation = mountConversation(frame);
  const replay = (event: MouseEvent): void => {
    shell.dataset.motion = event.detail === 0 ? "instant" : "pointer";
    playConversation({ root: shell, instant: event.detail === 0 });
  };
  const select = (event: MouseEvent): void => {
    const button = event.currentTarget;
    if (!(button instanceof HTMLButtonElement)) return;
    const template = templates.find((item) => item.dataset.scenario === button.dataset.scenario);
    if (template === undefined) return;
    stopConversation();
    frame.replaceChildren(template.content.cloneNode(true));
    for (const option of buttons) option.setAttribute("aria-pressed", String(option === button));
    replay(event);
    stopConversation = mountConversation(frame);
  };
  for (const button of buttons) button.addEventListener("click", select);
  const replayButton = shell.querySelector<HTMLButtonElement>("[data-replay]");
  replayButton?.addEventListener("click", replay);
  shell.dataset.ready = "true";
  return (): void => {
    stopConversation();
    for (const button of buttons) button.removeEventListener("click", select);
    replayButton?.removeEventListener("click", replay);
  };
};
