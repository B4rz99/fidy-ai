import { type JSX, useState } from "react";
import { Message, MessageContent } from "@/ui/components/ai-elements/message";
import { ChatComposer } from "@/ui/components/chat";
import { ChatConfirmation, ChatStart, ChatStatus } from "@/ui/components/chat-content";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/components/card";

const DraftExample = (): JSX.Element => {
  const [text, setText] = useState("");
  const [sent, setSent] = useState("");
  return (
    <Card>
      <CardHeader>
        <CardTitle>Inicio y borrador</CardTitle>
      </CardHeader>
      <CardContent>
        <ChatStart onSelect={setText} />
        {sent !== "" && (
          <Message from="user">
            <MessageContent>{sent}</MessageContent>
          </Message>
        )}
      </CardContent>
      <ChatComposer
        text={text}
        disabled={false}
        onTextChange={setText}
        onSubmit={(event) => {
          event.preventDefault();
          setSent(text);
          setText("");
        }}
      />
    </Card>
  );
};

export const ChatReference = (): JSX.Element => (
  <section id="chat" aria-labelledby="chat-reference-heading" className="flex flex-col gap-4">
    <h2 id="chat-reference-heading" className="text-2xl font-semibold">
      Chat de Fidy
    </h2>
    <p className="text-muted-foreground">
      Ejemplo local sin conexión al agente. Las sugerencias solo rellenan el borrador; Enviar
      muestra el texto aquí, sin enviarlo ni cambiar datos. Prueba Tab, Enter y Shift+Enter.
    </p>
    <div className="grid gap-6 lg:grid-cols-2">
      <DraftExample />
      <Card>
        <CardHeader>
          <CardTitle>Respuesta y estados</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Message from="assistant">
            <MessageContent>
              Las respuestas del agente se presentan como texto, sin una burbuja.
            </MessageContent>
          </Message>
          <ChatStatus kind="waiting" text="Esperando respuesta…" />
          <ChatStatus
            kind="warning"
            text="No se pudo recuperar el turno. Una operación podría haberse ejecutado: consulta tus datos antes de reintentar."
          />
          <ChatStatus
            kind="information"
            text="No pudimos guardar la respuesta. Reintenta la conexión para continuar."
          />
          <p className="text-sm text-muted-foreground">
            Muestra de confirmación deshabilitada. No representa una operación pendiente.
          </p>
          <ChatConfirmation disabled onConfirm={() => undefined} />
        </CardContent>
      </Card>
    </div>
  </section>
);
