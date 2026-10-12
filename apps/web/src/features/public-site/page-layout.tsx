import type { ReactNode } from "react";
import { cn } from "@/ui/class-names";

type PublicPageLayoutProps = Readonly<{
  readonly children: ReactNode;
  readonly layout: "centered" | "document";
}>;

/** Provides page geometry owned by the public website surface. */
export const PublicPageLayout = ({
  children,
  layout,
}: PublicPageLayoutProps): React.JSX.Element => (
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
