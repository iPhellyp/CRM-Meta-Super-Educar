# Deploy de produção endurecido

Arquitetura escolhida para CRM → WA2: **HTTPS externo via Traefik**.
App e worker do CRM usam `https://wa2.supereducarbrasil.com.br` com Bearer.
O worker permanece somente na rede interna do CRM; não precisa da `iPHnet`.
O `deploy-vps.sh` confirma resolução DNS e chama o health protegido por HTTPS
sem imprimir o segredo.

## Variáveis

O app e o worker recebem `WA2_INTERNAL_API_BASE_URL`,
`WA2_INTERNAL_API_SECRET` e `WA2_INTERNAL_API_TIMEOUT_MS`. Em produção ambos
recebem `RUN_MIGRATIONS_ON_STARTUP=false`. Valores reais ficam somente no
arquivo de ambiente da VPS, nunca no Git.

## Ordem oficial

`./deploy-vps.sh` valida variáveis, Git limpo, branch e commit; escolhe
`IMAGE_TAG` (SHA curto por padrão); confirma CRM → WA2; executa backup; constrói
a imagem; pausa app/worker; executa um único `npm run migrate`; atualiza o app;
atualiza o worker; e aguarda as atualizações do Swarm.

A migration usa o runner SQL existente e advisory lock PostgreSQL. Qualquer
falha interrompe o script antes da atualização. Localmente, a ausência de
`RUN_MIGRATIONS_ON_STARTUP` mantém a compatibilidade anterior; defina `false`
quando quiser executar `npm run migrate` separadamente. No Compose local,
somente o app migra no startup; o worker aguarda o mesmo banco e não concorre.

## Backup e rollback

`scripts/backup.sh` cria `pg_dump` custom, valida com `pg_restore --list`,
gera SHA-256, usa diretório `0700`/arquivos restritos e nunca remove backups.

Rollback exige tag imutável:

```bash
bash ./scripts/rollback.sh TAG_ANTERIOR
```

O worker é pausado antes da troca. Não há downgrade automático de schema.
Tabelas/colunas aditivas permanecem. Restore de banco somente com corrupção
comprovada e autorização explícita. Se bindings/importações precisarem ficar
desativados durante a validação, use
`KEEP_WORKER_PAUSED=true bash ./scripts/rollback.sh TAG_ANTERIOR`.

## Inspeção

```bash
docker stack services crm-meta
docker service ps crm-meta_app --no-trunc
docker service ps crm-meta_worker --no-trunc
docker service logs crm-meta_app --tail 200
docker service logs crm-meta_worker --tail 200
```

A importação histórica de leads não faz parte do deploy.
