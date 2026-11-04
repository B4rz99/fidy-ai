import { Schema } from "effect";
import { browserSessionBindingHeader } from "../../../src/shell/browser-transport/contract";
import { type DashboardDocumentReply } from "../../../src/shell/dashboard/contract";
import { resolveAuthoritativeDatabase } from "../../sqlite-store/operations";
import { trackRecoveryNative } from "../../recovery-lifecycle/runtime";
import type { DashboardDocumentEnvironment, NativeDashboardResult } from "../contract";
import { nativeReader } from "./native-reader";

const transfer = (result: NativeDashboardResult): DashboardDocumentReply => {
  if (result.bootstrap === undefined) return { kind: "refused", status: result.response.status };
  return {
    kind: "snapshot",
    status: result.response.status,
    bootstrap: result.bootstrap,
    html: result.kind === "view" ? (result.html ?? "") : "",
    headers: result.response.headers,
  };
};
const documentRequest = (request: Request, browserOrigin: string): Request => {
  const url = new URL(request.url);
  if (
    url.origin !== browserOrigin ||
    url.pathname !== "/app/dashboard" ||
    request.method !== "GET"
  ) {
    throw new Error("Document entry unavailable");
  }
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete(browserSessionBindingHeader);
  headers.set("origin", browserOrigin);
  return new Request("https://core.internal/dashboard/view", { headers });
};

/** Only the named private Worker entry calls this composition; public fetch cannot select it. */
export const documentSnapshot = ({
  request,
  environment,
}: Readonly<{
  request: Request;
  environment: DashboardDocumentEnvironment;
}>): Promise<DashboardDocumentReply> => {
  resolveAuthoritativeDatabase(environment);
  const namespace = environment.SQLITE_STORE;
  if (namespace === undefined) return Promise.resolve({ kind: "legacy" });
  const reader = nativeReader({
    store: namespace.getByName("authoritative-v1"),
    manifest: Schema.decodeUnknownSync(Schema.String)(environment.SQLITE_STORE_MANIFEST),
    epoch: Schema.decodeUnknownSync(Schema.String)(environment.SQLITE_STORE_EPOCH),
    nativeCall: (work) => trackRecoveryNative({ environment, work }),
  });
  return reader({
    request: documentRequest(request, environment.BROWSER_ORIGIN),
    mode: "document",
  }).then(transfer);
};
