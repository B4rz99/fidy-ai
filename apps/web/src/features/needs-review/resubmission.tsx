import type { JSX } from "react";
import { fidyWhatsAppUrl } from "@/transport/client";
import { Button } from "@/ui/components/button";
import type { Item } from "./model";

const instructions = {
  statement: "Vuelve a enviar el extracto al chat de Fidy desde el WhatsApp que tienes vinculado.",
  media: "Vuelve a enviar la imagen al chat de Fidy desde el WhatsApp que tienes vinculado.",
  email:
    "Vuelve a reenviar el correo original a tu dirección de reenvío de Fidy. Si no la recuerdas, consúltala en tu chat de Fidy.",
};

export const ReviewResubmission = ({
  source,
}: Readonly<{ source: Item["source"] }>): JSX.Element => (
  <div data-review="resubmission">
    <p>El original ya no está disponible. {instructions[source]}</p>
    <p className="mt-3">
      Al reenviarlo, inicias una nueva revisión. Este elemento seguirá vencido.
    </p>
    {source === "email" ? null : (
      <>
        <div>
          <Button
            nativeButton={false}
            contentLayout="wrap"
            render={
              <a
                aria-label="Abrir WhatsApp"
                href={fidyWhatsAppUrl}
                target="_blank"
                rel="noopener noreferrer"
              />
            }
          >
            Abrir WhatsApp
          </Button>
        </div>
        <p className="mt-3">
          Abre el chat; tú adjuntas y envías {source === "statement" ? "el extracto" : "la imagen"}.
        </p>
      </>
    )}
  </div>
);
