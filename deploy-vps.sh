#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")"

env_file="${CRM_ENV_FILE:-.env}"
[[ -f "$env_file" ]] || {
  echo "Arquivo de ambiente ausente: $env_file" >&2
  exit 1
}

set -a
# shellcheck disable=SC1090
source "$env_file"
set +a

require_env() {
  local name="$1"
  [[ -n "${!name:-}" ]] || {
    echo "Variavel obrigatoria ausente: $name" >&2
    exit 1
  }
  echo "OK: $name presente"
}

wait_for_healthy_service() {
  local service="$1"
  local deadline=$((SECONDS + 300))
  local -a ids
  local health
  while (( SECONDS < deadline )); do
    mapfile -t ids < <(
      docker ps --filter "label=com.docker.swarm.service.name=${service}" \
        --format '{{.ID}}'
    )
    if [[ "${#ids[@]}" -eq 1 ]]; then
      health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "${ids[0]}")"
      [[ "$health" == "healthy" ]] && return 0
    fi
    sleep 5
  done
  echo "Timeout aguardando healthcheck de ${service}" >&2
  return 1
}

for name in \
  POSTGRES_PASSWORD DATABASE_URL DATABASE_SSL ADMIN_EMAIL ADMIN_PASSWORD_HASH \
  SESSION_SECRET COOKIE_SECURE OPERATION_START_AT META_DATASET_ID \
  META_CAPI_ACCESS_TOKEN META_PAGE_ACCESS_TOKEN META_APP_SECRET \
  META_WEBHOOK_VERIFY_TOKEN META_GRAPH_VERSION META_TEST_MODE \
  META_LEAD_EVENT_SOURCE DEFAULT_TENANT_ID APP_URL \
  WA2_INTERNAL_API_BASE_URL WA2_INTERNAL_API_SECRET WA2_INTERNAL_API_TIMEOUT_MS
do
  require_env "$name"
done

[[ "$COOKIE_SECURE" == "true" ]] || { echo "COOKIE_SECURE deve ser true" >&2; exit 1; }
[[ "$DATABASE_SSL" =~ ^(true|false)$ ]] || { echo "DATABASE_SSL invalido" >&2; exit 1; }
[[ "$META_TEST_MODE" == "false" ]] || { echo "META_TEST_MODE deve ser false" >&2; exit 1; }
[[ "$APP_URL" == https://* ]] || { echo "APP_URL deve usar HTTPS" >&2; exit 1; }
[[ "$WA2_INTERNAL_API_BASE_URL" == "https://wa2.supereducarbrasil.com.br" ]] || {
  echo "WA2_INTERNAL_API_BASE_URL deve usar o dominio HTTPS oficial" >&2
  exit 1
}
[[ "$ADMIN_PASSWORD_HASH" == scrypt\$* ]] || { echo "ADMIN_PASSWORD_HASH invalido" >&2; exit 1; }
(( ${#SESSION_SECRET} >= 64 )) || { echo "SESSION_SECRET deve ter ao menos 64 caracteres" >&2; exit 1; }

git diff --quiet
git diff --cached --quiet
[[ -z "$(git status --porcelain)" ]] || { echo "Git deve estar limpo" >&2; exit 1; }

branch="$(git branch --show-current)"
commit="$(git rev-parse HEAD)"
short_sha="$(git rev-parse --short=12 HEAD)"
if [[ "${IMAGE_TAG+x}" == "x" ]]; then
  [[ -n "$IMAGE_TAG" ]] || { echo "IMAGE_TAG nao pode ser vazia" >&2; exit 1; }
else
  IMAGE_TAG="$short_sha"
fi
[[ "$IMAGE_TAG" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || {
  echo "IMAGE_TAG invalida ou vazia" >&2
  exit 1
}
export IMAGE_TAG
echo "Git confirmado: branch=${branch} commit=${commit}"
echo "Tag imutavel selecionada: ${IMAGE_TAG}"

wa2_host="$(node -e 'console.log(new URL(process.env.WA2_INTERNAL_API_BASE_URL).hostname)')"
getent hosts "$wa2_host" > /dev/null
printf 'silent\nshow-error\nfail\nheader = "Authorization: Bearer %s"\n' "$WA2_INTERNAL_API_SECRET" |
  curl --fail --silent --show-error --config - \
    "${WA2_INTERNAL_API_BASE_URL%/}/api/internal/v1/health" > /dev/null
echo "DNS e HTTPS CRM -> WA2 confirmados via Traefik"

bash ./scripts/backup.sh
docker build -t "crm-meta-super-educar:${IMAGE_TAG}" .
echo "Imagem publicada localmente: crm-meta-super-educar:${IMAGE_TAG}"

export APP_REPLICAS=0
export WORKER_REPLICAS=0
docker stack deploy --resolve-image never -c docker-stack.yml crm-meta

docker run --rm \
  --network crm-meta_internal \
  --env-file "$env_file" \
  --env RUN_MIGRATIONS_ON_STARTUP=false \
  "crm-meta-super-educar:${IMAGE_TAG}" npm run migrate

export APP_REPLICAS=1
docker stack deploy --resolve-image never -c docker-stack.yml crm-meta
wait_for_healthy_service "crm-meta_app"

export WORKER_REPLICAS=1
docker stack deploy --resolve-image never -c docker-stack.yml crm-meta
wait_for_healthy_service "crm-meta_worker"

echo "Deploy concluido com tag: ${IMAGE_TAG}"
echo "Inspecao: docker stack services crm-meta"
echo "Inspecao: docker service ps crm-meta_app --no-trunc"
echo "Inspecao: docker service ps crm-meta_worker --no-trunc"
echo "Nenhuma importacao de leads foi executada."
