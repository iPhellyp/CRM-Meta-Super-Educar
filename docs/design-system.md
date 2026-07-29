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
