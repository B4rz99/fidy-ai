import nativeCore, { UserStore as NativeUser } from "../core-worker";

export * from "../core-worker";

type Core = Parameters<typeof nativeCore.scheduled>[1] &
  Partial<{ WEEKLY_DELIVERY_QUEUE: Queue }> & { MONITOR_FIXTURE: string };

type Owner = ConstructorParameters<typeof NativeUser>[1] & { MONITOR_FIXTURE: string };

const count = { metrics: 0, canary: 0 };

const metrics = (): Promise<QueueMetrics> => {
  count.metrics++;

  return Promise.resolve({ backlogCount: 3, backlogBytes: 60 });
};

const stalled = Promise.withResolvers<QueueSendResponse>();

const counters = "https://fixture.invalid/monitoring-counters";

export default {
  ...nativeCore,
  fetch(request: Request, env: Core): Promise<Response> {
    if (request.url === counters) return Promise.resolve(Response.json(count));

    return nativeCore.fetch(request, env);
  },
  scheduled(controller: ScheduledController, env: Core): Promise<void> {
    const configured = { ...env };

    if (env.MONITOR_FIXTURE === "queue" || env.MONITOR_FIXTURE === "both") {
      delete configured.WEEKLY_DELIVERY_QUEUE;
    } else if (env.WEEKLY_DELIVERY_QUEUE !== undefined) {
      const queue = env.WEEKLY_DELIVERY_QUEUE;

      configured.WEEKLY_DELIVERY_QUEUE = {
        send: queue.send.bind(queue),
        sendBatch: queue.sendBatch.bind(queue),
        metrics,
      };
    }

    if (env.MONITOR_FIXTURE === "workflow" || env.MONITOR_FIXTURE === "both") {
      delete configured.WEEKLY_DELIVERY_WORKFLOW;
    }

    configured.OPERATIONAL_CANARY_QUEUE = {
      send: (): Promise<QueueSendResponse> => {
        count.canary++;

        return env.MONITOR_FIXTURE === "stall"
          ? stalled.promise
          : Promise.resolve({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } });
      },
      sendBatch: (): Promise<never> => Promise.reject(new Error("unexpected batch")),
      metrics,
    };

    return nativeCore.scheduled(controller, configured);
  },
};

export class UserStore extends NativeUser {
  private readonly inspections: string[];
  constructor(state: DurableObjectState, env: Owner) {
    const inspections: string[] = [];
    const config = { ...env };

    if (env.MONITOR_FIXTURE === "workflow" || env.MONITOR_FIXTURE === "both") {
      Reflect.deleteProperty(config, "WEEKLY_DELIVERY_WORKFLOW");
    } else {
      const workflow = env.WEEKLY_DELIVERY_WORKFLOW;

      config.WEEKLY_DELIVERY_WORKFLOW = {
        get: (id: string): Promise<WorkflowInstance> => {
          inspections.push(id);

          return workflow.get(id);
        },
        create: workflow.create.bind(workflow),
        createBatch: workflow.createBatch.bind(workflow),
        deleteBatch: workflow.deleteBatch.bind(workflow),
      };
    }

    super(state, config);
    this.inspections = inspections;
  }
  override fetch(request: Request): Promise<Response> {
    return request.url === counters
      ? Promise.resolve(Response.json(this.inspections))
      : super.fetch(request);
  }
}
