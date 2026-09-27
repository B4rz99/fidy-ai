# Diagnostics

Examples are starting points. Verify flags against the installed Wrangler version and current official documentation.

## Observability

### Tail Logs

```bash
# Stream live logs
wrangler tail

# Tail specific Worker
wrangler tail my-worker

# Filter by status
wrangler tail --status error

# Filter by search term
wrangler tail --search "error"

# JSON output
wrangler tail --format json
```

### Config Logging

```jsonc
{
  "observability": {
    "enabled": true,
    "head_sampling_rate": 1,
  },
}
```

---

## Troubleshooting

### Common Issues

| Issue                           | Solution                                                                  |
| ------------------------------- | ------------------------------------------------------------------------- |
| `command not found: wrangler`   | Install: `npm install -D wrangler`                                        |
| Auth errors                     | Run `wrangler login`                                                      |
| Startup time limit exceeded     | Run `wrangler check startup` to profile startup and generate CPU profiles |
| Type errors after config change | Run `wrangler types`                                                      |
| Local storage not persisting    | Check `.wrangler/state` directory                                         |
| Binding undefined in Worker     | Verify binding name matches config exactly                                |

### Debug Commands

```bash
# Check auth status
wrangler whoami

# Profile Worker startup time
wrangler check startup

# View config schema
wrangler docs configuration
```

---
