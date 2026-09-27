# Async And Containers

Examples are starting points. Verify flags against the installed Wrangler version and current official documentation.

## Queues

### Manage Queues

```bash
# Create queue
wrangler queues create my-queue

# List queues
wrangler queues list

# Delete queue
wrangler queues delete my-queue

# Add consumer to queue
wrangler queues consumer add my-queue my-worker

# Remove consumer
wrangler queues consumer remove my-queue my-worker
```

### Config Binding

```jsonc
{
  "queues": {
    "producers": [{ "binding": "MY_QUEUE", "queue": "my-queue" }],
    "consumers": [
      {
        "queue": "my-queue",
        "max_batch_size": 10,
        "max_batch_timeout": 30,
      },
    ],
  },
}
```

---

## Containers

### Build and Push Images

```bash
# Build container image
wrangler containers build -t my-app:latest .

# Build and push in one command
wrangler containers build -t my-app:latest . --push

# Push existing image to Cloudflare registry
wrangler containers push my-app:latest
```

### Manage Containers

```bash
# List containers
wrangler containers list

# Get container info
wrangler containers info <CONTAINER_ID>

# Delete container
wrangler containers delete <CONTAINER_ID>
```

### Manage Images

```bash
# List images in registry
wrangler containers images list

# Delete image
wrangler containers images delete my-app:latest
```

### Manage External Registries

> **Security**: Never hardcode registry credentials in commands. Use environment variables.

```bash
# List configured registries
wrangler containers registries list

# Configure external registry (e.g., ECR)
wrangler containers registries configure <DOMAIN> \
  --aws-access-key-id "$AWS_ACCESS_KEY_ID"

# Configure DockerHub
wrangler containers registries configure <DOMAIN> \
  --dockerhub-username "$DOCKERHUB_USERNAME"

# Delete registry configuration
wrangler containers registries delete <DOMAIN>
```

---

## Workflows

### Manage Workflows

```bash
# List workflows
wrangler workflows list

# Describe workflow
wrangler workflows describe my-workflow

# Trigger workflow instance
wrangler workflows trigger my-workflow

# Trigger with parameters
wrangler workflows trigger my-workflow --params '{"key": "value"}'

# Delete workflow
wrangler workflows delete my-workflow
```

### Manage Workflow Instances

```bash
# List instances
wrangler workflows instances list my-workflow

# Describe instance
wrangler workflows instances describe my-workflow <INSTANCE_ID>

# Terminate instance
wrangler workflows instances terminate my-workflow <INSTANCE_ID>
```

### Config Binding

```jsonc
{
  "workflows": [
    {
      "binding": "MY_WORKFLOW",
      "name": "my-workflow",
      "class_name": "MyWorkflow",
    },
  ],
}
```

---

## Pipelines

### Manage Pipelines

```bash
# Create pipeline
wrangler pipelines create my-pipeline --r2 my-bucket

# List pipelines
wrangler pipelines list

# Show pipeline details
wrangler pipelines show my-pipeline

# Update pipeline
wrangler pipelines update my-pipeline --batch-max-mb 100

# Delete pipeline
wrangler pipelines delete my-pipeline
```

### Config Binding

```jsonc
{
  "pipelines": [{ "binding": "MY_PIPELINE", "pipeline": "my-pipeline" }],
}
```

---
