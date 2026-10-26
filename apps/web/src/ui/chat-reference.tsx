import { type JSX, useState } from "react";
import { Message, MessageContent } from "@/ui/components/ai-elements/message";
import { Conversation } from "@/ui/components/ai-elements/conversation";
import { ChatComposer, ChatWindow } from "@/ui/components/chat";
import { useTheme } from "@/ui/components/theme";
import { ChatConfirmation, ChatContent, ChatStart, ChatStatus } from "@/ui/components/chat-content";
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

const FloatingExample = (): JSX.Element => {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const { mounted } = useTheme();
  return (
    <ChatWindow open={open} onOpenChange={setOpen}>
      <div ref={mounted} className="contents">
        <Conversation className="min-h-0" aria-label="Ejemplo local de conversación">
          <ChatContent>
            <Message from="assistant">
              <MessageContent>
                Esta ventana es una demostración local. La confirmación no representa una operación
                pendiente y no puede ejecutarse.
              </MessageContent>
              <ChatConfirmation disabled onConfirm={() => undefined} />
            </Message>
          </ChatContent>
        </Conversation>
        <ChatComposer
          text={text}
          disabled={false}
          onTextChange={setText}
          onSubmit={(event) => {
            event.preventDefault();
            setText("");
          }}
        />
      </div>
    </ChatWindow>
  );
};

export const ChatReference = (): JSX.Element => (
  <section id="chat" aria-labelledby="chat-reference-heading" className="flex flex-col gap-4">
    <h2 id="chat-reference-heading" className="text-2xl font-semibold">
      Chat de Fidy
    </h2>
    <p className="text-muted-foreground">
      Ejemplo local sin conexión al agente. Las sugerencias solo rellenan el borrador; Enviar
      muestra el texto aquí, sin enviarlo ni cambiar datos. Prueba Tab, Enter y Shift+Enter. En la
      aplicación, la ventana flotante conserva 8px de margen en pantallas de hasta 500px de alto; la
      explicación, la confirmación y el compositor permanecen accesibles sin reducir la tipografía.
    </p>
    <p className="text-sm text-muted-foreground">
      Abre el botón flotante del agente para probar la ventana real. Reduce la altura, navega con
      Tab y cierra con Escape; el texto del ejemplo no se envía a ningún servicio.
    </p>
    <FloatingExample />
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
