#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

STACK_NAME="${STACK_NAME:-crm-meta}"
BACKUP_ROOT="${BACKUP_ROOT:-/root/crm-meta-backups}"

[[ "$STACK_NAME" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]*$ ]] || {
  echo "STACK_NAME invalido" >&2
  exit 1
}

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_dir="${BACKUP_ROOT%/}/${STACK_NAME}/${timestamp}"
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"

mapfile -t postgres_ids < <(
  docker ps --filter "label=com.docker.swarm.service.name=${STACK_NAME}_postgres" \
    --format '{{.ID}}'
)
[[ "${#postgres_ids[@]}" -eq 1 && -n "${postgres_ids[0]}" ]] || {
  echo "Esperado exatamente um container PostgreSQL de ${STACK_NAME}" >&2
  exit 1
}

dump_file="${backup_dir}/postgres.dump"
docker exec "${postgres_ids[0]}" sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump --format=custom --no-owner --no-acl -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  > "$dump_file"
docker exec -i "${postgres_ids[0]}" pg_restore --list < "$dump_file" > /dev/null
sha256sum "$dump_file" > "${dump_file}.sha256"

echo "Backup CRM verificado em: $backup_dir"
