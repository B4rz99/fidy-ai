import { mountConversation } from "../islands/demo-motion";

export const mountPhoneDemo = (shell: HTMLElement): (() => void) => {
  const frame = shell.querySelector<HTMLDivElement>(".conversation-frame");
  if (frame === null) return () => {};
  const templates = [...shell.querySelectorAll<HTMLTemplateElement>("template[data-scenario]")];
  const buttons = [...shell.querySelectorAll<HTMLButtonElement>("button[data-scenario]")];
  const conversation = mountConversation(shell);
  let stopped = false;
  const replay = (event: MouseEvent): void => {
    if (stopped) return;
    shell.dataset.motion = event.detail === 0 ? "instant" : "pointer";
    conversation.replay(event.detail === 0);
  };
  const select = (event: MouseEvent): void => {
    if (stopped) return;
    const button = event.currentTarget;
    if (!(button instanceof HTMLButtonElement)) return;
    const template = templates.find((item) => item.dataset.scenario === button.dataset.scenario);
    if (template === undefined) return;
    shell.dataset.motion = event.detail === 0 ? "instant" : "pointer";
    conversation.replay(event.detail === 0, () => {
      frame.replaceChildren(template.content.cloneNode(true));
      for (const option of buttons) option.setAttribute("aria-pressed", String(option === button));
    });
  };
  for (const button of buttons) button.addEventListener("click", select);
  const replayButton = shell.querySelector<HTMLButtonElement>("[data-replay]");
  replayButton?.addEventListener("click", replay);
  shell.dataset.ready = "true";
  return (): void => {
    if (stopped) return;
    stopped = true;
    conversation.dispose();
    for (const button of buttons) button.removeEventListener("click", select);
    replayButton?.removeEventListener("click", replay);
  };
};
