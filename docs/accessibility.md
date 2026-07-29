# Acessibilidade do CRM

## Navegação

- O link “Ir para o conteúdo principal” antecede o cabeçalho.
- A navegação principal possui nome acessível e agrupamentos com headings.
- Até 1099px, o menu abre como drawer, prende o foco, fecha por Escape,
  backdrop, botão ou navegação e devolve o foco ao acionador.
- Enquanto aberto, o conteúdo principal usa `inert` e o scroll do documento é
  bloqueado. Em desktop, o mesmo conteúdo permanece como navegação normal.

## Leads e filtros

- A busca rápida usa landmark `search` e permanece visível.
- Filtros avançados usam `dialog`, rótulos explícitos, Escape e retorno de foco.
- O resumo textual informa filtros ativos; cor não é a única indicação.
- Até 1023px, leads são apresentados em cards sem rolagem horizontal.
- A partir de 1024px, a tabela possui seis colunas operacionais e detalhes
  técnicos ficam em disclosure.
- Cards e tabela reutilizam os mesmos helpers, endpoints, CSRF e atributos do
  fluxo de WhatsApp.

## Teclado e foco

- Controles têm no mínimo 44px, chegando a 48px no celular.
- `:focus-visible` tem contorno de 3px e offset.
- Menus de ações fecham com Escape e devolvem foco ao `summary`.
- O diálogo de perda e os filtros devolvem foco ao acionador.
- A ordem do DOM acompanha a ordem visual.

## Conteúdo e estados

- SVG decorativo usa `aria-hidden` e `focusable="false"`.
- Feedback contextual usa `role="status"` ou `role="alert"`.
- Badges sempre incluem texto.
- Campos ausentes são descritos como “Sem telefone”, “Não informado” ou
  equivalente; não dependem apenas de um traço.
- Nomes, cursos, cidades, IDs e metadados usam quebra segura de linha.

## Verificação

Os testes de views inspecionam landmarks, headings, rótulos, CSRF, escape XSS,
cards, tabela, drawers e paginação. O CSS declara breakpoints para 360–767px,
768–1023px, 1024px e 1440px+, além de movimento reduzido e zoom de 200%.

## Integrações e monitoramento

- Operações em lote expõem contagem textual junto ao `progressbar`.
- Seleções Meta usam fieldset, legend e feedback com `role="status"`.
- Tabelas de eventos, jobs, conexões e instâncias ganham cards até 767px.
- Status nunca depende apenas de cor; falhas usam texto e alerta.
- IDs e cursores ficam em `details`, acessíveis por teclado.
- Confirmações usam o diálogo nativo do navegador e preservam a proteção CSRF.

## Matriz final

Foram inspecionados os layouts em 360×800, 390×844, 768×1024, 1024×768,
1366×768 e 1920×1080. Dashboard e operações ficaram sem overflow horizontal:
cards são usados até 1023px e a tabela compacta aparece a partir de 1024px.
Também foi verificado o layout ampliado a 200%.

Os contrastes principais calculados variam de 5,85:1 a 16,65:1, incluindo texto
secundário, foco, erro e aviso sobre suas superfícies. A suíte cobre semântica,
landmarks, labels, estados, foco, Escape, focus trap, retorno de foco, toque,
movimento reduzido, XSS e textos longos.

Antes de cada deploy relevante, mantenha um smoke test manual com teclado e
NVDA/VoiceOver no navegador-alvo. A suíte automatizada valida o contrato
semântico, mas não substitui a audição real do leitor de tela.
