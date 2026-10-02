/** Cloudflare ingress request and Worker-owned configuration for anonymous source accounting. */
export type AnonymousAdmissionRequest = Readonly<{
  request: Request;
  browserOrigin: string;
  /** Worker binding used only to derive a non-reversible admission identity, never retained. */
  admissionKey: string;
}>;
