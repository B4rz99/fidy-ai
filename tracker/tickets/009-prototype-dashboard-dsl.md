---
id: 009
title: "Prototype: dashboard-as-document DSL"
label: wayfinder:prototype
status: open
assignee:
blocked-by: []
---

## Question

What does the declarative dashboard document look like, concretely? Build a throwaway prototype (via /prototype) to react to:

- Block/widget schema (spending chart, budget bar, transaction list, custom metric) and layout model.
- The same document edited two ways: a user drag-drop/settings interaction, and an agent tool call ("add a restaurants-spending widget at the top").
- Where the document lives and how edits are validated (the type-strict, no-silent-fallback constraint applies to the DSL itself).

Resolution = the DSL's shape is decided and linked as an asset; the prototype is throwaway.
