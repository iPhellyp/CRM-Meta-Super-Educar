# Importação segura de leads por arquivo

## Formatos e limites

- CSV UTF-8, XLSX ou XLS.
- Um arquivo por requisição, somente em memória.
- Máximo de 5 MB, 2.000 linhas de dados e 50 colunas.
- Arquivos vazios, criptografados, com assinatura incompatível, macros, fórmulas,
  hyperlinks ou vínculos externos são recusados.
- Se houver mais de uma planilha com dados, o operador escolhe a planilha e envia
  o arquivo novamente. O primeiro buffer já terá sido descartado.

## Cabeçalhos

Os cabeçalhos reconhecidos são `id`, `created_time`, `ad_id`, `ad_name`,
`adset_id`, `adset_name`, `campaign_id`, `campaign_name`, `form_id`,
`form_name`, `is_organic`, `platform`, `Nome`, `WhatsApp` e `lead_status`.
Normalização remove BOM, aplica Unicode NFKC, trim e comparação sem diferença de
maiúsculas. `id` e `Nome` são obrigatórios.

IDs são aceitos somente como texto. Isso preserva zeros à esquerda e impede
aplicar valores numéricos do Excel que já possam ter perdido precisão. Notação
científica, espaços, caracteres invisíveis e fórmulas em IDs são inválidos.

`lead_status` é preservado apenas em `raw_meta`; ele nunca decide a etapa do CRM.

## Datas e telefones

`created_time` aceita `M/D/YY`, `M/D/YYYY`, ISO 8601, data nativa do Excel e
serial do Excel. Datas inválidas não recebem fallback. A interface usa o fuso
`America/Sao_Paulo` por meio da formatação já adotada pelo CRM.

O WhatsApp usa o classificador brasileiro existente. Telefone vazio, inválido ou
LID não resolvido torna a linha inválida.

## Prévia e confirmação

A prévia persiste somente dados normalizados, decisão, erros, hash e metadados;
o binário nunca é salvo. As decisões são:

- `NEW`: ID Meta não existe e o telefone não aponta para outro lead.
- `UPDATE`: o mesmo ID Meta já existe no tenant.
- `POSSIBLE_DUPLICATE`: ID Meta diferente, mas o telefone pertence a outro lead.
- `INVALID`: a linha falhou em uma ou mais validações.

A prévia não cria lead nem muda etapa. A confirmação relê os itens do banco,
mantém o tenant do servidor, bloqueia a importação com `FOR UPDATE` e aplica
somente `NEW` e `UPDATE` dentro de uma transação. Atualizações por ID Meta
preservam a etapa existente. Duplicidades possíveis e inválidos são ignorados.
Uma segunda confirmação devolve o mesmo resultado concluído sem reaplicar itens.

## Segurança operacional

A rota multipart é autenticada e restrita ao endpoint de prévia. O parsing do
multipart ocorre antes da validação CSRF somente nessa rota, para disponibilizar
o campo `_csrf`; `requireCsrf` continua obrigatório. O nome do arquivo é
sanitizado e nunca é usado como caminho. Erros enviados ao navegador não incluem
stack, caminho local, SQL ou conteúdo do arquivo.
