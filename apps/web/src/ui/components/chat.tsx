import { Cancel01Icon, Moon02Icon, SparklesIcon, Sun03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { JSX, ReactNode, SubmitEvent } from "react";
import { Button } from "./button";
import { useTheme } from "./theme";
import "./chat.css";
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

/** Non-modal chat; Base UI owns focus and dismissal. */
export const ChatWindow = ({ open, onOpenChange, children }: ChatWindowProps): JSX.Element => {
  const { theme, toggle } = useTheme();
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={<Button size="icon-lg" />}
        aria-label="Abrir agente Fidy"
        className="application-agent-trigger"
      >
        <HugeiconsIcon icon={SparklesIcon} size={24} strokeWidth={1.5} aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={12}
        className="signed-in-theme chat-window"
      >
        <header className="chat-header">
          <HugeiconsIcon
            className="chat-mark"
            icon={SparklesIcon}
            size={30}
            strokeWidth={1.5}
            aria-hidden="true"
          />
          <div>
            <PopoverTitle className="chat-title">Agente Fidy</PopoverTitle>
            <PopoverDescription className="sr-only">Tu asistente financiero</PopoverDescription>
          </div>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="chat-header-action"
            onClick={toggle}
            aria-label={theme === "dark" ? "Activar tema claro" : "Activar tema oscuro"}
          >
            <HugeiconsIcon
              icon={theme === "dark" ? Sun03Icon : Moon02Icon}
              size={22}
              strokeWidth={1.5}
              aria-hidden="true"
            />
          </Button>
          <Button
            className="chat-header-action"
            type="button"
            variant="outline"
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
};

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
  <form className="chat-composer" onSubmit={onSubmit}>
    <label className="sr-only" htmlFor="hosted-message">
      Mensaje
    </label>
    <textarea
      id="hosted-message"
      className="chat-input"
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
    <Button className="chat-send" disabled={disabled || text.trim().length === 0} type="submit">
      Enviar
    </Button>
    <p className="chat-privacy">No compartas contraseñas ni datos de tarjetas.</p>
  </form>
);
