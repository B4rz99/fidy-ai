import { Array as EffectArray, Option } from "effect";
import type { RecoveryLifecycleEnvironment } from "../contract";
import { native } from "./context";
import { epoch as recoveryWorkEpoch } from "./epoch";

const stamp = <Work>(environment: RecoveryLifecycleEnvironment, work: Work): Work =>
  Option.match(recoveryWorkEpoch(environment), {
    onNone: () => work,
    onSome: (recoveryEpoch) => ({ ...work, recoveryEpoch }),
  });

export const publisher = <Work, Result>({
  binding,
  environment,
}: Readonly<{
  binding: Readonly<{ send: (work: Work) => Promise<Result> }>;
  environment: RecoveryLifecycleEnvironment;
}>): Readonly<{ send: (work: Work) => Promise<Result> }> => ({
  send: (work) => native({ environment, work: () => binding.send(stamp(environment, work)) }),
});

export const queue = <Work>({
  binding,
  environment,
}: Readonly<{ binding: Queue<Work>; environment: RecoveryLifecycleEnvironment }>): Queue<Work> =>
  Option.isNone(recoveryWorkEpoch(environment))
    ? binding
    : {
        metrics: () => binding.metrics(),
        send: (work, options) =>
          native({
            environment,
            work: () => binding.send(stamp(environment, work), options),
          }),
        sendBatch: (messages, options) =>
          native({
            environment,
            work: () =>
              binding.sendBatch(
                Array.from(messages, (message) => ({
                  ...message,
                  body: stamp(environment, message.body),
                })),
                options
              ),
          }),
      };

export const workflow = <Work>({
  binding,
  environment,
}: Readonly<{
  binding: Workflow<Work>;
  environment: RecoveryLifecycleEnvironment;
}>): Workflow<Work> => {
  if (Option.isNone(recoveryWorkEpoch(environment))) return binding;
  const optionsFor = (
    options: WorkflowInstanceCreateOptions<Work>
  ): WorkflowInstanceCreateOptions<Work> => ({
    ...options,
    params: stamp(environment, options.params),
  });
  function createBatch(
    options: WorkflowBatchCreateOptions<Work>
  ): Promise<WorkflowBatchCreateResult>;
  function createBatch(
    options: Array<WorkflowInstanceCreateOptions<Work>>
  ): Promise<Array<WorkflowInstance>>;
  function createBatch(
    options: WorkflowBatchCreateOptions<Work> | Array<WorkflowInstanceCreateOptions<Work>>
  ): Promise<WorkflowBatchCreateResult | Array<WorkflowInstance>> {
    if (EffectArray.isArray(options)) {
      return native({
        environment,
        work: () => binding.createBatch(options.map(optionsFor)),
      });
    }
    if (options.instances !== undefined) {
      const instances = options.instances.map(optionsFor);
      return native({ environment, work: () => binding.createBatch({ instances }) });
    }
    const input = { ...options, params: stamp(environment, options.params) };
    return native({ environment, work: () => binding.createBatch(input) });
  }
  return {
    get: (id) => binding.get(id),
    create: (options) =>
      native({ environment, work: () => binding.create(optionsFor(options ?? {})) }),
    createBatch,
    deleteBatch: (ids) => binding.deleteBatch(ids),
  };
};
