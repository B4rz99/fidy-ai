import { preloadAgentConversation } from "@/features/agent/code";

export const preloadAgentCode = (pathname: string): Promise<void> =>
  pathname.startsWith("/app/") ||
  pathname === "/settings/account" ||
  pathname === "/settings/access"
    ? preloadAgentConversation()
    : Promise.resolve();
