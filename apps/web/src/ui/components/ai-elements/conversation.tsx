// Copyright 2023 Vercel, Inc. Licensed under Apache-2.0; see ./LICENSE.
// Adapted from the AI Elements conversation registry; Fidy primitives and instant scrolling.
import { Button } from "@/ui/components/button";
import { cn } from "@/ui/class-names";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ComponentProps, JSX } from "react";
import { useCallback } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";

export type ConversationProps = ComponentProps<typeof StickToBottom>;

export const Conversation = ({ className, ...props }: ConversationProps): JSX.Element => (
  <StickToBottom
    className={cn("relative flex-1 overflow-y-hidden", className)}
    initial="instant"
    resize="instant"
    role="log"
    {...props}
  />
);

export type ConversationContentProps = ComponentProps<typeof StickToBottom.Content>;

export const ConversationContent = ({
  className,
  ...props
}: ConversationContentProps): JSX.Element => (
  <StickToBottom.Content className={cn("flex flex-col gap-8 p-4", className)} {...props} />
);

export const ConversationEmptyState = (): JSX.Element => (
  <div className="flex size-full flex-col items-center justify-center gap-3 p-8 text-center">
    <h3 className="text-sm font-medium">¿En qué te ayudo?</h3>
    <p className="text-sm text-muted-foreground">Conversa con Fidy sobre tus finanzas.</p>
  </div>
);

export type ConversationScrollButtonProps = ComponentProps<typeof Button>;

export const ConversationScrollButton = ({
  className,
  ...props
}: ConversationScrollButtonProps): React.ReactNode => {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();

  const handleScrollToBottom = useCallback(() => {
    const scrolling = scrollToBottom();
    if (typeof scrolling !== "boolean") scrolling.catch(() => undefined);
  }, [scrollToBottom]);

  return (
    !isAtBottom && (
      <Button
        className={cn(
          "absolute bottom-4 left-[50%] translate-x-[-50%] rounded-full dark:bg-background dark:hover:bg-muted",
          className
        )}
        aria-label="Ir al último mensaje"
        onClick={handleScrollToBottom}
        size="icon"
        type="button"
        variant="outline"
        {...props}
      >
        <HugeiconsIcon icon={ArrowDown01Icon} size={20} aria-hidden="true" />
      </Button>
    )
  );
};
