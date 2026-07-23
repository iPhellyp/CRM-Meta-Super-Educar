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
: "${DATABASE_SSL:?Defina DATABASE_SSL no .env}"
: "${ADMIN_EMAIL:?Defina ADMIN_EMAIL no .env}"
: "${ADMIN_PASSWORD_HASH:?Defina ADMIN_PASSWORD_HASH no .env}"
: "${SESSION_SECRET:?Defina SESSION_SECRET no .env}"
: "${OPERATION_START_AT:?Defina OPERATION_START_AT no .env}"
: "${META_DATASET_ID:?Defina META_DATASET_ID no .env}"
: "${META_CAPI_ACCESS_TOKEN:?Defina META_CAPI_ACCESS_TOKEN no .env}"
: "${META_PAGE_ACCESS_TOKEN:?Defina META_PAGE_ACCESS_TOKEN no .env}"
: "${META_APP_SECRET:?Defina META_APP_SECRET no .env}"
: "${META_WEBHOOK_VERIFY_TOKEN:?Defina META_WEBHOOK_VERIFY_TOKEN no .env}"
: "${META_GRAPH_VERSION:?Defina META_GRAPH_VERSION no .env}"
: "${META_TEST_MODE:?Defina META_TEST_MODE no .env}"
: "${META_LEAD_EVENT_SOURCE:?Defina META_LEAD_EVENT_SOURCE no .env}"
: "${DEFAULT_TENANT_ID:?Defina DEFAULT_TENANT_ID no .env}"
: "${APP_URL:?Defina APP_URL no .env}"

if [[ "${POSTGRES_PASSWORD}" == troque* || "${META_WEBHOOK_VERIFY_TOKEN}" == troque* ]]; then
  echo "Substitua todos os valores de exemplo antes do deploy."
  exit 1
fi

if [[ "${ADMIN_PASSWORD_HASH}" != scrypt\$* ]]; then
  echo "ADMIN_PASSWORD_HASH deve conter um hash scrypt gerado conforme o README."
  exit 1
fi

if (( ${#SESSION_SECRET} < 64 )); then
  echo "SESSION_SECRET deve ter pelo menos 64 caracteres."
  exit 1
fi

if [[ "${COOKIE_SECURE:-}" != "true" ]]; then
  echo "Produção HTTPS exige COOKIE_SECURE=true."
  exit 1
fi

if [[ "${DATABASE_SSL}" != "true" && "${DATABASE_SSL}" != "false" ]]; then
  echo "DATABASE_SSL deve ser true ou false."
  exit 1
fi

if [[ ! "${META_GRAPH_VERSION}" =~ ^v[0-9]+\.[0-9]+$ ]]; then
  echo "META_GRAPH_VERSION deve usar o formato vNN.N."
  exit 1
fi

if [[ "${META_TEST_MODE}" != "true" && "${META_TEST_MODE}" != "false" ]]; then
  echo "META_TEST_MODE deve ser true ou false."
  exit 1
fi

if [[ "${APP_URL}" != https://* ]]; then
  echo "APP_URL deve usar HTTPS em produção."
  exit 1
fi

if [[ "${META_TEST_MODE:-false}" == "true" && -z "${META_TEST_EVENT_CODE:-}" ]]; then
  echo "META_TEST_MODE=true exige META_TEST_EVENT_CODE."
  exit 1
fi

docker build -t crm-meta-super-educar:latest .
docker stack deploy -c docker-stack.yml crm-meta

echo "Deploy solicitado. Verifique com: docker service ls | grep crm-meta"
