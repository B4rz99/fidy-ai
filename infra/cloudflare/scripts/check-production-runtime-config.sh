#!/usr/bin/env bash
set -euo pipefail

required_configuration=(
  PAT_ADMISSION_KEY
  KAPSO_API_KEY
  KAPSO_WEBHOOK_SECRET
  WHATSAPP_BUSINESS_PORTFOLIO_ID
  RESEND_API_KEY
  WOMPI_ENVIRONMENT
  WOMPI_PUBLIC_KEY
  WOMPI_PRIVATE_KEY
  WOMPI_INTEGRITY_SECRET
  WOMPI_EVENT_SECRET
  CLOUDFLARE_ACCESS_ISSUER
  CLOUDFLARE_ACCESS_AUDIENCE
)

for name in "${required_configuration[@]}"; do
  value="${!name-}"
  if [[ -z "${value//[[:space:]]/}" ]]; then
    echo 'check=production_runtime_configuration category=required_configuration_missing' >&2
    exit 1
  fi
done

echo 'Production runtime configuration is present.'
