import { makeEmailWorker } from "./runtime";
import { cloudflareWorkerTelemetry } from "../runtime/telemetry";

export default makeEmailWorker(cloudflareWorkerTelemetry);
