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

As credenciais das conexões Meta são cifradas com
`META_CREDENTIALS_ENCRYPTION_KEY` (32 bytes em Base64). Essa chave deve ficar
no ambiente seguro do app e do worker e não deve ser rotacionada sem um plano
de recifragem das credenciais existentes.

## Ordem oficial

`./deploy-vps.sh` valida variáveis, Git limpo, branch e commit; escolhe
`IMAGE_TAG` (SHA curto por padrão); confirma CRM → WA2; executa backup; constrói
a imagem; pausa app/worker; executa um único `npm run migrate`; atualiza o app;
atualiza o worker; e aguarda as atualizações do Swarm.

No primeiro rollout da migration 006, execute
`KEEP_WORKER_PAUSED=true ./deploy-vps.sh`. Nesse modo, o app é iniciado e
validado, enquanto o worker permanece com zero réplicas para inspeção manual.

Se o deploy falhar depois de pausar app e worker, o trap de saída mantém o
worker parado e tenta recuperar o app. Antes da conclusão da migration, restaura
a imagem anterior do app. Depois da migration, mantém a nova imagem compatível
com o schema e solicita novamente uma réplica do app.

A migration usa o runner SQL existente em um serviço Swarm temporário, com uma
única tarefa no manager, sem exigir rede overlay attachable. O serviço aguarda
estado `complete` e exit code `0`, tem timeout de 300 segundos e é removido em
sucesso ou falha. `MIGRATION_NETWORK` permite substituir a rede interna e
`MIGRATION_TIMEOUT_SECONDS` permite ajustar o timeout. O nome temporário usa
`crmm_<tag-sanitizada>_<epoch>_<pid>`, limita a tag a 12 caracteres e é
validado explicitamente para nunca ser enviado ao Swarm com mais de 63
caracteres. Com epoch de 10 dígitos e PID Linux de até 7 dígitos, o máximo
calculado é 36 caracteres. Não se usa `docker run` nem `migrate dev`. Qualquer
falha interrompe o script antes da atualização. Localmente, a ausência de
`RUN_MIGRATIONS_ON_STARTUP` mantém a compatibilidade anterior; defina `false`
quando quiser executar `npm run migrate` separadamente. No Compose local,
somente o app migra no startup; o worker aguarda o mesmo banco e não concorre.

## Backup e rollback

`scripts/backup.sh` cria `pg_dump` custom, valida com `pg_restore --list`,
gera SHA-256, usa diretório `0700`/arquivos restritos e nunca remove backups.
Por padrão, grava fora do repositório em `/root/crm-meta-backups`. A variável
externa `BACKUP_ROOT` permite override e o deploy a passa explicitamente ao
script de backup.

Rollback exige tag imutável:

```bash
bash ./scripts/rollback.sh TAG_ANTERIOR
```

O worker é pausado antes da troca. App e worker são atualizados com
`--no-healthcheck`, compatível com imagens antigas. O app é escalado
explicitamente para 1 e precisa apresentar exatamente uma task e um container
`Running`. Com `KEEP_WORKER_PAUSED=true`, apenas o worker permanece em 0; no
fluxo normal, ele é escalado para 1 e validado pelo mesmo critério. Não há
downgrade automático de schema.
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
