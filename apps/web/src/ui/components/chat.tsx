import { Cancel01Icon, SparklesIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { JSX, ReactNode, SubmitEvent } from "react";
import { Button } from "./button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "./popover";

type ChatWindowProps = Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}>;

/** Non-modal chat anchored to a persistent launcher; focus and dismissal belong to Base UI. */
export const ChatWindow = ({ open, onOpenChange, children }: ChatWindowProps): JSX.Element => (
  <Popover open={open} onOpenChange={onOpenChange}>
    <PopoverTrigger
      render={<Button size="icon-lg" />}
      aria-label="Abrir agente Fidy"
      className="fixed right-5 bottom-[max(1.25rem,env(safe-area-inset-bottom))] z-40 shadow-md"
    >
      <HugeiconsIcon icon={SparklesIcon} size={24} strokeWidth={1.5} aria-hidden="true" />
    </PopoverTrigger>
    <PopoverContent
      side="top"
      align="end"
      sideOffset={12}
      className="signed-in-theme flex h-[min(36rem,calc(100svh-6rem))] w-[min(25rem,calc(100vw-2.5rem))] flex-col gap-0 overflow-hidden rounded-xl border border-border bg-background p-0 motion-reduce:animate-none"
    >
      <header className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <PopoverTitle className="font-heading text-lg font-semibold">Agente Fidy</PopoverTitle>
          <PopoverDescription className="text-xs">Tu asistente financiero</PopoverDescription>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Cerrar chat"
          onClick={() => onOpenChange(false)}
        >
          <HugeiconsIcon icon={Cancel01Icon} size={20} aria-hidden="true" />
        </Button>
      </header>
      {children}
    </PopoverContent>
  </Popover>
);

type ChatComposerProps = Readonly<{
  text: string;
  disabled: boolean;
  onTextChange: (text: string) => void;
  onSubmit: (event: SubmitEvent<HTMLFormElement>) => void;
}>;

/** Text-only composer: Enter sends, Shift+Enter inserts a line, IME composition remains intact. */
export const ChatComposer = ({
  text,
  disabled,
  onTextChange,
  onSubmit,
}: ChatComposerProps): JSX.Element => (
  <form className="flex shrink-0 flex-col gap-2 border-t p-4" onSubmit={onSubmit}>
    <label className="sr-only" htmlFor="hosted-message">
      Mensaje
    </label>
    <textarea
      id="hosted-message"
      className="max-h-32 min-h-20 w-full resize-none rounded-lg border border-border bg-background p-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring"
      disabled={disabled}
      onChange={(event) => onTextChange(event.target.value)}
      required
      value={text}
      placeholder="Escribe tu mensaje…"
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }
      }}
    />
    <div className="flex items-center justify-between gap-3">
      <p className="text-xs text-muted-foreground">
        No compartas contraseñas ni datos de tarjetas.
      </p>
      <Button disabled={disabled || text.trim().length === 0} type="submit">
        Enviar
      </Button>
    </div>
  </form>
);
