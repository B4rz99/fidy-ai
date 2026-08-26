# Dashboard drag-and-drop dependency

Research date: 2026-08-26. Question: which maintained dependency best fits Fidy's recursive Dashboard editor on React 19.2.8?

## Decision

Use **`@dnd-kit/react` 0.5.x**, not legacy **`@dnd-kit/core`**, behind one Dashboard-local interaction adapter. Keep canonical Dashboard state, gesture compilation, mutation submission, and accessible non-drag controls outside the dependency.

This is a fit decision rather than a claim that one drag-and-drop library is universally best. Fidy needs custom nested edge targets, pointer and touch interaction, keyboard drag support, React 19 compatibility, and no local reordering state. Among the evaluated maintained options, current dnd kit aligns most directly with those requirements.

## Current dnd kit

The active React package is now `@dnd-kit/react`. Its current package manifest is version 0.5.0, explicitly accepts React and React DOM 18 or 19, develops against React 19 types/runtime, and exposes draggable, droppable, sortable, hooks, and utility entry points ([package manifest](https://github.com/clauderic/dnd-kit/blob/main/packages/react/package.json)). Its first-party quickstart exposes `DragDropProvider`, `useDraggable`, and `useDroppable`, which are the exact primitives needed for Dashboard Widget sources and four edge targets without adopting a sortable-list state model ([React package README](https://github.com/clauderic/dnd-kit/blob/main/packages/react/README.md), [React quickstart](https://dndkit.com/react/quickstart)).

The current sensor documentation says `PointerSensor` handles mouse, touch, and pen, and `KeyboardSensor` is enabled by default. It also documents separate touch activation constraints and warns that replacing default sensors must retain the keyboard sensor ([sensor guide](https://dndkit.com/react/guides/sensors), [pointer sensor](https://dndkit.com/extend/sensors/pointer-sensor)). That is a closer match for Fidy's mobile and keyboard requirements than relying on native HTML drag behavior.

The project is actively maintained rather than archived: the repository was receiving fixes in July 2026, including keyboard-layout handling with new tests, and published `@dnd-kit/react` 0.5.0 on 2026-06-11 ([repository](https://github.com/clauderic/dnd-kit), [0.5.0 release](https://github.com/clauderic/dnd-kit/releases/tag/%40dnd-kit%2Freact%400.5.0), [keyboard fix](https://github.com/clauderic/dnd-kit/pull/2094)). The npm registry also shows 0.5.0 as the stable `latest` tag and newer beta publication activity ([npm registry metadata](https://registry.npmjs.org/@dnd-kit/react)).

### Risk

`@dnd-kit/react` is still a 0.x API. Its 0.4.0 release included event-type and plugin-configuration migration instructions, which is direct evidence that API churn is still possible ([0.4.0 release](https://github.com/clauderic/dnd-kit/releases/tag/%40dnd-kit%2Freact%400.4.0)). Fidy should therefore contain it behind one narrow module that translates library drag events into the web-owned `DashboardGesture`; components and canonical types should not depend on dnd-kit event types.

Do not newly adopt `@dnd-kit/core`. The npm registry's current stable version is 6.3.1, published 2024-12-05, while the repository and documentation now present `@dnd-kit/react` as the React adapter in the new multi-framework architecture ([legacy package metadata](https://registry.npmjs.org/@dnd-kit/core), [current repository README](https://github.com/clauderic/dnd-kit/blob/main/README.md)). Although `@dnd-kit/core` remains usable and widely installed, choosing it for new React 19 work would start on the legacy API line.

## Alternatives considered

### Atlassian Pragmatic Drag and Drop

Pragmatic Drag and Drop is actively published and its low-level core has strong nested-target and closest-edge facilities. The core is framework-independent and explicitly supports nested drop targets in inside-out order ([core package](https://atlassian.design/components/pragmatic-drag-and-drop/core-package), [drop targets](https://atlassian.design/components/pragmatic-drag-and-drop/core-package/drop-targets), [hitbox package](https://atlassian.design/components/pragmatic-drag-and-drop/optional-packages/hitbox/about)). This makes it a strong desktop alternative.

It is not the first choice for this Dashboard because it deliberately uses the web platform's native drag-and-drop behavior ([web-platform constraints](https://atlassian.design/components/pragmatic-drag-and-drop/web-platform-design-constraints)). Its own public tracker records unresolved or browser-dependent touchscreen behavior, including Android reliability and native long-press constraints ([touchscreen issue #204](https://github.com/atlassian/pragmatic-drag-and-drop/issues/204), [Windows touch issue #12](https://github.com/atlassian/pragmatic-drag-and-drop/issues/12), [iOS start issue #124](https://github.com/atlassian/pragmatic-drag-and-drop/issues/124)). These are user reports rather than guarantees from Atlassian, but they expose the exact mobile risk Fidy needs to avoid.

Pragmatic Drag and Drop also intentionally does not make pointer dragging keyboard accessible by itself. Atlassian recommends visible action menus/forms that provide equivalent outcomes and live-region feedback ([accessibility guidelines](https://atlassian.design/components/pragmatic-drag-and-drop/accessibility-guidelines)). Fidy should follow that accessible-alternative guidance regardless of the pointer library, but dnd kit additionally supplies a keyboard sensor for users who can operate a spatial keyboard drag.

### React Aria

React Aria provides the strongest integrated mouse, touch, keyboard, and screen-reader semantics of the candidates. Its drag-and-drop API is built around React Aria collection components such as ListBox, GridList, Tree, and Table, with root/on/before/after collection positions ([React Aria drag and drop](https://react-spectrum.adobe.com/react-aria/dnd.html)).

The Fidy Dashboard is a custom recursive split tree rendered with Base UI/shadcn rather than a React Aria collection. Adopting `react-aria-components` would introduce a second component/accessibility stack and force the Dashboard's four directional edge grammar into collection semantics. Its package also brings the broader React Aria and React Stately dependency layers ([package manifest](https://github.com/adobe/react-spectrum/blob/main/packages/react-aria-components/package.json)). It is maintained, but it is a poorer architectural fit here.

## Integration boundary

The dnd-kit adapter should own only:

- registering Widget and catalog drag sources;
- registering nested visual edge drop targets;
- pointer/touch/keyboard sensor configuration;
- drag overlay and active-target feedback; and
- translating a completed library event into a closed, web-owned drag outcome.

It must not own the Dashboard document, mutate the rendered tree optimistically, call the API, format canonical errors, or expose dnd-kit event types outside the adapter. Visible menu/dialog controls must offer the same move and placement outcomes without dragging.
