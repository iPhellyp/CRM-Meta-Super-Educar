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

stack_name="crm-meta"
BACKUP_ROOT="${BACKUP_ROOT:-/root/crm-meta-backups}"
MIGRATION_NETWORK="${MIGRATION_NETWORK:-${stack_name}_internal}"
MIGRATION_TIMEOUT_SECONDS="${MIGRATION_TIMEOUT_SECONDS:-300}"
MIGRATION_SERVICE_NAME_MAX_LENGTH=63
migration_service=""
migration_env=""
KEEP_WORKER_PAUSED="${KEEP_WORKER_PAUSED:-false}"
services_paused=0
migration_completed=0
deploy_completed=0
previous_app_image=""

sanitize_migration_output() {
  local -a sensitive_values=(
    "${DATABASE_URL:-}" "${POSTGRES_PASSWORD:-}" "${ADMIN_PASSWORD_HASH:-}"
    "${SESSION_SECRET:-}" "${META_CAPI_ACCESS_TOKEN:-}" "${META_PAGE_ACCESS_TOKEN:-}"
    "${META_APP_SECRET:-}" "${META_WEBHOOK_VERIFY_TOKEN:-}" "${WA2_INTERNAL_API_SECRET:-}"
    "${META_CREDENTIALS_ENCRYPTION_KEY:-}"
  )
  local line
  local value
  while IFS= read -r line || [[ -n "$line" ]]; do
    for value in "${sensitive_values[@]}"; do
      [[ -n "$value" ]] && line="${line//"$value"/[REDACTED]}"
    done
    printf '%s\n' "$line"
  done | sed -E \
    -e 's#(postgres(ql)?://[^:/[:space:]]+):[^@[:space:]]+@#\1:[REDACTED]@#gI' \
    -e "s/((secret|password|token|api[_-]?key)[\"']?[[:space:]]*[:=][[:space:]]*[\"']?)[^,\"' }[:space:]]+/\1[REDACTED]/gI" \
    -e 's/[A-Za-z0-9+\/_=.-]{48,}/[REDACTED_LONG]/g'
}

cleanup_migration_service() {
  local cleanup_failed=0
  if [[ -n "$migration_service" ]] &&
     docker service inspect "$migration_service" > /dev/null 2>&1; then
    if ! docker service rm "$migration_service" > /dev/null 2>&1; then
      echo "Falha ao remover servico temporario de migration" >&2
      cleanup_failed=1
    fi
  fi
  if [[ -n "$migration_env" ]]; then
    if ! rm -f -- "$migration_env"; then
      echo "Falha ao remover arquivo temporario da migration" >&2
      cleanup_failed=1
    fi
  fi
  return "$cleanup_failed"
}

cleanup_deploy_on_exit() {
  local status=$?
  trap - EXIT

  cleanup_migration_service || true

  if (( status != 0 && services_paused == 1 && deploy_completed == 0 )); then
    echo "Deploy falhou apos pausar app/worker; iniciando recuperacao segura" >&2

    docker service scale "${stack_name}_worker=0" > /dev/null 2>&1 || true
    docker service scale "${stack_name}_postgres=1" > /dev/null 2>&1 || true
    wait_for_one_healthy_instance "${stack_name}_postgres" || true

    if (( migration_completed == 0 )) && [[ -n "$previous_app_image" ]]; then
      echo "Migration nao concluida; restaurando imagem anterior do app" >&2

      docker service update \
        --detach=true \
        --image "$previous_app_image" \
        "${stack_name}_app" > /dev/null 2>&1 || true
    else
      echo "Schema ja migrado; mantendo a nova imagem do app" >&2
    fi

    docker service scale "${stack_name}_app=1" > /dev/null 2>&1 || true
    wait_for_one_healthy_instance "${stack_name}_app" || true

    echo "Recuperacao finalizada: app solicitado em 1 e worker mantido em 0" >&2
  fi

  exit "$status"
}

show_migration_diagnostics() {
  echo "Diagnostico sanitizado da migration:" >&2
  docker service ps "$migration_service" --no-trunc \
    --format 'STATE={{.CurrentState}} ERROR={{.Error}}' 2>&1 |
    sanitize_migration_output >&2 || true
  docker service logs "$migration_service" --tail 100 2>&1 |
    sanitize_migration_output >&2 || true
}

wait_for_migration_service() {
  local deadline=$((SECONDS + MIGRATION_TIMEOUT_SECONDS))
  local task_id=""
  local state=""
  local exit_code="-1"

  while (( SECONDS < deadline )); do
    task_id="$(
      docker service ps "$migration_service" --no-trunc \
        --format '{{.ID}}' 2>/dev/null | head -n 1
    )"
    if [[ -n "$task_id" ]]; then
      state="$(docker inspect --type task --format '{{.Status.State}}' "$task_id" 2>/dev/null || true)"
      if [[ "$state" =~ ^(complete|failed|rejected|shutdown|orphaned|remove)$ ]]; then
        exit_code="$(
          docker inspect --type task \
            --format '{{if .Status.ContainerStatus}}{{.Status.ContainerStatus.ExitCode}}{{else}}-1{{end}}' \
            "$task_id" 2>/dev/null || printf '%s' '-1'
        )"
        if [[ "$state" == "complete" && "$exit_code" == "0" ]]; then
          echo "Migration concluida: task=${task_id} state=${state} exitCode=${exit_code}"
          return 0
        fi
        echo "Migration falhou: state=${state} exitCode=${exit_code}" >&2
        show_migration_diagnostics
        return 1
      fi
    fi
    sleep 2
  done

  echo "Timeout de ${MIGRATION_TIMEOUT_SECONDS}s aguardando migration" >&2
  show_migration_diagnostics
  return 1
}

run_swarm_migration() {
  local image="crm-meta-super-educar:${IMAGE_TAG}"
  local safe_tag
  local epoch
  local create_output

  [[ "$MIGRATION_NETWORK" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] || {
    echo "MIGRATION_NETWORK invalida" >&2
    return 1
  }
  [[ "$MIGRATION_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] &&
    (( MIGRATION_TIMEOUT_SECONDS >= 30 && MIGRATION_TIMEOUT_SECONDS <= 3600 )) || {
      echo "MIGRATION_TIMEOUT_SECONDS deve ficar entre 30 e 3600" >&2
      return 1
    }
  docker network inspect "$MIGRATION_NETWORK" > /dev/null

  safe_tag="$(printf '%s' "$IMAGE_TAG" | tr -c 'A-Za-z0-9_.-' '-' | cut -c1-12)"
  epoch="$(date +%s)"
  migration_service="crmm_${safe_tag}_${epoch}_$$"
  (( ${#migration_service} <= MIGRATION_SERVICE_NAME_MAX_LENGTH )) || {
    echo "Nome do servico temporario de migration excede 63 caracteres" >&2
    return 1
  }
  migration_env="$(mktemp)"
  chmod 600 "$migration_env"
  printf 'DATABASE_URL=%s\nDATABASE_SSL=%s\nDEFAULT_TENANT_ID=%s\n' \
    "$DATABASE_URL" "$DATABASE_SSL" "$DEFAULT_TENANT_ID" > "$migration_env"

  if ! create_output="$(
    docker service create \
      --detach \
      --name "$migration_service" \
      --replicas 1 \
      --restart-condition none \
      --constraint 'node.role==manager' \
      --network "$MIGRATION_NETWORK" \
      --env-file "$migration_env" \
      --env RUN_MIGRATIONS_ON_STARTUP=false \
      --no-resolve-image \
      "$image" npm run migrate 2>&1
  )"; then
    echo "Falha ao criar servico temporario de migration" >&2
    printf '%s\n' "$create_output" | sanitize_migration_output >&2
    return 1
  fi

  wait_for_migration_service
}

trap cleanup_deploy_on_exit EXIT

wait_for_one_healthy_instance() {
  local service="$1"
  local deadline=$((SECONDS + 300))
  local desired_replicas
  local -a task_states
  local -a container_ids
  local health

  while (( SECONDS < deadline )); do
    desired_replicas="$(
      docker service inspect --format '{{.Spec.Mode.Replicated.Replicas}}' \
        "$service" 2>/dev/null || true
    )"
    [[ "$desired_replicas" == "1" ]] || {
      echo "Esperada exatamente uma replica para ${service}; atual: ${desired_replicas:-indisponivel}" >&2
      return 1
    }
    mapfile -t task_states < <(
      docker service ps "$service" --filter desired-state=running \
        --format '{{.CurrentState}}'
    )
    mapfile -t container_ids < <(
      docker ps --filter "label=com.docker.swarm.service.name=${service}" \
        --format '{{.ID}}'
    )
    if [[ "${#task_states[@]}" -eq 1 &&
          "${task_states[0]}" == Running* &&
          "${#container_ids[@]}" -eq 1 ]]; then
      health="$(
        docker inspect \
          --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' \
          "${container_ids[0]}"
      )"
      [[ "$health" == "healthy" ]] && return 0
    fi
    sleep 5
  done
  echo "Esperada exatamente uma task e um container Running e healthy para ${service}" >&2
  return 1
}

for name in \
  POSTGRES_PASSWORD DATABASE_URL DATABASE_SSL ADMIN_EMAIL ADMIN_PASSWORD_HASH \
  SESSION_SECRET COOKIE_SECURE OPERATION_START_AT META_DATASET_ID \
  META_CAPI_ACCESS_TOKEN META_PAGE_ACCESS_TOKEN META_APP_SECRET \
  META_WEBHOOK_VERIFY_TOKEN META_GRAPH_VERSION META_TEST_MODE \
  META_CREDENTIALS_ENCRYPTION_KEY \
  META_LEAD_EVENT_SOURCE DEFAULT_TENANT_ID APP_URL \
  WA2_INTERNAL_API_BASE_URL WA2_INTERNAL_API_SECRET WA2_INTERNAL_API_TIMEOUT_MS \
  CRM_INTERNAL_API_SECRET
do
  require_env "$name"
done

[[ "$COOKIE_SECURE" == "true" ]] || { echo "COOKIE_SECURE deve ser true" >&2; exit 1; }
[[ "$DATABASE_SSL" =~ ^(true|false)$ ]] || { echo "DATABASE_SSL invalido" >&2; exit 1; }
[[ "$META_TEST_MODE" == "false" ]] || { echo "META_TEST_MODE deve ser false" >&2; exit 1; }
[[ "$KEEP_WORKER_PAUSED" =~ ^(true|false)$ ]] || {
  echo "KEEP_WORKER_PAUSED deve ser true ou false" >&2
  exit 1
}
[[ "$APP_URL" == https://* ]] || { echo "APP_URL deve usar HTTPS" >&2; exit 1; }
[[ "${WA2_INTERNAL_API_PRIVATE:-false}" =~ ^(true|false)$ ]] || {
  echo "WA2_INTERNAL_API_PRIVATE invalido" >&2
  exit 1
}
if [[ "$WA2_INTERNAL_API_PRIVATE" == "true" ]]; then
  [[ "$WA2_INTERNAL_API_BASE_URL" == "http://crm-meta-whatsapp_app:3000" ]] || {
    echo "WA2_INTERNAL_API_BASE_URL privado invalido" >&2
    exit 1
  }
else
  [[ "$WA2_INTERNAL_API_BASE_URL" == "https://wa2.supereducarbrasil.com.br" ]] || {
    echo "WA2_INTERNAL_API_BASE_URL deve usar o dominio HTTPS oficial" >&2
    exit 1
  }
fi
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

if [[ "$WA2_INTERNAL_API_PRIVATE" == "true" ]]; then
  crm_app_container="$(get_one_running_container_id "${stack_name}_app")"
  docker exec "$crm_app_container" node -e 'fetch(process.env.WA2_INTERNAL_API_BASE_URL + "/api/internal/v1/health", { headers: { authorization: "Bearer " + process.env.WA2_INTERNAL_API_SECRET } }).then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1))'
  echo "HTTP interno CRM -> WA2 confirmado na rede privada"
else
  wa2_host="$(node -e 'console.log(new URL(process.env.WA2_INTERNAL_API_BASE_URL).hostname)')"
  getent hosts "$wa2_host" > /dev/null
  printf 'silent\nshow-error\nfail\nheader = "Authorization: Bearer %s"\n' "$WA2_INTERNAL_API_SECRET" |
    curl --fail --silent --show-error --config - \
      "${WA2_INTERNAL_API_BASE_URL%/}/api/internal/v1/health" > /dev/null
  echo "DNS e HTTPS CRM -> WA2 confirmados via Traefik"
fi

wait_for_one_healthy_instance "${stack_name}_postgres"
echo "PostgreSQL confirmado com uma replica, uma task Running e health healthy"

BACKUP_ROOT="$BACKUP_ROOT" bash ./scripts/backup.sh
docker build --build-arg "RELEASE_VERSION=${IMAGE_TAG}" -t "crm-meta-super-educar:${IMAGE_TAG}" .
echo "Imagem publicada localmente: crm-meta-super-educar:${IMAGE_TAG}"

previous_app_image="$(
  docker service inspect \
    --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' \
    "${stack_name}_app"
)"

[[ -n "$previous_app_image" ]] || {
  echo "Nao foi possivel identificar a imagem anterior do app" >&2
  exit 1
}

echo "Imagem anterior do app registrada: ${previous_app_image}"

export APP_REPLICAS=0
export WORKER_REPLICAS=0
services_paused=1

docker stack deploy --resolve-image never -c docker-stack.yml "$stack_name"

wait_for_one_healthy_instance "${stack_name}_postgres"
echo "PostgreSQL permaneceu healthy apos pausar app e worker"

run_swarm_migration
migration_completed=1

cleanup_migration_service
migration_service=""
migration_env=""

export APP_REPLICAS=1
docker stack deploy --resolve-image never -c docker-stack.yml "$stack_name"
wait_for_one_healthy_instance "${stack_name}_app"

if [[ "$KEEP_WORKER_PAUSED" == "true" ]]; then
  docker service scale "${stack_name}_worker=0" > /dev/null

  deploy_completed=1

  echo "Deploy concluido com tag: ${IMAGE_TAG}"
  echo "Worker mantido pausado por KEEP_WORKER_PAUSED=true"
  echo "Inspecao: docker stack services crm-meta"
  echo "Inspecao: docker service ps crm-meta_app --no-trunc"
  echo "Inspecao: docker service ps crm-meta_worker --no-trunc"
  echo "Nenhuma importacao de leads foi executada."

  exit 0
fi

export WORKER_REPLICAS=1
docker stack deploy --resolve-image never -c docker-stack.yml "$stack_name"
wait_for_one_healthy_instance "${stack_name}_worker"

deploy_completed=1

echo "Deploy concluido com tag: ${IMAGE_TAG}"
echo "Inspecao: docker stack services crm-meta"
echo "Inspecao: docker service ps crm-meta_app --no-trunc"
echo "Inspecao: docker service ps crm-meta_worker --no-trunc"
echo "Nenhuma importacao de leads foi executada."
