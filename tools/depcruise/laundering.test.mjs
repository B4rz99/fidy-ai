import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { launderingViolations } from "./laundering.mjs";

const packageRoot = "/synthetic/server";
const from = "src/shell/example/operations.ts";
const privateTarget = "src/shell/example/private.ts";

/**
 * @param {string} source - Synthetic Published Trio contents.
 * @param {string} [target] - Resolved import destination, independent of its written spelling.
 * @param {{publishedPath?: string, specifier?: string}} [location] - Graph source and import spelling.
 */
const inspect = (
  source,
  target = privateTarget,
  { publishedPath = from, specifier = "@example/source" } = {}
) =>
  launderingViolations(
    {
      modules: [
        { source: publishedPath, dependencies: [{ module: specifier, resolved: target }] },
        { source: publishedPath.replace(/operations\.ts$/u, "contract.ts"), dependencies: [] },
        { source: target, dependencies: [] },
      ],
    },
    packageRoot,
    (path) => (path === resolve(packageRoot, publishedPath) ? source : "export {};")
  );

const violation = {
  name: "published-interface-reexports-internal",
  from,
  to: privateTarget,
  reason:
    "Published interfaces own their declarations and behavior; private values and types cannot be republished through exports or aliases.",
};

await test("rejects a private binding exported through a path alias resolving to a flat private file", () => {
  assert.deepEqual(
    inspect('import { hidden as local } from "@example/source"; export { local as publicName };'),
    [violation]
  );
});

await test("rejects named, type-only, star and namespace exports directly from private modules", () => {
  for (const source of [
    'export { hidden as exposed } from "@example/source";',
    'export type { Hidden as Exposed } from "@example/source";',
    'export * from "@example/source";',
    'export * as exposed from "@example/source";',
  ]) {
    assert.deepEqual(inspect(source), [violation], source);
  }
});

await test("preserves private provenance through local aliases and default exports", () => {
  assert.deepEqual(
    inspect(`
    import hidden from "@example/source";
    const first = hidden;
    const second = first;
    const last = second;
    export default last;
  `),
    [violation]
  );
});

await test("rejects namespace property aliases even through assertions and direct exported declarations", () => {
  for (const declaration of [
    "export const exposed = hidden.value;",
    'export const exposed = hidden["value"];',
    "const alias = hidden; export const exposed = (alias.value as unknown)!;",
    "export default (hidden.value satisfies unknown);",
  ]) {
    assert.deepEqual(
      inspect(`import * as hidden from "@example/source"; ${declaration}`),
      [violation],
      declaration
    );
  }
});

await test("rejects renamed and nested destructured namespace aliases", () => {
  for (const declaration of [
    "const { value: alias } = hidden; export { alias };",
    "const { nested: { value: alias } } = hidden; export default alias;",
    "export const { value: exposed } = hidden;",
    "const { value, ...rest } = hidden; export { rest };",
  ]) {
    assert.deepEqual(
      inspect(`import * as hidden from "@example/source"; ${declaration}`),
      [violation],
      declaration
    );
  }
});

await test("rejects private types reached through local aliases and namespace type references", () => {
  for (const source of [
    'import type { Hidden } from "@example/source"; type Alias = Hidden; type Second = Alias; export type { Second as Published };',
    'import type { Hidden } from "@example/source"; type Second = Alias; type Alias = Hidden; export type { Second };',
    'import type * as Hidden from "@example/source"; export type Published = Readonly<Hidden.Row[]>;',
    'import { hidden } from "@example/source"; export type Published = typeof hidden;',
    'import type { Hidden } from "@example/source"; interface Local extends Hidden {} export interface Published extends Local {}',
  ]) {
    assert.deepEqual(inspect(source), [violation], source);
  }
});

await test("allows substantive wrappers to call private implementations and derive callable signatures", () => {
  assert.deepEqual(
    inspect(`
    import { hidden } from "@example/source";
    const implementation = hidden;
    export function invoke(input: Parameters<typeof hidden>[0]): ReturnType<typeof hidden> {
      const result = implementation(input);
      return result;
    }
    export const invokeAgain: typeof hidden = (input) => hidden(input);
    const localWrapper = (input: string) => hidden(input);
    export { localWrapper };
    export default function (input: string) { return hidden(input); }
  `),
    []
  );
});

await test("rejects private row types in outward parameter and return annotations", () => {
  for (const declaration of [
    "export function expose(input: Hidden): string { return String(input); }",
    "function local(input: string): Hidden { throw new Error(input); } export { local };",
    "export const expose = (input: Hidden): string => String(input);",
    "export const expose: (input: Hidden) => string = (input) => String(input);",
    "export default function (input: Hidden): string { return String(input); }",
  ]) {
    assert.deepEqual(
      inspect(`import type { Hidden } from "@example/source"; ${declaration}`),
      [violation],
      declaration
    );
  }
});

await test("allows published contracts, exact Shared Kernel and external package bindings", () => {
  for (const target of [
    "src/shell/example/contract.ts",
    "src/core/another-owner/contract.ts",
    "src/core/_shared/money.ts",
    "node_modules/effect/Schema.ts",
  ]) {
    assert.deepEqual(
      inspect(
        'import { Value } from "@example/source"; export const value = Value; export type Published = Value;',
        target
      ),
      [],
      target
    );
  }
});

await test("does not confuse local generic names or object member names with private imports", () => {
  assert.deepEqual(
    inspect(`
    import type { Hidden } from "@example/source";
    export type Public<Hidden> = { Hidden: Hidden };
    export interface PublicShape { Hidden: string; }
    export function identity<Hidden>(input: Hidden): Hidden { return input; }
  `),
    []
  );
});

await test("rejects private inline import types without a local import binding", () => {
  assert.deepEqual(inspect('export type Exposed = import("@example/source").Hidden;'), [violation]);
});

await test("uses resolved nested owner privacy rather than internal-looking import spellings", () => {
  assert.deepEqual(
    inspect('export { Value } from "./internal/contract";', "src/core/another-owner/contract.ts", {
      specifier: "./internal/contract",
    }),
    []
  );
  assert.deepEqual(
    inspect(
      'import * as implementation from "@example/source"; export default implementation.value;',
      "cloudflare/future/nested/internal/operations.ts",
      { publishedPath: "cloudflare/future/nested/operations.ts" }
    ),
    [
      {
        ...violation,
        from: "cloudflare/future/nested/operations.ts",
        to: "cloudflare/future/nested/internal/operations.ts",
      },
    ]
  );
});

await test("permits private aliases and private types that stay inside implementation bodies", () => {
  assert.deepEqual(
    inspect(`
    import { hidden, type Hidden } from "@example/source";
    const local = hidden;
    type PrivateAlias = Hidden;
    export function invoke(input: string): string {
      const result: PrivateAlias = local(input);
      return String(result);
    }
  `),
    []
  );
});

await test("allows Effect dual to publish newly declared pipeable behavior with a derived signature", () => {
  for (const declaration of [
    'import { Function } from "effect"; export const invoke: typeof hidden = Function.dual(2, (input, context) => hidden(input, context));',
    'import { Function as Fn } from "effect"; export const invoke: typeof hidden = Fn.dual(2, function (input, context) { return hidden(input, context); });',
    'import { dual as pipeable } from "effect/Function"; export const invoke: typeof hidden = pipeable(2, (input, context) => hidden(input, context));',
    'import * as Function from "effect/Function"; export const invoke: typeof hidden = Function.dual(2, (input: Parameters<typeof hidden>[0], context: string) => hidden(input, context));',
  ]) {
    assert.deepEqual(
      inspect(`import { hidden } from "@example/source"; ${declaration}`),
      [],
      declaration
    );
  }
});

await test("rejects private functions and private row signatures exposed through Effect dual", () => {
  for (const declaration of [
    'import { Function } from "effect"; export const exposed = Function.dual(2, hidden);',
    'import { dual } from "effect/Function"; const alias = hidden; export default dual(2, alias);',
    'import { Function } from "effect"; export const exposed = Function.dual(2, (input: Hidden, context: string) => hidden(input, context));',
  ]) {
    assert.deepEqual(
      inspect(`import { hidden, type Hidden } from "@example/source"; ${declaration}`),
      [violation],
      declaration
    );
  }
});

await test("does not grant callable publication to unrelated factories named Function or dual", () => {
  for (const factory of [
    "const Function = { dual: (_arity, _body) => hidden };",
    'import { Function } from "another-package";',
  ]) {
    assert.deepEqual(
      inspect(`
      import { hidden } from "@example/source";
      ${factory}
      export const exposed: typeof hidden = Function.dual(2, (input, context) => hidden(input, context));
    `),
      [violation],
      factory
    );
  }
});

await test("does not trust an Effect-looking factory import resolved to an owner-private module", () => {
  assert.deepEqual(
    inspect(
      `
    import { Function, hidden } from "effect";
    export const exposed: typeof hidden = Function.dual(2, (input, context) => hidden(input, context));
  `,
      privateTarget,
      { specifier: "effect" }
    ),
    [violation]
  );
});

await test("rejects private bindings published inside nested object members or spreads", () => {
  for (const declaration of [
    "export const api = { repository };",
    "export const api = { nested: { implementation: repository } };",
    "const alias = repository; const api = { implementation: alias }; export { api };",
    "export default { ...repository };",
  ]) {
    assert.deepEqual(
      inspect(`import { repository } from "@example/source"; ${declaration}`),
      [violation],
      declaration
    );
  }
});

await test("rejects private values published through arrays and array spreads", () => {
  for (const declaration of [
    "export const api = [repository];",
    "export default [{ nested: [repository] }];",
    "const values = [repository]; export const api = [...values];",
  ]) {
    assert.deepEqual(
      inspect(`import { repository } from "@example/source"; ${declaration}`),
      [violation],
      declaration
    );
  }
});

await test("rejects callables that return private bindings rather than invoking owner behavior", () => {
  for (const declaration of [
    "export const acquire = () => repository;",
    "export function acquire() { return repository; }",
    "const acquire = function () { return { nested: repository }; }; export { acquire };",
    "export default () => () => repository;",
  ]) {
    assert.deepEqual(
      inspect(`import * as repository from "@example/source"; ${declaration}`),
      [violation],
      declaration
    );
  }
});

await test("follows private aliases declared inside outward callable bodies", () => {
  for (const declaration of [
    "export function acquire() { const alias = repository; return alias; }",
    "export const acquire = () => { const { value: alias } = repository; return { alias }; };",
    "export function acquire() { function local() { return repository; } return local; }",
  ]) {
    assert.deepEqual(
      inspect(`import * as repository from "@example/source"; ${declaration}`),
      [violation],
      declaration
    );
  }
});

await test("allows wrapper results and closures while keeping shadowed and unused private aliases local", () => {
  assert.deepEqual(
    inspect(`
    import { repository, type PrivateResult } from "@example/source";
    export function invoke(input: string) {
      const local = repository;
      const result: PrivateResult = local(input);
      function unused() { return repository; }
      return result;
    }
    export function shadow(repository: string) { return { repository }; }
    export const acquire = () => (input: string) => repository(input);
    export const api = { invoke: (input: string) => repository(input) };
  `),
    []
  );
});

await test("rejects object methods and getters that return private implementations", () => {
  for (const declaration of [
    "export const api = { acquire() { return repository; } };",
    "export const api = { get repository() { return implementation.repository; } };",
    "export const api = { nested: { acquire: () => repository } };",
  ]) {
    assert.deepEqual(
      inspect(
        `import { repository } from "@example/source"; import * as implementation from "@example/source"; ${declaration}`
      ),
      [violation],
      declaration
    );
  }
});

await test("rejects statically resolved dynamic-import namespaces and their awaited private aliases", () => {
  for (const source of [
    'const repository = await import("@example/source"); export { repository };',
    'export const acquire = async () => { const { repository } = await import("@example/source"); return repository; };',
    'export const api = { acquire: async () => (await import("@example/source")).repository };',
    'export default import("@example/source");',
  ]) {
    assert.deepEqual(inspect(source), [violation], source);
  }
});

await test("allows dynamic implementation loading when only the invoked behavior result is published", () => {
  assert.deepEqual(
    inspect(`
    export async function invoke(input: string) {
      const { behavior } = await import("@example/source");
      return behavior(input);
    }
  `),
    []
  );
  assert.deepEqual(
    inspect(
      'export const api = await import("@example/source");',
      "src/core/another-owner/contract.ts"
    ),
    []
  );
});

await test("does not confuse a selected wrapper property with private siblings in a local container", () => {
  assert.deepEqual(
    inspect(`
    import { repository } from "@example/source";
    const local = { repository, invoke: (input: string) => repository(input) };
    const alias = local;
    export const api = { invoke: alias.invoke };
  `),
    []
  );
});

await test("retains private container provenance when a selected or declared key is dynamic", () => {
  for (const declaration of [
    'const api = { repository }; const key = "repository"; export const exposed = api[key];',
    'const key = "repository"; const api = { [key]: repository }; export const exposed = api.repository;',
  ]) {
    assert.deepEqual(
      inspect(`import { repository } from "@example/source"; ${declaration}`),
      [violation],
      declaration
    );
  }
});

await test("retains private identities selected by conditional and short-circuit operands", () => {
  for (const expression of [
    "enabled ? repository : undefined",
    "enabled ? undefined : repository",
    "enabled && repository",
    "repository || fallback",
    "fallback ?? repository",
    "(touch(), repository)",
  ]) {
    assert.deepEqual(
      inspect(`import { repository } from "@example/source"; export const api = ${expression};`),
      [violation],
      expression
    );
  }
});

await test("does not attribute predicates, arithmetic or discarded comma operands to the selected value", () => {
  assert.deepEqual(
    inspect(`
    import { repository } from "@example/source";
    export const exists = repository ? true : false;
    export const matches = repository === undefined;
    export const count = repository.length + 1;
    export const ready = (repository, true);
    export const invoke = (input: string) => enabled ? repository(input) : fallback(input);
  `),
    []
  );
});

await test("rejects exported classes and local class aliases exposing private field values", () => {
  for (const declaration of [
    "export class Api { repository = hidden; }",
    "export default class { static repository = hidden; }",
    "export const Api = class { accessor repository = hidden; };",
    "class Local { repository = { hidden }; } const Alias = Local; export { Alias };",
  ]) {
    assert.deepEqual(
      inspect(`import { hidden } from "@example/source"; ${declaration}`),
      [violation],
      declaration
    );
  }
});

await test("allows classes that retain private implementation fields and publish substantive behavior", () => {
  assert.deepEqual(
    inspect(`
    import { hidden } from "@example/source";
    export class Api {
      private implementation = hidden;
      #stored = hidden;
      private static shared = hidden;
      invoke(input: string) { return this.implementation(input); }
      invokeStored(input: string) { return this.#stored(input); }
      static invokeShared(input: string) { return this.shared(input); }
    }
  `),
    []
  );
});

await test("rejects public class methods and accessors returning private bindings", () => {
  for (const member of [
    "acquire() { return hidden; }",
    "get repository() { return { hidden }; }",
    "static acquire() { const alias = hidden; return alias; }",
    "invoke(input: Hidden): string { return String(input); }",
  ]) {
    assert.deepEqual(
      inspect(
        `import { hidden, type Hidden } from "@example/source"; export class Api { ${member} }`
      ),
      [violation],
      member
    );
  }
});

await test("rejects private class heritage and public generic constraints", () => {
  for (const declaration of [
    "export class Api extends Hidden {}",
    "export const Api = class implements Hidden {};",
    "class Local extends Hidden {} const Alias = Local; export default Alias;",
    "export class Api<T extends Hidden> {}",
  ]) {
    assert.deepEqual(
      inspect(`import { Hidden } from "@example/source"; ${declaration}`),
      [violation],
      declaration
    );
  }
});

await test("allows class inheritance and types from a published declaration", () => {
  assert.deepEqual(
    inspect(
      `
    import { Contract } from "@example/source";
    export class Api<T extends Contract> extends Contract {
      value?: T;
      invoke(input: Contract): Contract { return input; }
    }
  `,
      "src/core/another-owner/contract.ts"
    ),
    []
  );
});

await test("rejects public accessors and field aliases that release private class storage", () => {
  for (const declaration of [
    "export class Api { private stored = hidden; get repository() { return this.stored; } }",
    "export class Api { #stored = hidden; acquire() { return this.#stored; } }",
    "export const Api = class { #stored = hidden; repository = this.#stored; };",
    "export class Api { private acquire() { return hidden; } get factory() { return this.acquire; } }",
  ]) {
    assert.deepEqual(
      inspect(`import { hidden } from "@example/source"; ${declaration}`),
      [violation],
      declaration
    );
  }
});

await test("rejects private values stored in public constructor parameter properties", () => {
  for (const declaration of [
    "export class Api { constructor(public repository = hidden) {} }",
    "export class Api { constructor(readonly repository = hidden) {} }",
  ]) {
    assert.deepEqual(
      inspect(`import { hidden } from "@example/source"; ${declaration}`),
      [violation],
      declaration
    );
  }
  assert.deepEqual(
    inspect(`import { hidden } from "@example/source"; export class Api {
    constructor(private repository = hidden) {}
    invoke(input: string) { return this.repository(input); }
  }`),
    []
  );
});

await test("retains private identity through assignments to public class fields and local aliases", () => {
  for (const declaration of [
    "export class Api { repository: unknown; constructor() { this.repository = hidden; } }",
    "export class Api { repository: unknown; constructor() { this.repository ??= hidden; } }",
    "export class Api { #stored: unknown; constructor() { this.#stored = hidden; } get repository() { return this.#stored; } }",
    "let alias; alias = hidden; export class Api { repository = alias; }",
    "let alias; export const repository = (alias = hidden);",
    "let alias; alias ||= hidden; export const repository = alias;",
  ]) {
    assert.deepEqual(
      inspect(`import { hidden } from "@example/source"; ${declaration}`),
      [violation],
      declaration
    );
  }
  assert.deepEqual(
    inspect(`import { hidden } from "@example/source"; export class Api {
    #stored: unknown;
    constructor() { this.#stored = hidden; }
    invoke(input: string) { return hidden(input); }
  }`),
    []
  );
});

await test("rejects accessors that expose a private constructor parameter property", () => {
  assert.deepEqual(
    inspect(`
    import { hidden } from "@example/source";
    export class Api {
      constructor(private repository = hidden) {}
      get exposed() { return this.repository; }
    }
  `),
    [violation]
  );
});

await test("rejects private types exposed by a class index signature", () => {
  assert.deepEqual(
    inspect(
      'import type { Hidden } from "@example/source"; export class Api { [key: string]: Hidden; }'
    ),
    [violation]
  );
});

await test("rejects a private implementation assigned after a container is exported", () => {
  assert.deepEqual(
    inspect(`
    import { hidden } from "@example/source";
    export const api = { invoke: (input: string) => input };
    api.invoke = hidden;
  `),
    [violation]
  );
});

await test("does not taint an unrelated selected property when a sibling receives a private binding", () => {
  assert.deepEqual(
    inspect(`
    import { hidden } from "@example/source";
    const api = { invoke: (input: string) => input, safe: (input: string) => hidden(input) };
    api.invoke = hidden;
    export const safe = api.safe;
  `),
    []
  );
});

await test("tracks alias, array-index and unknown-key writes into the published container", () => {
  for (const declaration of [
    "export const api = {}; const alias = api; alias.invoke = hidden;",
    "export const api = []; api[0] = hidden;",
    'export const api = {}; api["invoke"] ||= hidden;',
    "export const api = {}; api[key] ??= hidden;",
    "export const api = createApi(); api.invoke = hidden;",
    "export let api: { invoke?: unknown }; api.invoke = hidden;",
  ]) {
    assert.deepEqual(
      inspect(`import { hidden } from "@example/source"; ${declaration}`),
      [violation],
      declaration
    );
  }
});

await test("keeps selected safe members separate for arrays, nested literals and factory-created containers", () => {
  for (const declaration of [
    "const api = createApi(); api.private = hidden; export const safe = api.safe;",
    "const api = [(input: string) => input, (input: string) => hidden(input)]; api[0] = hidden; export const safe = api[1];",
    "const api = { nested: { private: undefined, safe: (input: string) => hidden(input) } }; api.nested.private = hidden; export const safe = api.nested.safe;",
  ]) {
    assert.deepEqual(
      inspect(`import { hidden } from "@example/source"; ${declaration}`),
      [],
      declaration
    );
  }
});

await test("follows assigned and shared nested aliases to the same outward container", () => {
  for (const declaration of [
    "export const api = {}; let alias; alias = api; alias.invoke = hidden;",
    "export const child = {}; const api = { child }; const alias = api.child; alias.invoke = hidden;",
    "export const api = {}; (choose ? api : other).invoke = hidden;",
  ]) {
    assert.deepEqual(
      inspect(`import { hidden } from "@example/source"; ${declaration}`),
      [violation],
      declaration
    );
  }
});

await test("retains private identity through the genuine global Object freeze and seal helpers", () => {
  for (const helper of ["freeze", "seal"]) {
    assert.deepEqual(
      inspect(
        `import { hidden } from "@example/source"; export const api = Object.${helper}(hidden);`
      ),
      [violation],
      helper
    );
  }
});

await test("does not treat a lexically shadowed Object helper as the global identity helper", () => {
  assert.deepEqual(
    inspect(`
    import { hidden } from "@example/source";
    const Object = { freeze: (value: unknown) => 1 };
    export const count = Object.freeze(hidden);
    export function invoke(Object: { seal(value: unknown): number }) { return Object.seal(hidden); }
  `),
    []
  );
});

await test("tracks global Object assignments and property descriptors into the outward container", () => {
  for (const declaration of [
    "export const api = {}; Object.assign(api, { invoke: hidden });",
    'export const api = Object.defineProperty({}, "invoke", { value: hidden });',
    'export const api = {}; Object.defineProperty(api, "invoke", { get() { return hidden; } });',
  ]) {
    assert.deepEqual(
      inspect(`import { hidden } from "@example/source"; ${declaration}`),
      [violation],
      declaration
    );
  }
});

await test("preserves safe selected siblings and shadowed helpers around Object assignment syntax", () => {
  assert.deepEqual(
    inspect(`
    import { hidden } from "@example/source";
    const api = { safe: (input: string) => hidden(input) };
    Object.assign(api, { private: hidden });
    export const safe = api.safe;
    export function invoke(Object: { assign(...args: unknown[]): number }) { return Object.assign({}, { hidden }); }
  `),
    []
  );
});

await test("tracks inserted private values in known outward arrays", () => {
  for (const mutation of [
    "api.push(hidden);",
    "api.unshift(hidden);",
    "api.splice(0, 0, hidden);",
  ]) {
    assert.deepEqual(
      inspect(`import { hidden } from "@example/source"; export const api = []; ${mutation}`),
      [violation],
      mutation
    );
  }
});

await test("does not treat ordinary push methods or computed array-mutation results as private values", () => {
  assert.deepEqual(
    inspect(`
    import { hidden } from "@example/source";
    const local = [];
    export const count = local.push(hidden);
    export const size = local.length;
    const api = { push: (value: unknown) => 1 };
    export const result = api.push(hidden);
    export const invoke = (input: string) => hidden(input);
  `),
    []
  );
});

await test("tracks outward container writes through identity-selecting logical aliases", () => {
  for (const operator of ["&&", "||", "??", "&&=", "||=", "??="]) {
    assert.deepEqual(
      inspect(`
        import { hidden } from "@example/source";
        type Api = { invoke?: (input: string) => string };
        declare let alternative: Api | undefined;
        export const api: Api = {};
        const alias = alternative ${operator} api;
        if (alias !== undefined) alias.invoke = hidden;
      `),
      [violation],
      operator
    );
  }
});

await test("logical container aliases preserve unrelated safe member publication", () => {
  for (const operator of ["&&", "||", "??"]) {
    assert.deepEqual(
      inspect(`
        import { hidden } from "@example/source";
        const api = { invoke: (input: string) => input, safe: (input: string) => input.length };
        declare const alternative: typeof api | undefined;
        const alias = alternative ${operator} api;
        if (alias !== undefined) alias.invoke = hidden;
        export const invokeSafe = api.safe;
      `),
      [],
      operator
    );
  }
});

await test("Published Trio files reject namespace blocks for both type and value publication", () => {
  const namespaceViolation = {
    name: "published-interface-namespace",
    from,
    to: from,
    reason:
      "Published Trio files declare earned names directly; TypeScript namespace and module blocks cannot wrap or hide their public surface.",
  };
  for (const source of [
    'import type { PrivateRow } from "@example/source"; export namespace Published { export type Row = PrivateRow; }',
    'import { hidden } from "@example/source"; export namespace Published { export const invoke = hidden; }',
    'import { hidden } from "@example/source"; namespace Local { export const invoke = hidden; } export { Local as Published };',
  ]) {
    assert.deepEqual(inspect(source), [namespaceViolation], source);
  }
});

await test("ordinary ES-module namespace imports remain usable for substantive operations", () => {
  assert.deepEqual(
    inspect(
      'import * as implementation from "@example/source"; export const invoke = (input: string) => implementation.invoke(input);'
    ),
    []
  );
});
