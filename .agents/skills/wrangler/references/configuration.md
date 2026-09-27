# Configuration

Examples are starting points. Verify flags against the installed Wrangler version and current official documentation.

## Quick Start: New Worker

```bash
# Initialize new project
npx wrangler init my-worker

# Or with a framework
npx create-cloudflare@latest my-app
```

## Quick Reference: Core Commands

| Task                        | Command                     |
| --------------------------- | --------------------------- |
| Start local dev server      | `wrangler dev`              |
| Deploy to Cloudflare        | `wrangler deploy`           |
| Deploy dry run              | `wrangler deploy --dry-run` |
| Generate TypeScript types   | `wrangler types`            |
| Profile Worker startup time | `wrangler check startup`    |
| View live logs              | `wrangler tail`             |
| Delete Worker               | `wrangler delete`           |
| Auth status                 | `wrangler whoami`           |

---

## Configuration (wrangler.jsonc)

### Minimal Config

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "my-worker",
  "main": "src/index.ts",
  "compatibility_date": "2026-01-01",
}
```

### Full Config with Bindings

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "my-worker",
  "main": "src/index.ts",
  "compatibility_date": "2026-01-01",
  "compatibility_flags": ["nodejs_compat"],

  // Environment variables
  "vars": {
    "ENVIRONMENT": "production",
  },

  // KV Namespace
  "kv_namespaces": [{ "binding": "KV", "id": "<KV_NAMESPACE_ID>" }],

  // R2 Bucket
  "r2_buckets": [{ "binding": "BUCKET", "bucket_name": "my-bucket" }],

  // D1 Database
  "d1_databases": [{ "binding": "DB", "database_name": "my-db", "database_id": "<DB_ID>" }],

  // Workers AI (always remote)
  "ai": { "binding": "AI" },

  // Vectorize
  "vectorize": [{ "binding": "VECTOR_INDEX", "index_name": "my-index" }],

  // Hyperdrive
  "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "<HYPERDRIVE_ID>" }],

  // Durable Objects
  "durable_objects": {
    "bindings": [{ "name": "COUNTER", "class_name": "Counter" }],
  },

  // Cron triggers
  "triggers": {
    "crons": ["0 * * * *"],
  },

  // Environments
  "env": {
    "staging": {
      "name": "my-worker-staging",
      "vars": { "ENVIRONMENT": "staging" },
    },
  },
}
```

### Generate Types from Config

```bash
# Generate worker-configuration.d.ts
wrangler types

# Custom output path
wrangler types ./src/env.d.ts

# Check types are up to date (CI)
wrangler types --check
```

---
