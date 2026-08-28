# dnd kit

How the current `@dnd-kit/react` 0.5.0 system behaves, read from the checked-out upstream
subtree. The package version is pinned in `.repos/dnd-kit/packages/react/package.json:1-9`.
Citations are relative to `.repos/dnd-kit/`. Use the installed public API as the application
contract and this checkout to verify lifecycle, sensors, collision selection, and accessibility.

## Public boundary and ownership

Compile application code against `@dnd-kit/react`, not files inside `.repos/dnd-kit`. The React
package is a thin adapter over the DOM manager and exposes `DragDropProvider`, `DragOverlay`,
`useDraggable`, and `useDroppable`; its package declares React 18 or 19 peers
(`packages/react/package.json:1-9`, `packages/react/package.json:48-61`).

Keep dnd kit behind a feature-local adapter. Source and target `data`, entity IDs, collision details,
and drag events are interaction transport, not domain state. The adapter should emit a closed
application gesture on a successful drop. It must not own or optimistically rewrite the canonical
Dashboard document.

Use one `DragDropProvider` around one independently editable canvas. The provider creates a stable
manager, subscribes the current callbacks to its monitor, updates plugins/sensors/modifiers when
their values change, and destroys the manager on unmount
(`packages/react/src/core/context/DragDropProvider.tsx:47-90`,
`packages/react/src/core/context/DragDropProvider.tsx:92-145`,
`packages/react/src/core/context/DragDropProvider.tsx:148-167`). Do not create a manager during
application render or mirror its operation into a second drag state owner.

Passing an array for `plugins`, `sensors`, or `modifiers` replaces defaults; use the function form
when extending them (`apps/docs/docs/react/components/drag-drop-provider.mdx:86-108`). This matters
because the default manager includes pointer and keyboard sensors plus Accessibility, AutoScroller,
Cursor, Feedback, and PreventSelection (`packages/dom/src/core/manager/manager.ts:27-55`).

## Draggable and droppable hooks

`useDraggable` creates one entity instance, updates its mutable inputs as React values change, and
returns separate `ref` and `handleRef` callbacks plus reactive status getters
(`packages/react/src/core/draggable/useDraggable.ts:15-41`,
`packages/react/src/core/draggable/useDraggable.ts:68-101`). `ref` identifies the dragged element;
`handleRef` identifies the activator. Prefer a real `<button>` handle so the Widget body can retain
normal links, forms, text selection, and scrolling.

`useDroppable` likewise creates one entity, defaults to the standard collision detector, updates
`accept`, `data`, disabled state and type, and returns `ref` plus `isDropTarget`
(`packages/react/src/core/droppable/useDroppable.ts:17-55`,
`packages/react/src/core/droppable/useDroppable.ts:57-76`). Both hooks register their entity in a
layout effect and unregister it through the returned cleanup
(`packages/react/src/core/hooks/useInstance.ts:15-27`). Give every source and edge target a stable,
semantic ID derived from canonical identity and edge, never an array index.

Use source `type` and target `accept` to reject incompatible interactions before collision
selection. A target with no `accept` accepts all sources; otherwise acceptance compares source type
or invokes the supplied predicate (`packages/abstract/src/core/entities/droppable/droppable.ts:69-108`).
Still validate the source/target discriminants in the adapter's completed-event translator: dnd kit
entity data is not a substitute for canonical schema decoding.

## Pointer and touch behavior

The default PointerSensor covers mouse, touch, and pen
(`apps/docs/docs/extend/sensors/pointer-sensor.mdx:8-26`). Its current defaults activate mouse input
immediately on an explicit handle, use a 250 ms/5 px delay for touch, protect text inputs, and use a
200 ms delay or 5 px distance for other pointer contexts
(`packages/dom/src/core/sensors/pointer/PointerSensor.ts:31-76`). It ignores secondary pointers,
non-primary mouse buttons, disabled sources, already-captured events, and starts only while the
manager is idle (`packages/dom/src/core/sensors/pointer/PointerSensor.ts:169-189`). Keep these
defaults unless interaction tests demonstrate a concrete problem.

Attach pointer activation to the visible drag handle rather than the whole Widget. The sensor binds
to `handle ?? element`, while its default prevention logic leaves unrelated interactive descendants
alone (`packages/dom/src/core/sensors/pointer/PointerSensor.ts:137-166`,
`packages/dom/src/core/sensors/pointer/PointerSensor.ts:44-76`). Apply `touch-action: none` to the
small handle only, not the canvas or Widget body, so touch dragging is reliable without disabling
ordinary page scrolling. This follows the upstream Pointer Events guidance
(`apps/docs/docs/legacy/api-documentation/draggable.mdx:157-175`).

## Keyboard and screen-reader behavior

Do not replace the default sensors without retaining KeyboardSensor. Its default bindings start on
Space or Enter, cancel on Escape, finish on Space, Enter, or Tab, and move with arrow keys; it only
activates when the event target is the source handle or element
(`packages/dom/src/core/sensors/keyboard/KeyboardSensor.ts:37-72`,
`packages/dom/src/core/sensors/keyboard/KeyboardSensor.ts:92-133`). Movement is spatial: 10 px per
arrow press and five times that with Shift (`packages/dom/src/core/sensors/keyboard/KeyboardSensor.ts:230-273`).
Therefore edge targets must be visibly sized and reachable by spatial movement; keyboard drag does
not understand the Dashboard's structural grammar by itself.

Key matching uses `KeyboardEvent.key`, respects keyboard layouts, and supports a Space alias
(`apps/docs/docs/extend/sensors/keyboard-sensor.mdx:74-80`). Use a visible focus ring on every drag
handle and test Space, Enter, arrows, Escape, and drop against the actual recursive target geometry.
Give KeyboardSensor one semantic destination per Dashboard outcome. Keep resize separators and direct
Widget actions focusable; catalog additions remain keyboard drags rather than a parallel form flow.

The default Accessibility plugin adds focusability and ARIA state to each activator, associates
screen-reader instructions, and maintains a polite live region
(`packages/dom/src/core/plugins/accessibility/Accessibility.ts:150-201`,
`packages/dom/src/core/plugins/accessibility/LiveRegion.ts:1-20`). Its stock instructions and
announcements are English and expose raw entity IDs
(`packages/dom/src/core/plugins/accessibility/defaults.ts:3-35`). For a Spanish Dashboard, configure
localized, human-readable instructions and announcements through `Accessibility.configure`; the
official React example extends provider defaults rather than replacing them
(`apps/docs/docs/extend/plugins/accessibility.mdx:8-16`,
`apps/docs/docs/extend/plugins/accessibility.mdx:46-78`). This requires a direct `@dnd-kit/dom`
dependency because application code must not rely on an undeclared transitive import.

## Nested edge-target collision selection

The standard detector tries pointer intersection and falls back to dragged-shape intersection
(`packages/collision/src/algorithms/default.ts:1-14`). Pointer hits receive high priority and are
scored by inverse distance to target center; shape hits receive normal priority and combine overlap
ratio with pointer distance (`packages/collision/src/algorithms/pointerIntersection.ts:5-44`,
`packages/collision/src/algorithms/shapeIntersection.ts:5-43`). The observer excludes disabled or
non-accepting targets, computes all candidates, then sorts them
(`packages/abstract/src/core/collision/observer.ts:92-145`). Sorting is priority first, then collision
type, then score; the first candidate becomes the operation target
(`packages/abstract/src/core/collision/utilities.ts:3-17`,
`packages/abstract/src/core/collision/notifier.ts:44-64`).

Consequences for a recursive Dashboard:

- Render five non-overlapping targets that partition each Widget body: four directional edges plus a
  center swap target. The full body should resolve to one semantic outcome for pointer and keyboard.
- Keep targets transparent and non-intercepting so normal Widget controls remain usable; show only
  the selected target as feedback through `isDropTarget`.
- When a descendant edge overlaps an ancestor edge, assign a greater numeric
  `collisionPriority` to the deeper target. Upstream explicitly supports numeric priority for
  overlapping targets (`apps/docs/docs/react/guides/collision-detection.mdx:100-118`).
- Keep dashboard-level top/bottom targets lower priority than Widget edges.
- Use `isDropTarget` only for feedback; compile the completed target's semantic data into one
  application gesture.

## Completion, rejection, and overlays

`dragend` supplies an operation snapshot, an explicit `canceled` flag, and an optional suspension
handle (`packages/abstract/src/core/manager/events.ts:119-129`). The manager dispatches this snapshot
before resetting the operation (`packages/abstract/src/core/manager/actions.ts:301-315`). The adapter
should emit nothing when canceled, when source or target is absent, when their discriminants are
incompatible, or when moving a Widget onto its own edge. Otherwise it emits exactly one closed
Dashboard gesture. Canonical schema decoding and the API mutation remain outside dnd kit.

Render at most one `DragOverlay` per provider, using its function child to derive the preview from
the active source (`apps/docs/docs/react/components/drag-overlay.mdx:35-54`). The overlay is visual
feedback only. It must not be interpreted as a committed layout change, and mutation rejection must
leave the last successful Dashboard view rendered.

## Fidy adapter checklist

- One Dashboard-local `drag-adapter.tsx`; no dnd kit types escape its exports.
- Stable semantic source and target IDs, with a closed discriminated `data` union.
- Widget and catalog sources use explicit button handles with visible focus and
  `touch-action: none` only on the handles.
- Five non-overlapping Widget targets covering the full Widget body, plus lower-priority dashboard
  top/bottom targets.
- Descendant priority beats ancestor priority in overlapping recursive regions.
- Default PointerSensor and KeyboardSensor retained.
- Localized Accessibility plugin configuration and a direct `@dnd-kit/dom` dependency if imported.
- One overlay per provider; target feedback derives from `isDropTarget`.
- `onDragEnd` emits at most one `DashboardGesture`; no local Dashboard reducer and no API call in
  the adapter.
- Unit-test event translation, cancellation, malformed data, nested target priority, and accessibility
  configuration without geometry. Browser-smoke-test a real pointer edit plus the deterministic
  keyboard controls. When changing sensor or target geometry, add focused browser coverage for the
  affected touch sizing, keyboard reachability, precedence, cancellation, or focus behavior.

## Known limits to test rather than assume

Spatial keyboard movement advances by pixels rather than logical edge order. Deep or very small
recursive regions may therefore require several arrow presses or Shift+Arrow; retain generous,
semantic target geometry. Pointer target selection is geometry-dependent at overlapping corners;
verify the actual styled target dimensions in browser tests. These are integration questions, not
reasons to let dnd kit own Dashboard layout semantics.
