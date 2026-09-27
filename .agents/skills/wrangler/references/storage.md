# Storage

Examples are starting points. Verify flags against the installed Wrangler version and current official documentation.

## KV (Key-Value Store)

### Manage Namespaces

```bash
# Create namespace
wrangler kv namespace create MY_KV

# List namespaces
wrangler kv namespace list

# Delete namespace
wrangler kv namespace delete --namespace-id <ID>
```

### Manage Keys

```bash
# Put value
wrangler kv key put --namespace-id <ID> "key" "value"

# Put with expiration (seconds)
wrangler kv key put --namespace-id <ID> "key" "value" --expiration-ttl 3600

# Get value
wrangler kv key get --namespace-id <ID> "key"

# List keys
wrangler kv key list --namespace-id <ID>

# Delete key
wrangler kv key delete --namespace-id <ID> "key"

# Bulk put from JSON
wrangler kv bulk put --namespace-id <ID> data.json
```

### Config Binding

```jsonc
{
  "kv_namespaces": [{ "binding": "CACHE", "id": "<NAMESPACE_ID>" }],
}
```

---

## R2 (Object Storage)

### Manage Buckets

```bash
# Create bucket
wrangler r2 bucket create my-bucket

# Create with location hint
wrangler r2 bucket create my-bucket --location wnam

# List buckets
wrangler r2 bucket list

# Get bucket info
wrangler r2 bucket info my-bucket

# Delete bucket
wrangler r2 bucket delete my-bucket
```

### Manage Objects

```bash
# Upload object
wrangler r2 object put my-bucket/path/file.txt --file ./local-file.txt

# Download object
wrangler r2 object get my-bucket/path/file.txt

# Delete object
wrangler r2 object delete my-bucket/path/file.txt
```

### Config Binding

```jsonc
{
  "r2_buckets": [{ "binding": "ASSETS", "bucket_name": "my-bucket" }],
}
```

---

## D1 (SQL Database)

### Manage Databases

```bash
# Create database
wrangler d1 create my-database

# Create with location
wrangler d1 create my-database --location wnam

# List databases
wrangler d1 list

# Get database info
wrangler d1 info my-database

# Delete database
wrangler d1 delete my-database
```

### Execute SQL

```bash
# Execute SQL command (remote)
wrangler d1 execute my-database --remote --command "SELECT * FROM users"

# Execute SQL file (remote)
wrangler d1 execute my-database --remote --file ./schema.sql

# Execute locally
wrangler d1 execute my-database --local --command "SELECT * FROM users"
```

### Migrations

```bash
# Create migration
wrangler d1 migrations create my-database create_users_table

# List pending migrations
wrangler d1 migrations list my-database --local

# Apply migrations locally
wrangler d1 migrations apply my-database --local

# Apply migrations to remote
wrangler d1 migrations apply my-database --remote
```

### Export/Backup

```bash
# Export schema and data
wrangler d1 export my-database --remote --output backup.sql

# Export schema only
wrangler d1 export my-database --remote --output schema.sql --no-data
```

### Config Binding

```jsonc
{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "my-database",
      "database_id": "<DATABASE_ID>",
      "migrations_dir": "./migrations",
    },
  ],
}
```

---
