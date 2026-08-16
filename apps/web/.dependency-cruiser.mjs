// The web graph gate. It keeps the browser application a strict vertical composition rather than
// allowing routes, features, session state, and transport to become a second flat shell.
/** @type {import("dependency-cruiser").IConfiguration} */
export default {
  forbidden: [
    {
      name: "feature-imports-sibling",
      severity: "error",
      comment:
        "A feature imported another feature. Features are vertical modules with one public " +
        "feature.tsx interface; compose them in app/routes.tsx instead.",
      from: { path: "^src/features/([^/]+)/" },
      to: {
        path: "^src/features/[^/]+/",
        pathNot: "^src/features/$1/",
      },
    },
    {
      name: "feature-imports-application",
      severity: "error",
      comment:
        "A feature imported the composition root. The dependency arrow points from app to a " +
        "feature interface, never from a feature back into app.",
      from: { path: "^src/features/" },
      to: { path: "^src/app/" },
    },
    {
      name: "application-imports-feature-private",
      severity: "error",
      comment:
        "Application composition reached a feature private module. Import only that feature's " +
        "feature.tsx interface; its atoms, views, policies, and transport remain private.",
      from: { path: "^src/(app|main\\.tsx$)" },
      to: {
        path: "^src/features/",
        pathNot: "^src/features/[^/]+/feature\\.tsx$",
      },
    },
    {
      name: "main-imports-only-application",
      severity: "error",
      comment:
        "The browser entrypoint may mount only WebApplication. Compose session, transport, and " +
        "features in app rather than turning main.tsx into a second composition root.",
      from: { path: "^src/main\\.tsx$" },
      to: {
        path: "^src/",
        pathNot: ["^src/app/application\\.tsx$", "^src/index\\.css$"],
      },
    },
    {
      name: "generic-dumping-ground",
      severity: "error",
      comment:
        "A generic components, hooks, services, stores, or utils directory hides ownership. " +
        "Place code in its vertical app, feature, session, transport, or UI module instead.",
      from: { path: "^src/" },
      to: {
        path:
          "^(?:src/(?:components|hooks|services|stores|utils)/|" +
          "src/[^/]+/(?:components|hooks|services|stores|utils)/|" +
          "src/[^/]+/[^/]+/(?:components|hooks|services|stores|utils)/|" +
          "src/[^/]+/[^/]+/[^/]+/(?:components|hooks|services|stores|utils)/)",
        pathNot: "^src/ui/components/",
      },
    },
    {
      name: "non-feature-imports-feature-private",
      severity: "error",
      comment:
        "A non-feature module imported a feature implementation. The only public feature " +
        "surface is feature.tsx.",
      from: {
        path: "^src/",
        pathNot: ["^src/features/", "^src/app/", "^src/main\\.tsx$"],
      },
      to: {
        path: "^src/features/",
        pathNot: "^src/features/[^/]+/feature\\.tsx$",
      },
    },
    {
      name: "ui-imports-application-code",
      severity: "error",
      comment:
        "Ownerless UI imported application, feature, session, or transport code. UI primitives " +
        "receive values and children; they do not decide product behavior.",
      from: { path: "^src/ui/" },
      to: { path: "^src/(app|features|session|transport)/" },
    },
    {
      name: "session-imports-features",
      severity: "error",
      comment:
        "Session lifetime infrastructure imported a feature. Authentication transitions replace " +
        "registries; they do not know product feature implementations.",
      from: { path: "^src/session/" },
      to: { path: "^src/features/" },
    },
    {
      name: "session-imports-application",
      severity: "error",
      comment:
        "Session lifetime infrastructure imported the composition root. Authentication state is " +
        "composed by app, never owned by it.",
      from: { path: "^src/session/" },
      to: { path: "^src/app/" },
    },
    {
      name: "session-imports-ui",
      severity: "error",
      comment:
        "Session lifetime infrastructure imported ownerless UI. Session owns registry lifetime, " +
        "not visual presentation.",
      from: { path: "^src/session/" },
      to: { path: "^src/ui/" },
    },
    {
      name: "transport-imports-features",
      severity: "error",
      comment:
        "Transport imported a feature. The transport owns the canonical client seam, while " +
        "features consume application-level transport values without a reverse dependency.",
      from: { path: "^src/transport/" },
      to: { path: "^src/features/" },
    },
    {
      name: "transport-imports-application",
      severity: "error",
      comment:
        "Transport imported the composition root. The dependency arrow points from app to " +
        "transport, never from transport back into app.",
      from: { path: "^src/transport/" },
      to: { path: "^src/app/" },
    },
    {
      name: "transport-imports-session",
      severity: "error",
      comment:
        "Transport imported session lifetime infrastructure. Transport remains independent of " +
        "authentication state and is composed by app.",
      from: { path: "^src/transport/" },
      to: { path: "^src/session/" },
    },
    {
      name: "transport-imports-ui",
      severity: "error",
      comment:
        "Transport imported ownerless UI. Transport exposes data and operations; UI remains a " +
        "downstream visual primitive.",
      from: { path: "^src/transport/" },
      to: { path: "^src/ui/" },
    },
    {
      name: "server-client-imported-outside-transport",
      severity: "error",
      comment:
        "Only src/transport may import @fidy/server/client. This keeps the server-owned canonical " +
        "API behind one browser transport seam and prevents alternate product clients.",
      from: { path: "^src/", pathNot: "^src/transport/" },
      to: {
        path: "^(?:@fidy/server/client|(?:\\.\\./)?(?:apps/)?server/src/client\\.ts|(?:^|.*/)node_modules/@fidy/server/src/client\\.ts)$",
      },
    },
    {
      name: "web-imports-server-internal",
      severity: "error",
      comment:
        "Web source reached a server implementation. Depend on @fidy/server/client through " +
        "transport only; server internals are not browser APIs.",
      from: { path: "^src/" },
      to: {
        path: "(^|.*/)(?:server|apps/server|node_modules/@fidy/server)/src/",
        pathNot: "(^|.*/)(?:server|apps/server|node_modules/@fidy/server)/src/client\\.ts$",
      },
    },
    {
      name: "entrypoint-is-imported",
      severity: "error",
      comment:
        "The browser entrypoint was imported. main.tsx mounts the application and is not a " +
        "module boundary for application behavior.",
      from: { path: "^src/" },
      to: { path: "^src/main\\.tsx$" },
    },
    {
      name: "cycle",
      severity: "error",
      comment:
        "The web module graph is cyclic. A cycle means the modules are one boundary that has " +
        "not admitted it and can observe an ESM export before initialization.",
      from: { path: "^src/" },
      to: { circular: true },
    },
    {
      name: "same-directory-import-is-relative",
      severity: "error",
      comment:
        "A neighbouring module was imported through the @/ alias. Same-directory imports are " +
        "relative (`./name`) so local ownership is visible.",
      from: { path: "^(src/|src/.*/)[^/]+$" },
      to: {
        path: "^$1[^/]+$",
        dependencyTypes: ["aliased-tsconfig-paths"],
      },
    },
    {
      name: "cross-directory-import-is-aliased",
      severity: "error",
      comment:
        "A cross-directory web import was written relatively. Crossings use the @/ alias so " +
        "vertical ownership is visible and ../../ counting cannot hide it.",
      from: { path: "^(src/|src/.*/)[^/]+$" },
      to: {
        path: "^src/",
        pathNot: "^$1[^/]+$",
        dependencyTypesNot: ["aliased"],
      },
    },
    {
      name: "barrel-file",
      severity: "error",
      comment:
        "A web module imported an index barrel. Import the defining module directly so feature " +
        "interfaces and ownerless UI boundaries remain explicit.",
      from: { path: "^src/" },
      to: { path: "/index\\.(ts|mts|cts|js|mjs|cjs)$", pathNot: "(^|.*/)node_modules/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.app.json" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "browser", "default", "types"],
      extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
      mainFields: ["module", "browser", "main", "types", "typings"],
    },
  },
};
