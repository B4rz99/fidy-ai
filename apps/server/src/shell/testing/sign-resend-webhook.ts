import { Webhook } from "svix";
import { testResendWebhookSecret } from "./test-config";

/** Produces only synthetic local-test signatures; production secrets never enter the harness. */
export const signResendWebhook = (
  input: Readonly<{
    messageId: string;
    timestamp: Date;
    body: string;
  }>
): string =>
  new Webhook(testResendWebhookSecret).sign(input.messageId, input.timestamp, input.body);
