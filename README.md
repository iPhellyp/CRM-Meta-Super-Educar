# CRM Meta Super Educar — Bridge operacional

Serviço enxuto e separado do SR Gestão para:

- receber leads de Formulários Instantâneos da Meta;
- importar os dados do lead pela Graph API com múltiplas conexões, páginas e formulários;
- controlar o funil comercial e abrir conversas no WhatsApp;
- sincronizar etapas e etiquetas com o WA Sender 2;
- enviar `Marketing Qualified Lead`, `Sales Opportunity` e `Converted` pela Conversions API;
- manter fila persistente, tentativas e histórico de movimentações.

## Limite deste projeto

Este é um bridge operacional. Matrícula e pagamento continuam dependendo de confirmação do sistema de origem; o CRM não os confirma por clique manual.

## Limitações conhecidas desta versão

- integração automática com o SR Gestão;
- Ads Insights API;
- gastos, CPM, CTR e CPC no CRM;
- Pixel para website;
- Conversions API para Web;
- automações comerciais avançadas.

## Como o fluxo funciona

1. A Meta envia o webhook para `POST /webhooks/meta/leadgen`.
2. O app identifica a conexão pela página/formulário e valida `X-Hub-Signature-256` com o segredo cifrado da conexão (com fallback legado controlado).
3. O payload é registrado no PostgreSQL com status `PENDING`.
4. O app devolve HTTP 200 depois da persistência, sem chamar a Graph API.
5. O worker importa o lead e conclui o job somente após sucesso.
6. Falhas temporárias usam backoff automático e podem terminar em `FAILED`.
7. Qualificado e oportunidade criam os eventos correspondentes; somente pagamento confirmado cria `Converted`.

Os estados da fila são `PENDING`, `PROCESSING`, `COMPLETED`, `RETRY` e `FAILED`. O painel **Eventos Meta** permite reenfileirar somente jobs `FAILED`.

### Importação de arquivo de leads

Em **Importação e reconciliação**, a opção **Importar arquivo de leads** aceita
CSV UTF-8, XLSX e XLS da Meta. O sistema gera uma prévia obrigatória, classifica
novos registros, atualizações pelo mesmo ID Meta, possíveis duplicidades por
telefone e linhas inválidas. Nenhum lead é alterado antes da confirmação.

O arquivo é processado somente em memória e descartado após a requisição. A
confirmação é autenticada, protegida por CSRF, transacional e idempotente.
`lead_status` nunca altera a etapa comercial. Os formatos, limites e regras
completos estão em [`docs/spreadsheet-import.md`](docs/spreadsheet-import.md).

## Variáveis de ambiente

Crie o `.env` a partir do exemplo e nunca envie esse arquivo ao repositório:

```env
NODE_ENV=production
PORT=3000
APP_URL=https://crm.supereducarbrasil.com.br

POSTGRES_PASSWORD=
DATABASE_URL=postgresql://crm_meta:SENHA@postgres:5432/crm_meta
DATABASE_SSL=false
RUN_MIGRATIONS_ON_STARTUP=false

ADMIN_EMAIL=
ADMIN_PASSWORD_HASH=
SESSION_SECRET=
COOKIE_SECURE=true
OPERATION_START_AT=2026-07-23T00:00:00-03:00

META_GRAPH_VERSION=v25.0
META_CREDENTIALS_ENCRYPTION_KEY=
META_DATASET_ID=
META_CAPI_ACCESS_TOKEN=
META_PAGE_ACCESS_TOKEN=
META_APP_SECRET=
META_WEBHOOK_VERIFY_TOKEN=
META_LEAD_EVENT_SOURCE=Super Educar CRM
META_TEST_MODE=true
META_TEST_EVENT_CODE=

DEFAULT_TENANT_ID=super-educar

WA2_INTERNAL_API_BASE_URL=https://wa2.supereducarbrasil.com.br
WA2_INTERNAL_API_SECRET=
WA2_INTERNAL_API_TIMEOUT_MS=5000
```

`OPERATION_START_AT` deve ser uma data ISO 8601 com fuso. A tela principal e seus indicadores mostram, por padrão, apenas leads criados a partir dela. Leads anteriores continuam armazenados sem alteração.

### WA Sender 2 opcional

A integração administrativa com o WA2 é opcional. Para ativá-la, configure juntos
`WA2_INTERNAL_API_BASE_URL` e `WA2_INTERNAL_API_SECRET`. Se ambos estiverem vazios,
o CRM inicia normalmente e mostra a integração como desativada. O timeout server-side
é definido por `WA2_INTERNAL_API_TIMEOUT_MS`.

Health, instâncias, status, QR, conexão, sincronização e desconexão são consultados
somente pelo servidor do CRM. O segredo Bearer nunca é enviado ao navegador. Os
comandos são assíncronos: o painel confirma apenas que a solicitação foi enviada.

O QR é validado, convertido em imagem por uma rota autenticada com cache desativado
e nunca é persistido pelo CRM. Ele não deve aparecer em logs, URLs, cookies ou banco.

### Vínculo manual de leads com o WA2

O Checkpoint 2B adiciona a migration aditiva `003_wa2_contact_links.sql`, ainda não
aplicada por esta alteração. Ela mantém o telefone bruto e acrescenta
`phone_normalized`, usando somente números brasileiros válidos com DDI `55`. Telefones
inválidos ficam com o valor normalizado nulo, e não existe índice único por telefone.
Leads duplicados não são unidos nem apagados.

Uma instância remota só pode ser salva localmente depois de ser consultada e validada
pelo servidor do CRM. O vínculo com contato/chat também é manual: o servidor relê o
lead e a instância, consulta o WA2 por telefone exato e repete a consulta durante a
confirmação. O navegador não decide tenant, telefone, chat ou JID.

Desvínculos são lógicos e preservam histórico. Uma substituição exige confirmação
explícita e mantém o vínculo anterior como inativo. O CRM não cria leads orgânicos
nem altera etapas a partir de etiquetas recebidas do WA2.

### Sincronização de etapas com etiquetas WA2

A migration aditiva `004_wa2_label_sync.sql` cria os bindings por instância e a fila
local de etiquetas. O administrador escolhe IDs de etiquetas que o servidor confirma
novamente no WA2. As etapas equivalentes convergem para quatro etiquetas:
`CRM 01 Em atendimento`, `CRM 02 Qualificado`, `CRM 04 Oportunidade` e
`CRM 99 Perdido`.

Quando uma etapa muda, o histórico e o job WA2 são gravados na mesma transação local.
O worker consulta o chat depois do commit, aplica a etiqueta desejada e remove somente
IDs cadastrados como etiquetas CRM na mesma instância. Etiquetas externas são
preservadas. O job só chega a `DONE` depois de uma nova consulta confirmar o estado;
aceites remotos ainda pendentes voltam à fila. Falhas transitórias usam backoff e jobs
`FAILED` podem ser reenfileirados sem zerar o contador de tentativas.

Em produção HTTPS, `COOKIE_SECURE=true` é obrigatório. Use `COOKIE_SECURE=false` apenas no acesso local por `http://localhost`.

### Gerar o hash da senha administrativa

A senha não é armazenada nem comparada em texto puro. Gere um hash `scrypt` localmente e copie somente a saída para `ADMIN_PASSWORD_HASH`.

PowerShell:

```powershell
$securePassword = Read-Host "Senha administrativa" -AsSecureString
$env:CRM_PASSWORD_TO_HASH = [Net.NetworkCredential]::new("", $securePassword).Password
node -e "const c=require('node:crypto');const s=c.randomBytes(16);const h=c.scryptSync(process.env.CRM_PASSWORD_TO_HASH,s,32,{N:16384,r:8,p:1,maxmem:67108864});console.log(['scrypt',16384,8,1,s.toString('hex'),h.toString('hex')].join(String.fromCharCode(36)))"
Remove-Item Env:CRM_PASSWORD_TO_HASH
```

Linux:

```bash
read -rsp "Senha administrativa: " CRM_PASSWORD_TO_HASH
export CRM_PASSWORD_TO_HASH
node -e "const c=require('node:crypto');const s=c.randomBytes(16);const h=c.scryptSync(process.env.CRM_PASSWORD_TO_HASH,s,32,{N:16384,r:8,p:1,maxmem:67108864});console.log(['scrypt',16384,8,1,s.toString('hex'),h.toString('hex')].join(String.fromCharCode(36)))"
unset CRM_PASSWORD_TO_HASH
```

No `.env`, coloque o hash entre aspas simples para preservar os caracteres `$`:

```env
ADMIN_PASSWORD_HASH='scrypt$16384$8$1$SAL_HEX$HASH_HEX'
```

## PowerShell local / Windows

### Opção recomendada: Docker Desktop

```powershell
Copy-Item .env.example .env
notepad .env
```

No `.env` local, use:

```env
NODE_ENV=development
APP_URL=http://localhost:3000
COOKIE_SECURE=false
```

Depois:

```powershell
docker compose config
docker compose up --build
```

O Compose inicia PostgreSQL, app e worker. Abra `http://localhost:3000`.

### Executar app e worker separadamente

Com um PostgreSQL acessível por `DATABASE_URL`, instale as dependências:

```powershell
npm install
npm run check
```

Em um terminal:

```powershell
npm run dev
```

Em outro terminal:

```powershell
npm run dev:worker
```

Sem modo watch, os comandos equivalentes são:

```powershell
npm run start
npm run worker
```

## VPS / Linux via SSH — Docker Swarm + Traefik

O procedimento autoritativo de deploy, migration, backup e rollback está em
[`docs/DEPLOY_PRODUCTION.md`](docs/DEPLOY_PRODUCTION.md).

Execute estes comandos somente na sessão SSH da VPS, não no PowerShell local:

```bash
mkdir -p /root/crm-meta
cd /root/crm-meta
cp .env.example .env
nano .env
```

Antes do deploy, confirme no `.env`:

```env
NODE_ENV=production
APP_URL=https://crm.supereducarbrasil.com.br
COOKIE_SECURE=true
META_TEST_MODE=false
META_TEST_EVENT_CODE=
```

Valide a configuração sem iniciar serviços:

```bash
docker compose -f docker-stack.yml config
```

Quando a janela de produção estiver autorizada:

```bash
chmod +x deploy-vps.sh
./deploy-vps.sh
```

Verificação operacional:

```bash
docker service ls | grep crm-meta
docker service logs -f crm-meta_app
docker service logs -f crm-meta_worker
docker service logs -f crm-meta_postgres
```

O domínio esperado é `https://crm.supereducarbrasil.com.br`. Confirme previamente o DNS, o certificado do Traefik e a existência da rede externa `iPHnet`.

## Configurar o webhook na Meta

Callback:

```text
https://crm.supereducarbrasil.com.br/webhooks/meta/leadgen
```

Use em **Verify token** o mesmo valor de `META_WEBHOOK_VERIFY_TOKEN`, assine o campo `leadgen` e associe a Página ao aplicativo.

`META_APP_SECRET` é obrigatório no recebimento: sem ele, ou sem uma assinatura HMAC válida, o POST retorna HTTP 401.

## Testar antes de produção

### 1. Verificações locais sem chamadas externas

```powershell
npm run check
docker compose config
```

Depois de iniciar o ambiente local, confira:

```powershell
Invoke-RestMethod http://localhost:3000/health
docker compose ps
docker compose logs app
docker compose logs worker
```

O `/health` público retorna apenas `{"ok":true}` quando app e banco respondem. O healthcheck separado do worker valida a atualidade do heartbeat sem expor detalhes.

### 2. Teste integrado com a Meta

1. No Gerenciador de Eventos, abra **Testar eventos** e copie o código.
2. Defina `META_TEST_MODE=true` e `META_TEST_EVENT_CODE`.
3. Reinicie app e worker para carregar as variáveis.
4. Gere um lead de teste no Formulário Instantâneo.
5. Confirme no painel que o job de importação chegou a `COMPLETED`.
6. Confirme que o lead apareceu com o `leadgen_id`.
7. Marque como **Qualificado**, **Oportunidade** e **Matriculado**, conferindo cada evento de teste.
8. Simule e corrija uma falha de credencial em ambiente de teste; confirme o status `FAILED` e a ação **Reenviar**.
9. Antes da produção, remova o código de teste, defina `META_TEST_MODE=false` e mantenha `COOKIE_SECURE=true`.

Os testes integrados exigem credenciais reais de um aplicativo, Página e dataset Meta de teste/homologação.

## Idempotência e histórico

- A restrição única `(tenant_id, meta_lead_id)` impede dois leads para o mesmo `leadgen_id`.
- Cada importação tem uma chave única `leadgen:<leadgen_id>`.
- Cada conversão usa um `event_id` determinístico por lead, evento e modo.
- Eventos `test` e `live` têm IDs e jobs distintos.
- Um evento já marcado como `SENT` não é enviado novamente.
- O mesmo `event_id` também permite deduplicação pela Meta caso o worker caia após a aceitação remota e antes da confirmação local.
- Cada mudança de etapa grava etapa anterior, nova etapa, data e origem.
- Leads sem o `leadgen_id` original podem ser operados no painel, mas não geram conversões atribuídas à Meta.

## Eventos enviados

| Etapa | Evento Meta |
|---|---|
| `QUALIFIED` | `Marketing Qualified Lead` |
| `OPPORTUNITY` | `Sales Opportunity` |
| `MATRICULATED` | `Converted` |

Este fluxo é server-side e envia eventos diretamente ao dataset pela Conversions API. Para Formulários Instantâneos, preserva o `leadgen_id` original para correspondência.

## Segurança

- Nunca registre ou versione `.env`, tokens, App Secret ou senhas.
- Use somente `ADMIN_PASSWORD_HASH`; `ADMIN_PASSWORD` em texto puro não é aceito.
- Use HTTPS e `COOKIE_SECURE=true` em produção.
- Restrinja o acesso ao painel e monitore `/health` e os logs do worker.
- Faça backup do PostgreSQL antes de qualquer manutenção operacional.
- Em produção, app e worker não executam migration na inicialização; o deploy
  usa o comando único `npm run migrate` antes de atualizar os serviços.
