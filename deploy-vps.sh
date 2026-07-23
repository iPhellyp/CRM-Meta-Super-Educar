#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")"

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Preencha o arquivo .env e execute novamente."
  exit 1
fi

set -a
source .env
set +a

: "${POSTGRES_PASSWORD:?Defina POSTGRES_PASSWORD no .env}"
: "${SESSION_SECRET:?Defina SESSION_SECRET no .env}"
: "${OPERATION_START_AT:?Defina OPERATION_START_AT no .env}"
: "${META_DATASET_ID:?Defina META_DATASET_ID no .env}"
: "${META_CAPI_ACCESS_TOKEN:?Defina META_CAPI_ACCESS_TOKEN no .env}"
: "${META_PAGE_ACCESS_TOKEN:?Defina META_PAGE_ACCESS_TOKEN no .env}"
: "${META_APP_SECRET:?Defina META_APP_SECRET no .env}"
: "${META_WEBHOOK_VERIFY_TOKEN:?Defina META_WEBHOOK_VERIFY_TOKEN no .env}"

if [[ "${COOKIE_SECURE:-}" != "true" ]]; then
  echo "Produção HTTPS exige COOKIE_SECURE=true."
  exit 1
fi

if [[ "${META_TEST_MODE:-false}" == "true" && -z "${META_TEST_EVENT_CODE:-}" ]]; then
  echo "META_TEST_MODE=true exige META_TEST_EVENT_CODE."
  exit 1
fi

docker build -t crm-meta-super-educar:latest .
docker stack deploy -c docker-stack.yml crm-meta

echo "Deploy solicitado. Verifique com: docker service ls | grep crm-meta"
