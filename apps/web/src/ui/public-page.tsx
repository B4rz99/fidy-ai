import type { ReactNode } from "react";
import { cn } from "./class-names";

type PublicPageProps = Readonly<{
  readonly children: ReactNode;
  readonly layout: "centered" | "document";
}>;

/** Provides ownerless page geometry shared by public route surfaces. */
export const PublicPage = ({ children, layout }: PublicPageProps): React.JSX.Element => (
  <main
    className={cn(
      "mx-auto max-w-3xl px-6",
      layout === "centered" && "flex min-h-[70svh] items-center py-16",
      layout === "document" && "py-12"
    )}
  >
    {children}
  </main>
);
