import type { WebSessionAuthority } from "@fidy/server/web-session";
import type { PATAuthority } from "@fidy/server/tokens-runtime";

/** Live caller authority re-evaluated beside a User-scoped Memory read. */
export type MemoryAuthority =
  | PATAuthority
  | WebSessionAuthority
  | Readonly<{
      table: "whatsapp_identities";
      predicate: string;
      bindings: ReadonlyArray<string>;
    }>;
