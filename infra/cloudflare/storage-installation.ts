import * as Cloudflare from "alchemy/Cloudflare";
import { Effect } from "effect";

export const nativeStack = "FidyNativeStorage";

export const installationNames = {
  Core: "fidy-native-storage-core",
  Ingress: "fidy-native-storage-ingress",
  ForwardedEmail: "fidy-native-email",
  Web: "fidy-native-web",
} as const;

export const storageNamespaces = Effect.sync(() => ({
  USER_STORE: Cloudflare.DurableObject("UserStore", { className: "UserStore" }),
  DIRECTORY: Cloudflare.DurableObject("Directory", { className: "Directory" }),
  PRICING: Cloudflare.DurableObject("Pricing", { className: "Pricing" }),
  MAINTENANCE: Cloudflare.DurableObject("Maintenance", { className: "Maintenance" }),
  ERASURE: Cloudflare.DurableObject("Erasure", { className: "Erasure" }),
}));
