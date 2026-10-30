import { ReviewInboxSkeleton } from "./review-inbox-loading";
import type { JSX, ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { CheckmarkCircle02Icon, InformationCircleIcon } from "@hugeicons/core-free-icons";
import { Alert, AlertDescription } from "./alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./empty";
import "./review-workspace.css";

export const ReviewWorkspaceLayout = ({
  children,
}: Readonly<{ children: ReactNode }>): JSX.Element => <div data-review="workspace">{children}</div>;

export const ReviewNotice = ({
  text,
  error,
  children,
}: Readonly<{
  text: string;
  error: boolean;
  children: ReactNode;
}>): JSX.Element => (
  <div data-review="notice">
    <Alert variant={error ? "destructive" : "warning"}>
      <HugeiconsIcon icon={InformationCircleIcon} aria-hidden="true" />
      <AlertDescription>
        {text}
        {children}
      </AlertDescription>
    </Alert>
  </div>
);

export const ReviewFullState = ({
  title,
  description,
  state,
  children,
}: Readonly<{
  title: string;
  description: string;
  state: "empty" | "loading" | "error";
  children: ReactNode;
}>): JSX.Element =>
  state === "loading" ? (
    <ReviewInboxSkeleton />
  ) : (
    <div data-review="empty">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <HugeiconsIcon
              icon={
                {
                  empty: CheckmarkCircle02Icon,
                  error: InformationCircleIcon,
                }[state]
              }
              aria-hidden="true"
            />
          </EmptyMedia>
          <EmptyTitle>
            <h2>{title}</h2>
          </EmptyTitle>
          {description === "" ? null : <EmptyDescription>{description}</EmptyDescription>}
        </EmptyHeader>
        {children}
      </Empty>
    </div>
  );

export const ReviewDraftFooter = ({
  feedback,
  actions,
}: Readonly<{
  feedback: ReactNode;
  actions: ReactNode;
}>): JSX.Element => (
  <footer data-review="footer">
    <div data-review="footer-main">
      <div data-review="save-state">{feedback}</div>
      <div data-review="footer-actions">{actions}</div>
    </div>
    <p>Los datos que completes se registrarán como proporcionados por ti.</p>
  </footer>
);
