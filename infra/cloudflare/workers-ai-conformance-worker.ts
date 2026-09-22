import { verifyHostedInferenceConformance } from "@fidy/server/hosted-inference";
import { Effect, Exit } from "effect";
import { type WorkersAiEnvironment, makeCloudflareHostedInference } from "./workers-ai";

const jsonHeaders = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
} as const;

const handler = {
  fetch: (request: Request, environment: WorkersAiEnvironment): Promise<Response> => {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/conformance") {
      return Promise.resolve(
        Response.json({ outcome: "not_found" }, { headers: jsonHeaders, status: 404 })
      );
    }
    return makeCloudflareHostedInference(environment).pipe(
      Effect.flatMap(verifyHostedInferenceConformance),
      Effect.exit,
      Effect.map((exit) =>
        Exit.isSuccess(exit)
          ? Response.json(
              { modelApprovalRevision: "workers-ai-2026-09-22", outcome: "conforming" },
              { headers: jsonHeaders, status: 200 }
            )
          : Response.json(
              { modelApprovalRevision: "workers-ai-2026-09-22", outcome: "non_conforming" },
              { headers: jsonHeaders, status: 503 }
            )
      ),
      Effect.runPromise
    );
  },
} satisfies ExportedHandler<WorkersAiEnvironment>;

export default handler;
