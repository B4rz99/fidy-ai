import { verifyHostedInferenceConformanceChecks } from "@fidy/server/hosted-inference";
import { Cause, Effect, Exit, Option } from "effect";
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
      Effect.mapError(() => ({
        check: "configuration" as const,
        category: "ProviderUnavailable" as const,
      })),
      Effect.flatMap(verifyHostedInferenceConformanceChecks),
      Effect.exit,
      Effect.map((exit) => {
        if (Exit.isSuccess(exit)) {
          return Response.json(
            { modelApprovalRevision: "workers-ai-gemma-4-2026-09-22", outcome: "conforming" },
            { headers: jsonHeaders, status: 200 }
          );
        }
        const failure =
          Cause.hasDies(exit.cause) || Cause.hasInterrupts(exit.cause)
            ? { check: "internal", category: "UnexpectedFailure" }
            : Option.getOrElse(Cause.findErrorOption(exit.cause), () => ({
                check: "internal" as const,
                category: "UnexpectedFailure" as const,
              }));
        return Response.json(
          {
            modelApprovalRevision: "workers-ai-gemma-4-2026-09-22",
            outcome: "non_conforming",
            ...failure,
          },
          { headers: jsonHeaders, status: 503 }
        );
      }),
      Effect.runPromise
    );
  },
} satisfies ExportedHandler<WorkersAiEnvironment>;

export default handler;
