import {
  Alert02Icon,
  ArrowRight01Icon,
  BarChartIcon,
  Calendar03Icon,
  InformationCircleIcon,
  SparklesIcon,
  Wallet01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { JSX, ReactNode } from "react";
import { Alert, AlertTitle } from "./alert";
import { Button } from "./button";
import { ConversationContent } from "@/ui/components/ai-elements/conversation";

export const ChatContent = ({ children }: Readonly<{ children: ReactNode }>): JSX.Element => (
  <ConversationContent className="chat-conversation-content">{children}</ConversationContent>
);

export const ChatStatus = ({
  text,
  kind,
}: Readonly<{ text: string; kind: "waiting" | "warning" | "information" }>): JSX.Element => (
  <>
    {text !== "" && (
      <output className="chat-status" data-kind={kind}>
        {kind === "waiting" && (
          <span className="chat-waiting" aria-hidden="true">
            <HugeiconsIcon className="chat-mark" icon={SparklesIcon} size={28} />
            <span className="chat-waiting-dots">•••</span>
          </span>
        )}
        {kind !== "waiting" && (
          <HugeiconsIcon
            className="chat-status-icon"
            icon={kind === "warning" ? Alert02Icon : InformationCircleIcon}
            size={28}
            aria-hidden="true"
          />
        )}
        <span>{text}</span>
      </output>
    )}
  </>
);

export const ChatRecovery = ({
  onClick,
  children,
}: Readonly<{ onClick: () => void; children: ReactNode }>): JSX.Element => (
  <Button className="chat-recovery" variant="outline" type="button" onClick={onClick}>
    {children}
  </Button>
);

export const ChatConfirmation = ({
  disabled,
  onConfirm,
}: Readonly<{ disabled: boolean; onConfirm: () => void }>): JSX.Element => (
  <>
    <Alert variant="warning" className="chat-confirmation">
      <HugeiconsIcon icon={Alert02Icon} size={24} aria-hidden="true" />
      <AlertTitle>Confirmación pendiente</AlertTitle>
    </Alert>
    <Button className="chat-confirm" type="button" disabled={disabled} onClick={onConfirm}>
      Confirmar cambio
    </Button>
  </>
);

const suggestions = [
  { text: "Revisar mis gastos", icon: BarChartIcon },
  { text: "Ver mis presupuestos", icon: Wallet01Icon },
  { text: "Consultar recurrentes", icon: Calendar03Icon },
] as const;

export const ChatStart = ({
  onSelect,
}: Readonly<{ onSelect: (text: string) => void }>): JSX.Element => (
  <div className="chat-start">
    <h3>¿En qué te ayudo?</h3>
    <div className="chat-suggestions">
      {suggestions.map(({ text, icon }) => (
        <Button
          className="chat-suggestion"
          variant="outline"
          type="button"
          key={text}
          onClick={() => onSelect(text)}
        >
          <HugeiconsIcon icon={icon} size={24} strokeWidth={1.5} aria-hidden="true" />
          {text}
          <HugeiconsIcon icon={ArrowRight01Icon} size={20} aria-hidden="true" />
        </Button>
      ))}
    </div>
  </div>
);
