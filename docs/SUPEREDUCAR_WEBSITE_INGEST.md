# API de leads do site Super Educar

## Objetivo

Esta API recebe, por HTTPS servidor-servidor, cadastros confirmados pelo
backend do site `supereducar.com`. O CRM não acessa o banco, painel ou domínio
físico do site: qualquer servidor autorizado pode chamar o receptor quando
possuir a credencial HMAC correta.

A integração usa a identidade lógica `supereducar-website`, com
`external_system=SUPEREDUCAR_WEBSITE` e `source=WEBSITE_FORM`. O tenant vem
somente da configuração do servidor CRM; `tenant_id` enviado pelo remetente é
rejeitado como campo desconhecido.

Rota:

```text
POST /api/integrations/supereducar/website-leads
Content-Type: application/json
```

A feature permanece desativada por padrão:

```text
SUPEREDUCAR_WEBSITE_INGEST_ENABLED=false
SUPEREDUCAR_WEBSITE_INGEST_HMAC_SECRET=<segredo server-side com pelo menos 32 bytes>
SUPEREDUCAR_WEBSITE_INGEST_TENANT_ID=super-educar
SUPEREDUCAR_WEBSITE_INGEST_CLOCK_SKEW_SECONDS=300
```

Quando desativada, a API retorna `503 WEBSITE_INGEST_DISABLED` antes de
validar o conteúdo ou consultar/persistir dados comerciais.

## Fontes Meta separadas

Estas referências são apenas documentais; não são lidas pelo receptor, não
são hardcoded na lógica de ingestão e não ativam nenhum envio:

| Fonte | ID | Uso |
| --- | --- | --- |
| Super Educar - Site Web - 2026 | `1414255997275699` | PageView, Lead do site, Pixel Web e futura CAPI Web |
| CRM Super Educar - Qualificados Limpos - 2026-08-03 | `1059632093187676` | Marketing Qualified Lead, CRM02/03/04 e eventos comerciais posteriores |
| Fonte legada | `775516968145969` | NENHUM; bloqueada |

Nesta implementação nenhum evento é enviado à fonte Web, à fonte CRM ou à
fonte legada. O receptor não recebe Pixel ID, token Meta ou token CAPI.

## Autenticação HMAC

Headers obrigatórios:

```text
X-SE-Integration: supereducar-website
X-SE-Timestamp: <UNIX_SECONDS>
X-SE-Nonce: <nonce novo para cada tentativa>
X-SE-Signature: sha256=<hexadecimal da assinatura>
Idempotency-Key: supereducar:<external_lead_id>
```

A assinatura usa o corpo JSON bruto, exatamente como foi transmitido:

```text
<TIMESTAMP>\n<NONCE>\n<RAW_JSON_BODY>
```

```text
HMAC-SHA256(secret, canonical_string)
```

O CRM rejeita timestamp fora da janela configurada, assinatura inválida,
integração diferente, nonce ausente ou nonce reutilizado. O nonce é persistido
somente como SHA-256, vinculado ao tenant e à integração, com expiração. O
segredo nunca deve ser enviado ao navegador, colocado na URL ou compartilhado
com Meta, banco, login ou cookies.

O limite do corpo é 32 KB. O rate limit desta integração é de 60 requisições
por minuto e não compartilha contador com login, Meta, Lead Retrieval ou WA2.
O contador é em memória por processo e usa somente a identidade da integração;
em múltiplas réplicas, cada réplica terá sua própria janela. Uma release com
múltiplas réplicas deve mover esse contador para um armazenamento compartilhado;
a autenticação HMAC continua obrigatória independentemente disso.

## Payload

Payload mínimo:

```json
{
  "external_lead_id": "12345",
  "interest": "Medicina Veterinária",
  "phone": "5538999999999",
  "submitted_at": "2026-08-06T16:50:00-03:00"
}
```

Também podem ser enviados `website_submission_id` (UUID), `course_id`,
`course_name`, `modality`, `name`, `email`, dados de atribuição permitidos,
URLs HTTP/HTTPS e `consent_at`. Objetos, arrays, campos desconhecidos, URLs
não HTTP(S), textos excessivos, e-mail inválido, telefone inválido ou data
inválida são rejeitados.

Não são aceitos campos que alterem o funil ou roteamento, incluindo `tenant_id`,
`source`, `stage`, `dataset_id`, `event_name`, `mql_status` e
`payment_status`.

O telefone é normalizado com o helper atual do CRM. O telefone não é chave de
idempotência nem causa merge com outro lead. Se o nome não vier, o modelo
atual, que exige `leads.name`, recebe o placeholder técnico `Sem nome — site`.
O histórico e a submission registram `name_is_placeholder=true` e
`name_source=TECHNICAL_PLACEHOLDER`; isso não representa nome confirmado da
pessoa. Quando o site envia um nome, ele é preservado com
`name_is_placeholder=false` e `name_source=USER_PROVIDED`.

## Persistência e idempotência

A migration aditiva `022_website_lead_ingest.sql` cria:

- `website_lead_submissions`, com tenant, sistema externo, IDs do site,
  `website_event_id`, hash do payload, dados comerciais permitidos e o lead
  criado;
- `website_lead_ingest_nonces`, com hash do nonce e expiração.

O hash é calculado sobre campos normalizados e ordenados: IDs, interesse,
curso, modalidade, nome, e-mail, telefone normalizado, `submitted_at` em UTC e
atribuição permitida. Assim, ordem das chaves, whitespace externo e string
vazia versus `null` não causam conflito.

IDs de evento:

```text
website_submission_id presente:
web:lead:<website_submission_id>

website_submission_id ausente:
web:lead:supereducar:<external_lead_id>
```

Respostas:

```text
201 CREATED
200 IDEMPOTENT_REPLAY
409 EXTERNAL_ID_CONFLICT ou NONCE_REPLAY
401 autenticação inválida
413 corpo excedente
415 Content-Type incorreto
422 payload inválido
429 rate limit
503 feature desativada ou não configurada
500 INTERNAL_ERROR com request_id
```

Cada submissão nova cria, numa transação, exatamente uma submission e um lead
`WEBSITE_FORM` em `NEW`, além do histórico de recebimento. Não cria job, MQL,
evento Meta, vínculo WhatsApp, identidade WA2, alteração de stage por etiqueta
ou alteração de outro lead. Concorrência é serializada por tenant e IDs
externos; constraints únicas permanecem como segunda barreira.

`Idempotency-Key` é obrigatória e deve ser exatamente
`supereducar:<external_lead_id>` após a normalização. Uma chave ausente,
duplicada, malformada, excessiva ou referente a outro ID retorna
`422 INVALID_IDEMPOTENCY_KEY`.

Os nonces expirados são removidos oportunisticamente, no máximo 100 por
transação aceita, usando o índice de expiração e sem cron ou limpeza massiva.
Uma unidade futura poderá criar uma rotina de retenção adicional se a carga
exigir.

## Fluxo futuro do site e Pixel

1. O visitante envia o formulário.
2. O sistema de origem valida o cadastro.
3. O sistema gera ou preserva `external_lead_id` e
   `website_submission_id`.
4. O cadastro é salvo no sistema de origem.
5. Após confirmação do salvamento, o Pixel Web pode disparar `Lead`.
6. O backend autorizado envia o mesmo cadastro ao CRM.
7. Falhas do CRM ficam pendentes no sistema de origem e são repetidas com os
   mesmos IDs.

O Pixel Web e eventual CAPI Web futura usarão uma fonte Meta própria e
`event_name=Lead`, com `event_id=website_event_id`. Eles são separados da
fonte CRM de qualificação (`Marketing Qualified Lead`) e do dataset legado.
Esta unidade não configura Pixel, não exige Pixel ID, não envia CAPI e não
envia evento Meta.

## Exemplo PHP server-side

O exemplo abaixo usa somente variáveis de ambiente do servidor e não deve ser
executado no navegador:

```php
<?php
$externalLeadId = trim((string) $externalLeadId);
$payload = [
    'external_lead_id' => (string) $externalLeadId,
    'interest' => (string) $interest,
    'phone' => (string) $phone,
    'submitted_at' => $submittedAt->format(DateTimeInterface::ATOM),
];
if (isset($websiteSubmissionId) && $websiteSubmissionId !== '') {
    $payload['website_submission_id'] = (string) $websiteSubmissionId;
}

$rawJson = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
$timestamp = (string) time();
$nonce = bin2hex(random_bytes(24));
$secret = getenv('SUPEREDUCAR_WEBSITE_INGEST_HMAC_SECRET');
$canonical = $timestamp . "\n" . $nonce . "\n" . $rawJson;
$signature = 'sha256=' . hash_hmac('sha256', $canonical, $secret);

$endpoint = getenv('SUPEREDUCAR_WEBSITE_CRM_ENDPOINT');
if (!$endpoint) {
    throw new RuntimeException('Endpoint do CRM ainda não foi configurado após o deploy.');
}
$request = curl_init($endpoint);
curl_setopt_array($request, [
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => $rawJson,
    CURLOPT_HTTPHEADER => [
        'Content-Type: application/json',
        'X-SE-Integration: supereducar-website',
        'X-SE-Timestamp: ' . $timestamp,
        'X-SE-Nonce: ' . $nonce,
        'X-SE-Signature: ' . $signature,
        'Idempotency-Key: supereducar:' . $payload['external_lead_id'],
    ],
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 10,
    CURLOPT_SSL_VERIFYPEER => true,
    CURLOPT_SSL_VERIFYHOST => 2,
]);
$responseBody = curl_exec($request);
$httpStatus = curl_getinfo($request, CURLINFO_HTTP_CODE);
curl_close($request);

if ($httpStatus === 201 || $httpStatus === 200) {
    // Marcar a sincronização como concluída preservando os mesmos IDs.
} elseif ($httpStatus === 409) {
    // Revisar EXTERNAL_ID_CONFLICT; não gerar outro ID.
} elseif ($httpStatus === 422) {
    // Corrigir o contrato antes de repetir.
} elseif ($httpStatus === 429) {
    // Repetir após Retry-After, usando os mesmos IDs e um nonce novo.
} elseif ($httpStatus >= 500 || $httpStatus === 0) {
    // Repetir com backoff, os mesmos IDs e um nonce novo; não gerar outro lead.
}
```

Nunca registrar `rawJson`, assinatura, telefone/e-mail completos ou segredo.
O endpoint definitivo, o segredo e a ativação da feature serão entregues
somente após o deploy aprovado; não colocar o segredo no navegador nem
desativar a validação TLS.
