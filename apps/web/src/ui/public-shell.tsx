import type { ReactNode } from "react";

type PublicShellProps = Readonly<{
  readonly ariaLabel: string;
  readonly brand: ReactNode;
  readonly children: ReactNode;
  readonly navigation: ReactNode;
}>;

/** Renders an ownerless public shell around route content and supplied navigation. */
export const PublicShell = ({
  ariaLabel,
  brand,
  children,
  navigation,
}: PublicShellProps): React.JSX.Element => (
  <div className="min-h-svh bg-background text-foreground">
    <header className="border-b">
      <nav
        className="mx-auto flex max-w-3xl items-center justify-between px-6 py-5"
        aria-label={ariaLabel}
      >
        {brand}
        {navigation}
      </nav>
    </header>
    {children}
  </div>
);
