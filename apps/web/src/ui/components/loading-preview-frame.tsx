import type { JSX, ReactNode } from "react";

type Frame =
  | "transaction-rows"
  | "plain"
  | "subscription"
  | "review-inbox"
  | "review-detail"
  | "review-original"
  | "authorization"
  | "privacy"
  | "settings"
  | "settings-panel"
  | "application";
const frames: Readonly<Record<Frame, (children: ReactNode) => ReactNode>> = {
  "transaction-rows": (children): JSX.Element => (
    <div data-transaction-slot="transaction-workspace" className="!min-h-0 !p-0">
      {children}
    </div>
  ),
  plain: (children): ReactNode => children,
  subscription: (children): JSX.Element => <div className="subscription-workspace">{children}</div>,
  "review-inbox": (children): JSX.Element => <div data-review="workspace">{children}</div>,
  "review-detail": (children): JSX.Element => (
    <div data-review="workspace">
      <section data-review="detail">{children}</section>
    </div>
  ),
  "review-original": (children): JSX.Element => (
    <div data-review="workspace">
      <section data-review="detail">
        <details data-review="original" open>
          <summary>Material original</summary>
          <div data-review="original-body">{children}</div>
        </details>
      </section>
    </div>
  ),
  settings: (children): JSX.Element => (
    <div className="settings-workspace !min-h-0">
      <div className="settings-access-section p-6">{children}</div>
    </div>
  ),
  authorization: (children): JSX.Element => (
    <div className="settings-workspace oauth-workspace !min-h-0">{children}</div>
  ),
  privacy: (children): JSX.Element => (
    <div className="settings-workspace settings-privacy !min-h-0">{children}</div>
  ),
  "settings-panel": (children): JSX.Element => (
    <div className="settings-workspace !min-h-0">
      <div className="settings-panel w-96 max-w-full">{children}</div>
    </div>
  ),
  application: (children): JSX.Element => <div className="relative transform-gpu">{children}</div>,
};
export const LoadingPreviewFrame = ({
  frame,
  children,
}: Readonly<{ frame: Frame; children: ReactNode }>): JSX.Element => (
  <div className="application-shell signed-in-theme">{frames[frame](children)}</div>
);
