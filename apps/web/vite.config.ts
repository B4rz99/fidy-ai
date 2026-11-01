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
const sharedRuntimeModule = (id: string): boolean => {
  const path = id.replaceAll("\\", "/").replace(/\?.*$/u, "");
  if (bootstrapModules.some((suffix) => path.endsWith(suffix))) return false;
  return (
    /\/apps\/server\/src\/|node_modules\/(?:effect|@effect|react|react-dom|scheduler|@tanstack|@base-ui|@hugeicons|@floating-ui|sonner|clsx|class-variance-authority|tailwind-merge|use-sync-external-store|use-stick-to-bottom)\//u.test(
      path
    ) ||
    path.endsWith("/apps/web/src/ui/class-names.ts") ||
    (/\/apps\/web\/src\/(?:ui\/components|transport|session|browser)\//u.test(path) &&
      !path.includes("/calendar"))
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
              name: "shared-runtime",
              minShareCount: 2,
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
