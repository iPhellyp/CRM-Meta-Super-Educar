# PWA segura

## Instalação

Em navegadores compatíveis, o CRM mostra um aviso discreto quando
`beforeinstallprompt` está disponível. A pessoa pode instalar ou dispensar; a
dispensa é lembrada apenas durante a sessão. No Safari do iPhone, a interface
orienta usar **Compartilhar → Adicionar à Tela de Início**.

O manifest usa `start_url` e `scope` na raiz, modo `standalone`, orientação
flexível, idioma pt-BR e ícones públicos sem dados privados.

## Política de cache

O cache `crm-meta-public-*` contém exclusivamente:

- CSS e JavaScript com versão;
- manifest;
- ícones;
- página offline genérica.

HTML autenticado, leads, eventos, Meta, WA2, jobs, operações, importações,
previews, JSON privado, uploads, QR, login, logout e qualquer método diferente
de GET nunca entram na Cache API. Navegações usam rede e recebem a página
genérica somente quando a conexão falha.

Todas as respostas dinâmicas recebem:

```text
Cache-Control: private, no-store, max-age=0
Pragma: no-cache
Expires: 0
```

## Offline e atualização

A página offline não contém usuário, lead, telefone, campanha, histórico, QR ou
conteúdo visto anteriormente. Ela apenas explica que a conexão é necessária e
oferece nova tentativa.

O service worker não chama `skipWaiting` ou `clients.claim` automaticamente.
Quando existe uma atualização, a interface avisa e espera a pessoa solicitar a
recarga. Se houver formulário alterado, uma confirmação evita descarte
acidental.

## Logout

Antes do envio do logout, o cliente remove somente caches com o prefixo do CRM e
a preferência temporária de instalação. O servidor expira a sessão e envia
`Clear-Site-Data: "cache", "storage"` para a origem. Nenhum cache de outro site é
afetado.

## Verificação

```powershell
node --test test/pwa.test.js
npm run check
npm test
```
