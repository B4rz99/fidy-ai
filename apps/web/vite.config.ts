import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { serverClientBoundary } from "./server-client-boundary.ts";
import { entryPreload } from "./entry-preload.ts";

const publicDirectory = (mode: string): string | false => {
  if (mode === "production") return "cloudflare/production";
  return false;
};

const bootstrapModules = [
  "/apps/server/src/browser-transport.ts",
  "/apps/server/src/shell/browser-transport/contract.ts",
  "/apps/server/src/shell/browser-transport/operations.ts",
  "/apps/web/src/transport/origin.ts",
  "/apps/web/src/transport/initial-request.ts",
  "/apps/web/src/session/initial-request.ts",
  "/apps/web/src/session/authentication-channel.ts",
];
const bootstrapCodeModule = (id: string): boolean => {
  const path = id.replaceAll("\\", "/").replace(/\?.*$/u, "");
  return (
    bootstrapModules.some((suffix) => path.endsWith(suffix)) ||
    /\/apps\/web\/src\/(?:main\.tsx|app\/(?:mount|entry-code|agent-code|provider-return)\.tsx?|features\/[^/]+\/code\.ts)$/u.test(
      path
    )
  );
};
const sharedRuntimeModule = (id: string): boolean => {
  const path = id.replaceAll("\\", "/").replace(/\?.*$/u, "");
  if (bootstrapModules.some((suffix) => path.endsWith(suffix))) return false;
  return /\/apps\/server\/src\/|node_modules\/(?:effect|@effect|react|react-dom|scheduler|use-sync-external-store|@tanstack\/(?:react-router|router-core|history|react-store|store))\//u.test(
    path
  );
};

const sharedPresentationModule = (id: string): boolean => {
  const path = id.replaceAll("\\", "/").replace(/\?.*$/u, "");
  if (
    bootstrapModules.some((suffix) => path.endsWith(suffix)) ||
    /node_modules\/@base-ui\/react\/combobox\//u.test(path) ||
    /\/apps\/web\/src\/transport\/wompi-/u.test(path) ||
    /\/apps\/web\/src\/ui\/components\/(?:calendar|chart|dashboard-chart|ai-elements|chat-content|subscription-|searchable-choice-dropdown|amount-input)/u.test(
      path
    )
  ) {
    return false;
  }
  return (
    /node_modules\/(?:@base-ui|@floating-ui|@hugeicons|clsx|class-variance-authority|tailwind-merge)\//u.test(
      path
    ) ||
    path.endsWith("/apps/web/src/ui/class-names.ts") ||
    /\/apps\/web\/src\/(?:ui\/components|transport|session|browser)\//u.test(path)
  );
};

export default defineConfig(({ mode }) => ({
  plugins: [serverClientBoundary(), react(), tailwindcss(), entryPreload()],
  publicDir: publicDirectory(mode),
  build: {
    rolldownOptions: {
      preserveEntrySignatures: false,
      output: {
        codeSplitting: {
          groups: [
            {
              // Code-only helpers must not add prerequisite downloads before session binding.
              name: "bootstrap-code",
              minShareCount: 1,
              includeDependenciesRecursively: false,
              test: bootstrapCodeModule,
            },
            {
              // Prepare a screen's closed panels together without making them read dependencies.
              name: (id): string =>
                `${/\/features\/([^/]+)\//u.exec(id)?.[1] ?? "screen"}-interactions`,
              minShareCount: 1,
              includeDependenciesRecursively: false,
              test: /\/features\/(?:transactions\/(?:capture|detail|bulk-correction)|budgets\/editor|recurring\/(?:details|lifecycle|transaction-link|create-plan|creation-result|plan-form)|subscription\/(?:payment-details|daviplata-form|enrollment-controls|enrollment-decisions))\.tsx?$/u,
            },
            {
              name: "shared-presentation",
              minShareCount: 2,
              includeDependenciesRecursively: false,
              test: sharedPresentationModule,
            },
            {
              name: "shared-runtime",
              // Keep library initialization together, including React compiler dependencies.
              minShareCount: 1,
              // Recursive capture would pull the dependency-free bootstrap into this chunk.
              includeDependenciesRecursively: false,
              test: sharedRuntimeModule,
            },
          ],
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": Bun.fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
}));
