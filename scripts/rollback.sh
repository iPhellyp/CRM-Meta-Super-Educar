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

echo "Pausando worker CRM"
docker service scale "${stack_name}_worker=0"

echo "Atualizando app para ${image}"
docker service update --image "$image" --detach=false "${stack_name}_app"

echo "Atualizando e retomando worker para ${image}"
docker service update --image "$image" "${stack_name}_worker"
if [[ "${KEEP_WORKER_PAUSED:-false}" == "true" ]]; then
  echo "Worker permanece pausado por KEEP_WORKER_PAUSED=true"
  echo "Rollback solicitado para tag: ${target_tag}"
  exit 0
fi
docker service scale "${stack_name}_worker=1"
deadline=$((SECONDS + 300))
while (( SECONDS < deadline )); do
  mapfile -t ids < <(
    docker ps --filter "label=com.docker.swarm.service.name=${stack_name}_worker" \
      --format '{{.ID}}'
  )
  if [[ "${#ids[@]}" -eq 1 ]]; then
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "${ids[0]}")"
    [[ "$health" == "healthy" ]] && break
  fi
  sleep 5
done
[[ "${health:-}" == "healthy" ]] || { echo "Worker sem health apos rollback" >&2; exit 1; }

echo "Rollback solicitado para tag: ${target_tag}"
echo "Validar: docker service ps ${stack_name}_app --no-trunc"
echo "Validar: docker service ps ${stack_name}_worker --no-trunc"
echo "Nao foi executado downgrade nem restore de banco."
