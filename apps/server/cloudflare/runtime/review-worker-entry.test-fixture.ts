import type { MiniflareWorkerConfig } from "miniflare";
import { browserOrigins } from "./contract";

type WorkerManifest = NonNullable<MiniflareWorkerConfig["manifest"]>;

/** Observe the same entry points on both workerd graphs without altering their routing or body streams. */
export const withReviewWorkerTiming = (
  manifest: WorkerManifest,
  worker: "ingress" | "core"
): WorkerManifest => {
  const mainModule = "review-timing.mjs";
  const outsideBoundary =
    worker === "ingress"
      ? `request.headers.get("origin") !== ${JSON.stringify(browserOrigins.acceptance)}`
      : 'url.origin !== "https://core.internal"';
  return {
    ...manifest,
    mainModule,
    modules: {
      ...manifest.modules,
      [mainModule]: {
        type: "esm",
        contents: `
          import entry from "./${manifest.mainModule}";
          export * from "./${manifest.mainModule}";
          export default {
            ...entry,
            async fetch(request, environment, context) {
              const url = new URL(request.url);
              if (
                request.method !== "GET" ||
                ${outsideBoundary} ||
                !["/ingestion/review-workspace", "/ingestion/review-workspace/context"].includes(url.pathname)
              ) {
                return entry.fetch(request, environment, context);
              }
              const started = Date.now();
              const reply = await entry.fetch(request, environment, context);
              const finished = Date.now();
              const headers = new Headers(reply.headers);
              headers.append("server-timing", "review-${worker}-start;dur=" + started +
                ", review-${worker}-end;dur=" + finished);
              return new Response(reply.body, {
                status: reply.status,
                statusText: reply.statusText,
                headers,
              });
            },
          };
        `,
      },
    },
  };
};
