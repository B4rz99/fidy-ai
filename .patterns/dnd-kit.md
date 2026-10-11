# Native drag and drop

Compile against installed `@dnd-kit/dom@0.5.0`. Verify lifecycle and sensors in
`.repos/dnd-kit`; Foldkit Mounts own element bindings.

## Ownership and lifecycle

Create one stable `DragDropManager` per editable canvas. Bind `Draggable` and `Droppable`
instances to inserted elements and destroy them through scoped Mount cleanup. Dispose the
manager when the feature closes. Keep manager state private; translate a completed drop into
one closed application gesture and validate against the canonical edit schema.

Sources: `packages/dom/src/core/manager/manager.ts`,
`packages/dom/src/core/entities/draggable/draggable.ts`, and
`packages/dom/src/core/entities/droppable/droppable.ts`.

Use function configuration to extend defaults. Retain PointerSensor and KeyboardSensor,
Accessibility, AutoScroller, Cursor, Feedback and PreventSelection. Configure localized
Accessibility instructions and human-readable announcements.
Sources: `packages/dom/src/core/manager/manager.ts` and
`packages/dom/src/core/plugins/accessibility/Accessibility.ts`.

Foldkit OnMount runs on insertion. Key subtrees when binding identity or captured configuration
changes. Guards read current edit availability: stale views, pending mutations and uncertain
acknowledgements disable gestures.

## Sources, targets and completion

Use real button handles, stable canonical IDs, visible focus and `touch-action: none` on the
handle. Source `type` and target `accept` reject incompatible and self-targeted gestures.
Decode both data discriminants again at completion.

Partition each Widget into five directional/center targets. Deeper targets have greater collision
priority; dashboard top/bottom targets have lower priority. Monitor `dragover` for feedback and
clear it on `dragend`, including cancellation.
Sources: `packages/abstract/src/core/collision/observer.ts`,
`packages/abstract/src/core/collision/utilities.ts`, and
`packages/abstract/src/core/manager/events.ts`.

Canceled, disabled, missing or malformed interactions emit no edit. Successful completion emits
at most one gesture. Visual previews preserve the last canonical view.
Sources: `packages/abstract/src/core/manager/actions.ts` and
`apps/web/src/features/dashboard/native-drag.ts`.

## Pointer and keyboard verification

PointerSensor handles mouse, touch and pen and protects ordinary interactive descendants.
KeyboardSensor starts on Space/Enter, cancels on Escape, finishes on Space/Enter/Tab, and
moves spatially: ten pixels per arrow, five times farther with Shift. Preserve both sensors.
Sources: `packages/dom/src/core/sensors/pointer/PointerSensor.ts` and
`packages/dom/src/core/sensors/keyboard/KeyboardSensor.ts`.

Test real styled geometry in a browser: pointer drop, keyboard reachability, cancellation,
focus and nested precedence. Keep pure translation tests for malformed data and self-targets.
Resize separators retain keyboard controls and private pointer previews. Cancellation restores
canonical weights; successful completion issues exactly one resize edit.
