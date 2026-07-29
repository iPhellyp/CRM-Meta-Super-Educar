# Operações administrativas

## Importações

A tela `/operations` separa duas origens:

- **Meta**: usa somente conexões, páginas e formulários ativos e validados. O
  envio exige ao menos um formulário; período inicial e final são opcionais.
- **Arquivo**: recebe CSV, XLSX ou XLS e sempre gera uma prévia antes de
  qualquer alteração. Limites e validações permanecem documentados em
  `spreadsheet-import.md`.

O histórico usa estados textuais, contagens e progresso. Retomar, cancelar ou
confirmar só aparece quando o backend já permite a ação.

## Eventos WhatsApp e reconciliação WA2

O resumo do cursor destaca processados, pendentes e conflitos. Eventos
ignorados são informação secundária; o último erro só ocupa destaque quando
existe.

Reconciliações exibem instância, estado, progresso, duração e resultados
agrupados. Falhas elegíveis podem ser **enfileiradas novamente** com confirmação;
isso não significa processamento imediato e não apaga tentativas anteriores.

## Datas e detalhes técnicos

Datas administrativas são apresentadas em português no fuso
`America/Sao_Paulo`, sem alterar o instante persistido. IDs, cursor e outros
dados de diagnóstico ficam em disclosures de detalhes técnicos.

## Segurança operacional

- Rotas continuam autenticadas, isoladas por tenant e protegidas por CSRF.
- A interface não habilita ações proibidas, e o servidor continua sendo a
  autoridade final.
- Erros apresentados são os valores já sanitizados pelo backend.
- QR WA2 usa `Cache-Control: private, no-store, max-age=0` tanto na página
  quanto na imagem e fica fora da allowlist do service worker.
- Tokens e segredos Meta/WA2 nunca são retornados nas views.

## PWA

O shell instalável armazena somente CSS, JavaScript, manifest, ícones e a página
offline pública. Navegações autenticadas sempre consultam a rede e nunca são
gravadas na Cache API. Logout remove os caches com prefixo próprio e o servidor
também envia `Clear-Site-Data` restrito à origem.

## Recuperação operacional

- `FAILED`: a interface oferece enfileirar novamente somente quando o backend
  ainda permite tentativas.
- `PARTIAL`: a reconciliação oferece reenfileirar apenas itens com falha.
- `PROCESSING` ou `RUNNING`: nenhuma ação duplicada é apresentada.
- Upload ou preview com erro: o arquivo é descartado e deve ser selecionado de
  novo.
- QR expirado: atualize o estado e solicite um novo QR; nenhum QR anterior é
  armazenado.

Retries preservam histórico e contador de tentativas. O servidor continua sendo
a autoridade de tenant, status e permissão.
