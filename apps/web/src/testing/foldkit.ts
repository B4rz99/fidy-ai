const disposers = new Set<() => void>();
let nextId = 0;

/** Mounts a real element runtime in an attached host that survives replacement of its target. */
export const renderFoldkit = (
  mount: (target: HTMLElement) => () => void
): Readonly<{
  container: HTMLElement;
  unmount: () => void;
}> => {
  const container = document.createElement("div");
  const target = document.createElement("div");
  target.id = `foldkit-test-${++nextId}`;
  container.append(target);
  document.body.append(container);
  const dispose = mount(target);
  let active = true;
  const unmount = (): void => {
    if (!active) return;
    active = false;
    dispose();
    container.remove();
    disposers.delete(unmount);
  };
  disposers.add(unmount);
  return { container, unmount };
};

/** Releases every runtime created by this test file. */
export const cleanupFoldkit = (): void => {
  for (const dispose of disposers) dispose();
};
