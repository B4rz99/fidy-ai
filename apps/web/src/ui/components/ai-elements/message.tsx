// Copyright 2023 Vercel, Inc. Licensed under Apache-2.0; see ./LICENSE.
// Adapted from the AI Elements message registry. Text stays escaped by React.
import type { HTMLAttributes, JSX } from "react";
import { cn } from "@/ui/class-names";

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: "user" | "assistant";
};

export const Message = ({ className, from, ...props }: MessageProps): JSX.Element => (
  <div
    className={cn(
      "group chat-message flex w-full flex-col gap-4",
      from === "user" ? "is-user ml-auto justify-end" : "is-assistant",
      className
    )}
    {...props}
  />
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({
  children,
  className,
  ...props
}: MessageContentProps): JSX.Element => (
  <div
    className={cn(
      "chat-message-content flex w-fit min-w-0 max-w-full flex-col gap-2 whitespace-pre-wrap break-words",
      "group-[.is-user]:ml-auto",
      "group-[.is-assistant]:text-foreground",
      className
    )}
    {...props}
  >
    {children}
  </div>
);
