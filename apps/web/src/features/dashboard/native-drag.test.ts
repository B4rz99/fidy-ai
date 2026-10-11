import { Schema } from "effect";
import { DashboardCatalogEntry } from "@/transport/client";
import { afterEach, expect, it, vi } from "vitest";
import type { DashboardDropTarget } from "./drag-data";
import { makeDashboardDragOwner } from "./native-drag";
import { catalog, ids } from "./test-fixtures";

type SourceData = Readonly<{ data: unknown }>;
type TargetData = Readonly<{ id: string; data: unknown }>;
type DragOperation =
  | Readonly<{ source: SourceData; target: TargetData }>
  | Readonly<{ source: SourceData }>
  | Readonly<{ target: TargetData }>
  | Readonly<Record<string, never>>;
type DragEvent = Readonly<{
  operation: DragOperation;
  canceled: boolean;
  preventDefault: () => void;
}>;
type SourceOptions = Readonly<{ id: string; data: unknown }>;
type TargetOptions = Readonly<{
  id: string;
  accept: (source: Readonly<{ type: string; data: unknown }>) => boolean;
}>;
const kit = vi.hoisted(() => {
  const sources: SourceOptions[] = [];
  const targets: TargetOptions[] = [];
  return {
    listeners: new Map<string, Array<(event: DragEvent) => void>>(),
    sources,
    targets,
    destroyed: vi.fn(),
    releasedSource: vi.fn(),
    releasedTarget: vi.fn(),
  };
});
vi.mock("@dnd-kit/dom", () => ({
  Accessibility: { configure: (): Readonly<Record<string, never>> => ({}) },
  DragDropManager: class {
    monitor = {
      addEventListener: (name: string, listener: (event: DragEvent) => void): (() => void) => {
        const listeners = kit.listeners.get(name) ?? [];
        listeners.push(listener);
        kit.listeners.set(name, listeners);
        return () => {
          kit.listeners.set(
            name,
            listeners.filter((value) => value !== listener)
          );
        };
      },
    };
    destroy = kit.destroyed;
  },
  Draggable: class {
    constructor(options: Readonly<{ id: string; data: unknown }>) {
      kit.sources.push(options);
    }
    destroy = kit.releasedSource;
  },
  Droppable: class {
    constructor(
      options: Readonly<{
        id: string;
        accept: (source: Readonly<{ type: string; data: unknown }>) => boolean;
      }>
    ) {
      kit.targets.push(options);
    }
    destroy = kit.releasedTarget;
  },
}));
afterEach(() => {
  kit.listeners.clear();
  kit.sources.length = 0;
  kit.targets.length = 0;
  vi.clearAllMocks();
});
const event = (operation: DragEvent["operation"]): DragEvent => ({
  operation,
  canceled: false,
  preventDefault: vi.fn(),
});
const emit = (name: string, value: DragEvent): void => {
  for (const listener of kit.listeners.get(name) ?? []) listener(value);
};
const source = { kind: "widget", widgetId: ids.chart, label: "Chart" } as const;
const target = { kind: "widget-edge", widgetId: ids.metric, edge: "center" } as const;

it("guards drag initiation and final gestures after editing is disabled or the owner is disposed", () => {
  let enabled = false;
  const gesture = vi.fn();
  const owner = makeDashboardDragOwner({ enabled: () => enabled, gesture });
  const start = event({});
  emit("beforedragstart", start);
  expect(start.preventDefault).toHaveBeenCalledOnce();
  const dropped = event({ source: { data: source }, target: { id: "target", data: target } });
  emit("dragend", dropped);
  expect(gesture).not.toHaveBeenCalled();
  enabled = true;
  emit("dragend", dropped);
  expect(gesture).toHaveBeenCalledWith({
    kind: "swap-widgets",
    widgetId: ids.chart,
    withWidgetId: ids.metric,
  });
  const stale = [...(kit.listeners.get("dragend") ?? [])];
  owner.dispose();
  owner.dispose();
  for (const listener of stale) listener(dropped);
  expect(gesture).toHaveBeenCalledOnce();
  expect(kit.destroyed).toHaveBeenCalledOnce();
});

it("ignores cancellation and missing or malformed dnd transport data", () => {
  const gesture = vi.fn();
  const owner = makeDashboardDragOwner({ enabled: () => true, gesture });
  emit("beforedragstart", event({}));
  emit("dragend", event({}));
  emit("dragend", event({ source: { data: "bad" }, target: { id: "x", data: "bad" } }));
  emit("dragend", {
    ...event({ source: { data: source }, target: { id: "x", data: target } }),
    canceled: true,
  });
  expect(gesture).not.toHaveBeenCalled();
  owner.dispose();
});

it.each([
  { kind: "dashboard-edge", edge: "top" },
  target,
] satisfies ReadonlyArray<DashboardDropTarget>)(
  "owns target acceptance, highlighting and cleanup for $kind",
  (data) => {
    let enabled = true;
    const owner = makeDashboardDragOwner({ enabled: () => enabled, gesture: vi.fn() });
    const element = document.createElement("div");
    const release = owner.target({ element, data, depth: 1 });
    const mounted = kit.targets[0];
    if (mounted === undefined) throw new Error("Missing target");
    expect(mounted.accept({ type: "foreign", data: source })).toBe(false);
    expect(mounted.accept({ type: "dashboard-item", data: "bad" })).toBe(false);
    expect(mounted.accept({ type: "dashboard-item", data: source })).toBe(true);
    enabled = false;
    expect(mounted.accept({ type: "dashboard-item", data: source })).toBe(false);
    emit("dragover", event({ target: { id: mounted.id, data } }));
    expect(element.classList.contains("dashboard-drop-active")).toBe(true);
    emit("dragover", event({}));
    expect(element.classList.contains("dashboard-drop-active")).toBe(false);
    emit("dragend", event({}));
    release();
    expect(kit.releasedTarget).toHaveBeenCalledOnce();
    owner.dispose();
  }
);

it("registers distinct catalog and Widget sources and releases both handles", () => {
  const owner = makeDashboardDragOwner({ enabled: () => true, gesture: vi.fn() });
  const first = owner.source(document.createElement("button"), source);
  const entry = catalog[0];
  if (entry === undefined) throw new Error("Missing catalog entry");
  const second = owner.source(document.createElement("button"), {
    kind: "catalog",
    entry: Schema.decodeUnknownSync(DashboardCatalogEntry)(entry),
  });
  expect(kit.sources.map((value) => value.id)).toEqual([
    `dashboard-widget:${ids.chart}`,
    `dashboard-catalog:${entry.id}`,
  ]);
  first();
  second();
  expect(kit.releasedSource).toHaveBeenCalledTimes(2);
  owner.dispose();
});
