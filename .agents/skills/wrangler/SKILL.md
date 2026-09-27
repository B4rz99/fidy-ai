---
name: wrangler
description: "Run Wrangler commands or edit Wrangler configuration for Cloudflare Workers and associated resources."
---

# Wrangler CLI

Use the project’s installed Wrangler version and package runner. Check the relevant subcommand’s `--help`, the installed `wrangler/config-schema.json`, and [official documentation](https://developers.cloudflare.com/workers/wrangler/) for flags and configuration fields. Install Wrangler only when the requested workflow needs it and the project has no suitable installation.

Preserve the project’s configuration format, environments, and compatibility date unless the task calls for changing them. Regenerate binding types after binding changes. Local development can reach live resources through remote bindings; Workers AI runs remotely even during local development. Keep secrets out of command arguments and logs; use interactive input, protected files, or the existing CI secret mechanism.

## Read for the operation

| Task                                                    | Reference                                                           |
| ------------------------------------------------------- | ------------------------------------------------------------------- |
| Initialize a Worker, edit configuration, generate types | [Configuration](references/configuration.md)                        |
| Run locally or test scheduled events                    | [Local development](references/local-development.md)                |
| Deploy, manage versions, roll back, or use Pages        | [Deployment](references/deployment.md)                              |
| Work with KV, R2, or D1 and migrations                  | [Storage](references/storage.md)                                    |
| Use Vectorize, Hyperdrive, or Workers AI                | [AI and databases](references/ai-and-databases.md)                  |
| Manage Queues, Containers, Workflows, or Pipelines      | [Async services and containers](references/async-and-containers.md) |
| Manage account Secrets Store resources                  | [Secrets Store](references/secrets-store.md)                        |
| Inspect logs, startup performance, or failures          | [Diagnostics](references/diagnostics.md)                            |

Read only the reference relevant to the operation. A command example describes syntax; the user’s request determines which resources and environments to change. Verify the resulting local artifact or remote state before reporting completion.
