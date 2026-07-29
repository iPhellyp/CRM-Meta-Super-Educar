# Design System — CRM Meta Super Educar

## Estrutura

O CSS usa a ordem fixa:

`tokens → base → layout → components → utilities → responsive → accessibility`.

Novos estilos devem entrar na camada de menor responsabilidade possível. Componentes não devem redefinir tokens globais.

## Tokens

- Cores: `--color-brand`, superfícies, bordas, textos e pares semânticos de sucesso, atenção, erro e informação.
- Integrações: `--color-whatsapp`, `--color-meta` e `--color-wa2`.
- Funil e jobs: prefixos `--stage-` e `--job-`.
- Tipografia: prefixos `--font-`, sem fonte externa.
- Espaçamento: `--space-1` a `--space-16`, escala de 4 a 64px.
- Forma: `--radius-sm`, `--radius-md`, `--radius-lg` e `--radius-full`.
- Elevação: `--shadow-sm`, `--shadow-md` e `--shadow-modal`.
- Interação: `--control-height`, `--control-height-mobile`, `--touch-target`, `--focus-ring` e durações.
- Camadas: `--z-header`, `--z-drawer`, `--z-menu`, `--z-dialog` e `--z-toast`.
- Breakpoints documentados: 480, 768, 1024 e 1440px. Custom properties não são usadas dentro das condições de media query.

## Componentes

### Botões e links de ação

Use `button`, `.button-link` ou `.action-button`. A ação principal usa a marca; ações neutras usam `.secondary`; sucesso usa `.success`; ações destrutivas usam `.danger`.

Cor nunca deve ser o único indicador: mantenha texto explícito e, quando útil, SVG com `aria-hidden="true"`.

### Campos

Todo `input`, `select` ou `textarea` precisa permanecer associado a um `label`. Placeholder é apenas ajuda complementar.

### Painéis, cards e indicadores

Use `.panel` para seções, `.card` para unidades repetíveis e `.stat` para números. Não aninhe painéis apenas para obter sombra.

### Alertas e status

- `.alert.success`: operação concluída;
- `.alert.warning`: atenção necessária;
- `.alert.error`: falha;
- `.alert.info`: orientação.

Mensagens dinâmicas devem usar `role="status"` ou `role="alert"`.

### Badges

Badges exibem texto de estado e podem usar classes do funil. Nunca mostre apenas um ponto colorido sem rótulo.

### Menus e disclosures

Use `details` e `summary` para progressive enhancement. O conteúdo continua disponível sem JavaScript. Escape e retorno de foco são adicionados pelo script da aplicação.

O menu global usa navegação agrupada em desktop e drawer até 1099px. Filtros
avançados usam `dialog`: busca rápida e filtros já aplicados continuam visíveis
fora do drawer.

### Leads responsivos

- 320–767px: cards em uma coluna.
- 768–1023px: cards em duas colunas.
- 1024px+: tabela operacional compacta com seis colunas.
- 1440px+: indicadores prioritários podem ocupar oito colunas.

Detalhes Meta/WA2 extensos ficam em “Detalhes da origem”. Tabela e cards chamam
os mesmos helpers de ações; não existe segundo fluxo JavaScript de WhatsApp.

### Modal

Use o elemento `dialog`, nomeado por `aria-labelledby` e descrito por `aria-describedby`. O acionador deve recuperar foco ao fechar.

### Loading, disabled, empty e skeleton

- `.loading` comunica operação em andamento junto de texto atualizado;
- `disabled` é usado somente quando a ação realmente não está disponível;
- `.empty` deve explicar o estado e a próxima ação possível;
- `.skeleton` é apenas visual e deve ser ocultado de tecnologia assistiva.

## Acessibilidade

- Área interativa mínima de 44px; 48px no breakpoint móvel atual.
- Foco visível azul com contraste sobre superfícies claras e escuras.
- Conteúdo funcional em zoom de 200%.
- Movimento reduzido respeitado.
- SVG decorativo usa `currentColor`, `aria-hidden="true"` e `focusable="false"`.
- O link “Ir para o conteúdo principal” é o primeiro controle focável.
- Drawers usam focus trap, Escape, `inert` no fundo e retorno de foco.

## Convenções

- Nomes de componente descrevem função, não cor.
- Variações semânticas usam `success`, `warning`, `error` ou `info`.
- JavaScript usa atributos `data-*`; CSS usa classes.
- Não use `innerHTML` com conteúdo externo.

## Exemplo

```html
<section class="panel" aria-labelledby="section-title">
  <h2 id="section-title">Título</h2>
  <p class="alert info" role="status">Orientação objetiva.</p>
  <button type="button">Ação principal</button>
</section>
```

Evite estilos inline, ícones por caractere, botão sem nome acessível e placeholder como único rótulo.

## Operações administrativas

- `.operation-source` diferencia a origem Meta da origem por arquivo.
- `.operation-card` reúne status, progresso, métricas e ações permitidas.
- `.operation-progress` combina contagem textual e `role="progressbar"`.
- `.admin-card-list` substitui tabelas administrativas no celular.
- `.technical-details` recolhe IDs, cursores e metadados de diagnóstico.
- Retry deve ser nomeado como “Enfileirar novamente” e solicitar confirmação.

Datas visíveis usam pt-BR e `America/Sao_Paulo`. Badges sempre carregam o texto
do estado; cor é apenas reforço.

## Budgets verificados

Na revisão final:

- CSS: 32.432 bytes;
- JavaScript do navegador: 16.609 bytes;
- service worker: 1.718 bytes;
- dashboard server-side com 100 leads: 1.188.218 bytes antes da compressão.

Os limites automatizados são 100 KiB para CSS, 100 KiB para JavaScript, 20 KiB
para o service worker e 2,5 MiB para o HTML de 100 leads. A resposta HTTP passa
por compressão. SheetJS permanece exclusivamente no servidor.
