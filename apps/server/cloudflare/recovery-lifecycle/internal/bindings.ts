import type { RecoveryDispatchEnvironment } from "../contract";
import { queue, workflow } from "./dispatch";

const publicationQueues = <Environment extends RecoveryDispatchEnvironment>(
  environment: Environment
): Environment => ({
  ...environment,
  ...(environment.BROWSER_PAIRING_EMAIL_QUEUE === undefined
    ? {}
    : {
        BROWSER_PAIRING_EMAIL_QUEUE: queue({
          binding: environment.BROWSER_PAIRING_EMAIL_QUEUE,
          environment,
        }),
      }),
  ...(environment.EMAIL_REPLACEMENT_QUEUE === undefined
    ? {}
    : {
        EMAIL_REPLACEMENT_QUEUE: queue({
          binding: environment.EMAIL_REPLACEMENT_QUEUE,
          environment,
        }),
      }),
  ...(environment.BILLING_COLLECTION_QUEUE === undefined
    ? {}
    : {
        BILLING_COLLECTION_QUEUE: queue({
          binding: environment.BILLING_COLLECTION_QUEUE,
          environment,
        }),
      }),
  ...(environment.HOSTED_WHATSAPP_QUEUE === undefined
    ? {}
    : {
        HOSTED_WHATSAPP_QUEUE: queue({ binding: environment.HOSTED_WHATSAPP_QUEUE, environment }),
      }),
});

const executionQueues = <Environment extends RecoveryDispatchEnvironment>(
  environment: Environment
): Environment => ({
  ...environment,
  ...(environment.STATEMENT_EXTRACTION_QUEUE === undefined
    ? {}
    : {
        STATEMENT_EXTRACTION_QUEUE: queue({
          binding: environment.STATEMENT_EXTRACTION_QUEUE,
          environment,
        }),
      }),
  ...(environment.WEEKLY_DELIVERY_QUEUE === undefined
    ? {}
    : {
        WEEKLY_DELIVERY_QUEUE: queue({ binding: environment.WEEKLY_DELIVERY_QUEUE, environment }),
      }),
  ...(environment.OPERATIONAL_CANARY_QUEUE === undefined
    ? {}
    : {
        OPERATIONAL_CANARY_QUEUE: queue({
          binding: environment.OPERATIONAL_CANARY_QUEUE,
          environment,
        }),
      }),
  ...(environment.SMOKE_QUEUE === undefined
    ? {}
    : { SMOKE_QUEUE: queue({ binding: environment.SMOKE_QUEUE, environment }) }),
});

const identityWorkflows = <Environment extends RecoveryDispatchEnvironment>(
  environment: Environment
): Environment => ({
  ...environment,
  ...(environment.BROWSER_PAIRING_EMAIL_WORKFLOW === undefined
    ? {}
    : {
        BROWSER_PAIRING_EMAIL_WORKFLOW: workflow({
          binding: environment.BROWSER_PAIRING_EMAIL_WORKFLOW,
          environment,
        }),
      }),
  ...(environment.EMAIL_REPLACEMENT_WORKFLOW === undefined
    ? {}
    : {
        EMAIL_REPLACEMENT_WORKFLOW: workflow({
          binding: environment.EMAIL_REPLACEMENT_WORKFLOW,
          environment,
        }),
      }),
  ...(environment.BILLING_COLLECTION_WORKFLOW === undefined
    ? {}
    : {
        BILLING_COLLECTION_WORKFLOW: workflow({
          binding: environment.BILLING_COLLECTION_WORKFLOW,
          environment,
        }),
      }),
  ...(environment.BILLING_REFUND_WORKFLOW === undefined
    ? {}
    : {
        BILLING_REFUND_WORKFLOW: workflow({
          binding: environment.BILLING_REFUND_WORKFLOW,
          environment,
        }),
      }),
});

const backgroundWorkflows = <Environment extends RecoveryDispatchEnvironment>(
  environment: Environment
): Environment => ({
  ...environment,
  ...(environment.STATEMENT_EXTRACTION_WORKFLOW === undefined
    ? {}
    : {
        STATEMENT_EXTRACTION_WORKFLOW: workflow({
          binding: environment.STATEMENT_EXTRACTION_WORKFLOW,
          environment,
        }),
      }),
  ...(environment.WEEKLY_DELIVERY_WORKFLOW === undefined
    ? {}
    : {
        WEEKLY_DELIVERY_WORKFLOW: workflow({
          binding: environment.WEEKLY_DELIVERY_WORKFLOW,
          environment,
        }),
      }),
  ...(environment.OPERATIONAL_CANARY_WORKFLOW === undefined
    ? {}
    : {
        OPERATIONAL_CANARY_WORKFLOW: workflow({
          binding: environment.OPERATIONAL_CANARY_WORKFLOW,
          environment,
        }),
      }),
  ...(environment.SMOKE_WORKFLOW === undefined
    ? {}
    : { SMOKE_WORKFLOW: workflow({ binding: environment.SMOKE_WORKFLOW, environment }) }),
});

export const bindings = <Environment extends RecoveryDispatchEnvironment>(
  environment: Environment
): Environment =>
  backgroundWorkflows(identityWorkflows(executionQueues(publicationQueues(environment))));
