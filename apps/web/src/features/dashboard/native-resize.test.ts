import { type Mock, afterEach, expect, it, vi } from "vitest";
import { bindDashboardResize, dashboardResizeWeight } from "./native-resize";

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers) dispose();
  document.body.replaceChildren();
});
type ResizeFixture = Readonly<{
  first: HTMLElement;
  second: HTMLElement;
  handle: HTMLButtonElement;
  parent: HTMLElement;
  captured: Set<number>;
  resize: Mock;
  pointer: (type: string, ...options: readonly MouseEventInit[]) => void;
  dispose: () => void;
  disable: () => void;
}>;
const setup = (axis: "row" | "column" = "row"): ResizeFixture => {
  const parent = document.createElement("div");
  const first = document.createElement("div");
  const handle = document.createElement("button");
  const second = document.createElement("div");
  parent.append(first, handle, second);
  document.body.append(parent);
  first.getBoundingClientRect = (): DOMRect => new DOMRect(0, 0, 100, 100);
  second.getBoundingClientRect = (): DOMRect => new DOMRect(100, 100, 100, 100);
  const captured = new Set<number>();
  handle.setPointerCapture = (id): void => {
    captured.add(id);
  };
  handle.hasPointerCapture = (id): boolean => captured.has(id);
  handle.releasePointerCapture = (id): void => {
    captured.delete(id);
  };
  let enabled = true;
  const resize = vi.fn();
  const dispose = bindDashboardResize({
    element: handle,
    axis,
    weight: 1,
    adjacentWeight: 1,
    enabled: () => enabled,
    resize,
  });
  disposers.push(dispose);
  const pointer = (type: string, options: MouseEventInit = {}): void => {
    const event = new MouseEvent(type, {
      clientX: options.clientX ?? 150,
      clientY: options.clientX ?? 150,
      button: options.button ?? 0,
      buttons: options.buttons ?? 1,
    });
    Object.defineProperty(event, "pointerId", { value: options.detail ?? 7 });
    handle.dispatchEvent(event);
  };
  return {
    first,
    second,
    handle,
    parent,
    captured,
    resize,
    pointer,
    dispose,
    disable: (): void => {
      enabled = false;
    },
  };
};

it.each(["row", "column"] as const)(
  "previews %s resizing privately and commits once on release",
  (axis) => {
    const fixture = setup(axis);
    fixture.pointer("pointermove");
    expect(fixture.first.style.getPropertyValue("--dashboard-weight")).toBe("");
    fixture.pointer("pointerdown", { clientX: 100 });
    fixture.pointer("pointermove", { clientX: 150 });
    expect(fixture.first.style.getPropertyValue("--dashboard-weight")).toBe("1.5");
    expect(fixture.resize).not.toHaveBeenCalled();
    fixture.pointer("pointerup", { detail: 8 });
    expect(fixture.captured.has(7)).toBe(true);
    fixture.pointer("pointerup");
    expect(fixture.resize).toHaveBeenCalledExactlyOnceWith(1.5);
    expect(fixture.first.style.getPropertyValue("--dashboard-weight")).toBe("1");
    expect(fixture.second.style.getPropertyValue("--dashboard-weight")).toBe("1");
    expect(fixture.captured.size).toBe(0);
    fixture.pointer("pointerup");
    expect(fixture.resize).toHaveBeenCalledTimes(1);
  }
);

it.each([
  "pointercancel",
  "lostpointercapture",
  "dispose",
  "disabled-move",
  "released-move",
  "disabled-up",
])("cancels a private preview on %s", (reason) => {
  const fixture = setup();
  fixture.pointer("pointerdown");
  if (reason === "dispose") fixture.dispose();
  else if (reason === "disabled-move" || reason === "disabled-up") {
    fixture.disable();
    fixture.pointer(reason === "disabled-up" ? "pointerup" : "pointermove");
  } else if (reason === "released-move") fixture.pointer("pointermove", { buttons: 0 });
  else fixture.pointer(reason);
  fixture.pointer("pointerup");
  expect(fixture.resize).not.toHaveBeenCalled();
  expect(fixture.captured.size).toBe(0);
  expect(fixture.first.style.getPropertyValue("--dashboard-weight")).toBe("1");
});

it("ignores disabled or non-primary pointers and unchanged releases", () => {
  const fixture = setup();
  fixture.pointer("pointerdown", { button: 2 });
  expect(fixture.captured.size).toBe(0);
  fixture.pointer("pointerdown", { clientX: 100 });
  fixture.pointer("pointerup", { clientX: 100 });
  expect(fixture.resize).not.toHaveBeenCalled();
  fixture.disable();
  fixture.pointer("pointerdown");
  expect(fixture.captured.size).toBe(0);
});

it.each(["missing-first", "missing-second", "empty-region"])(
  "does not commit unusable geometry: %s",
  (reason) => {
    const fixture = setup();
    if (reason === "missing-first") fixture.first.remove();
    else if (reason === "missing-second") fixture.second.remove();
    else fixture.second.getBoundingClientRect = (): DOMRect => new DOMRect();
    fixture.pointer("pointerdown");
    fixture.pointer("pointerup");
    expect(fixture.resize).not.toHaveBeenCalled();
  }
);

it.each([
  ["row", "ArrowLeft", 0.9],
  ["row", "ArrowRight", 1.1],
  ["column", "ArrowUp", 0.9],
  ["column", "ArrowDown", 1.1],
] as const)("provides %s keyboard resizing with %s", (axis, key, expected) => {
  const fixture = setup(axis);
  fixture.handle.dispatchEvent(new KeyboardEvent("keydown", { key }));
  expect(fixture.resize).toHaveBeenCalledExactlyOnceWith(expected);
  fixture.handle.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  fixture.disable();
  fixture.handle.dispatchEvent(new KeyboardEvent("keydown", { key }));
  expect(fixture.resize).toHaveBeenCalledTimes(1);
  fixture.dispose();
  fixture.handle.dispatchEvent(new KeyboardEvent("keydown", { key }));
  expect(fixture.resize).toHaveBeenCalledTimes(1);
});

it("bounds pointer previews and preserves canonical weight precision", () => {
  const fixture = setup();
  fixture.pointer("pointerdown", { clientX: -10 });
  expect(fixture.first.style.getPropertyValue("--dashboard-weight")).toBe("0.32");
  fixture.pointer("pointerup", { clientX: 300 });
  expect(fixture.resize).toHaveBeenCalledExactlyOnceWith(1.68);
  expect(dashboardResizeWeight({ weight: 0.666666, pairWeight: 2 })).toBe(0.667);
});
