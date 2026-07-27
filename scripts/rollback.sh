#!/usr/bin/env bash
set -Eeuo pipefail

target_tag="${1:-}"
[[ "$target_tag" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || {
  echo "Informe uma tag imutavel valida para rollback" >&2
  exit 1
}

stack_name="${STACK_NAME:-crm-meta}"
image="crm-meta-super-educar:${target_tag}"
docker image inspect "$image" > /dev/null

wait_for_one_running_instance() {
  local service="$1"
  local deadline=$((SECONDS + 300))
  local -a task_states
  local -a container_ids

  while (( SECONDS < deadline )); do
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
      return 0
    fi
    sleep 5
  done

  echo "Esperado exatamente uma task e um container Running para ${service}" >&2
  return 1
}

wait_for_one_healthy_instance() {
  local service="$1"
  local deadline=$((SECONDS + 300))
  local -a container_ids
  local health

  wait_for_one_running_instance "$service"
  while (( SECONDS < deadline )); do
    mapfile -t container_ids < <(
      docker ps --filter "label=com.docker.swarm.service.name=${service}" \
        --format '{{.ID}}'
    )
    if [[ "${#container_ids[@]}" -eq 1 ]]; then
      health="$(
        docker inspect \
          --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' \
          "${container_ids[0]}"
      )"
      [[ "$health" == "healthy" ]] && return 0
    fi
    sleep 5
  done

  echo "Esperado health healthy para ${service}" >&2
  return 1
}

ensure_recoverable_services_on_exit() {
  local status=$?
  local postgres_replicas
  local app_replicas
  local worker_replicas
  trap - EXIT
  postgres_replicas="$(
    docker service inspect --format '{{.Spec.Mode.Replicated.Replicas}}' \
      "${stack_name}_postgres" 2>/dev/null || true
  )"
  if [[ "$postgres_replicas" != "1" ]]; then
    echo "PostgreSQL nao pode permanecer pausado; restaurando para 1" >&2
    docker service scale "${stack_name}_postgres=1" > /dev/null || true
    wait_for_one_healthy_instance "${stack_name}_postgres" || true
  fi
  app_replicas="$(
    docker service inspect --format '{{.Spec.Mode.Replicated.Replicas}}' \
      "${stack_name}_app" 2>/dev/null || true
  )"
  worker_replicas="$(
    docker service inspect --format '{{.Spec.Mode.Replicated.Replicas}}' \
      "${stack_name}_worker" 2>/dev/null || true
  )"
  if [[ "$app_replicas" == "0" && "$worker_replicas" == "0" ]]; then
    echo "App e worker estavam pausados; restaurando app para 1" >&2
    docker service scale "${stack_name}_app=1" > /dev/null || true
  fi
  exit "$status"
}

trap ensure_recoverable_services_on_exit EXIT

echo "Pausando worker CRM"
docker service scale "${stack_name}_worker=0"

echo "Garantindo PostgreSQL com uma replica healthy"
docker service scale "${stack_name}_postgres=1"
wait_for_one_healthy_instance "${stack_name}_postgres"

echo "Atualizando app para ${image}"
docker service update --detach=true --no-healthcheck --image "$image" "${stack_name}_app"
docker service scale "${stack_name}_app=1"
wait_for_one_running_instance "${stack_name}_app"

echo "Atualizando worker para ${image}"
docker service update --detach=true --no-healthcheck --image "$image" "${stack_name}_worker"
if [[ "${KEEP_WORKER_PAUSED:-false}" == "true" ]]; then
  echo "Worker permanece pausado por KEEP_WORKER_PAUSED=true"
  echo "App confirmado em execucao com uma task e um container Running"
  echo "Rollback solicitado para tag: ${target_tag}"
  exit 0
fi
docker service scale "${stack_name}_worker=1"
wait_for_one_running_instance "${stack_name}_worker"

echo "Rollback solicitado para tag: ${target_tag}"
echo "Validar: docker service ps ${stack_name}_app --no-trunc"
echo "Validar: docker service ps ${stack_name}_worker --no-trunc"
echo "Nao foi executado downgrade nem restore de banco."
