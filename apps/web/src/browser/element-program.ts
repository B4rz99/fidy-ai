/** Keeps the parent renderer's host stable while an embedded runtime owns its inner root. */
export const mountElementProgram = ({
  host,
  mount,
}: Readonly<{
  host: HTMLElement;
  mount: (container: HTMLElement) => () => void;
}>): (() => void) => {
  const container = document.createElement("div");
  container.id = `${host.id}-program`;
  host.replaceChildren(container);
  return mount(container);
};
