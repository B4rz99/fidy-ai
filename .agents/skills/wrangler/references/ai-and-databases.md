# Ai And Databases

Examples are starting points. Verify flags against the installed Wrangler version and current official documentation.

## Vectorize (Vector Database)

### Manage Indexes

```bash
# Create index with dimensions
wrangler vectorize create my-index --dimensions 768 --metric cosine

# Create with preset (auto-configures dimensions/metric)
wrangler vectorize create my-index --preset @cf/baai/bge-base-en-v1.5

# List indexes
wrangler vectorize list

# Get index info
wrangler vectorize get my-index

# Delete index
wrangler vectorize delete my-index
```

### Manage Vectors

```bash
# Insert vectors from NDJSON file
wrangler vectorize insert my-index --file vectors.ndjson

# Query vectors
wrangler vectorize query my-index --vector "[0.1, 0.2, ...]" --top-k 10
```

### Config Binding

```jsonc
{
  "vectorize": [{ "binding": "SEARCH_INDEX", "index_name": "my-index" }],
}
```

---

## Hyperdrive (Database Accelerator)

### Manage Configs

```bash
# Create config
wrangler hyperdrive create my-hyperdrive \
  --origin-host db.example.com \
  --origin-port 5432 \
  --database my-database \
  --origin-user db-user \
  --origin-password "$DB_PASSWORD"

# Or using a connection string from an environment variable
wrangler hyperdrive create my-hyperdrive \
  --connection-string "$HYPERDRIVE_CONNECTION_STRING"

# List configs
wrangler hyperdrive list

# Get config details
wrangler hyperdrive get <HYPERDRIVE_ID>

# Update config
wrangler hyperdrive update <HYPERDRIVE_ID> \
  --origin-password "$DB_PASSWORD"

# Delete config
wrangler hyperdrive delete <HYPERDRIVE_ID>
```

### Config Binding

```jsonc
{
  "compatibility_flags": ["nodejs_compat"],
  "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "<HYPERDRIVE_ID>" }],
}
```

---

## Workers AI

### List Models

```bash
# List available models
wrangler ai models

# List finetunes
wrangler ai finetune list
```

### Config Binding

```jsonc
{
  "ai": { "binding": "AI" },
}
```

**Note**: Workers AI always runs remotely and incurs usage charges even in local dev.

---
