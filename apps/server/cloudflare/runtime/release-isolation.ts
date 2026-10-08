import { Option } from "effect";
import { smokePath } from "./release-smoke/contract";
import { smokeProofAccepted } from "./release-smoke/operations";

type Environment = Readonly<{ mode: Option.Option<string>; proof: Option.Option<string> }>;
const unavailableStatus = 503;
const recoveryProbeAllowed = (request: Request, environment: Environment): boolean => {
  const path = new URL(request.url).pathname;
  if (path === "/health") return request.method === "GET";
  return (
    path === smokePath &&
    smokeProofAccepted({ request, secret: Option.getOrElse(environment.proof, () => "") })
  );
};

/** Both HTTP boundaries deny ordinary admission while recovery routing propagates. */
export const recoveryIsolationResponse = ({
  request,
  environment,
}: Readonly<{
  request: Request;
  environment: Environment;
}>): Option.Option<Response> => {
  const mode = Option.getOrElse(environment.mode, () => "");
  if (mode === "") return Option.none();
  if (mode === "isolated" && recoveryProbeAllowed(request, environment)) return Option.none();
  return Option.some(
    Response.json(
      { status: "unavailable" },
      {
        status: unavailableStatus,
        headers: { "cache-control": "no-store", "x-fidy-recovery-isolation": "isolated" },
      }
    )
  );
};
