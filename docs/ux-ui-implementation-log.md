# Registro de implementação UX/UI

## Fase 1A

- Fluxo progressivo do WhatsApp com fallback HTML preservado.
- Hierarquia de ações do lead simplificada.
- SVGs inline com allowlist.
- Feedback contextual, prevenção de duplo envio e diálogo acessível.
- Checkpoint local: `1a93d41`.

## Fase 1B

- CSS organizado em camadas.
- Tokens completos de cor, tipografia, espaço, elevação, foco e z-index.
- Componentes existentes padronizados sem mudança de regra comercial.
- Link para pular navegação e nome acessível da navegação principal.
- Documentação criada em `docs/design-system.md`.

## Fase 2A

- Importação via Graph renomeada para **Importar diretamente da Meta**.
- Novo fluxo **Importar arquivo de leads** para CSV, XLSX e XLS.
- Upload autenticado, CSRF obrigatório, memória limitada e descarte do buffer.
- Prévia sem escrita em leads, com hash, contagens, amostra e classificação.
- Confirmação transacional e idempotente, preservando etapa e isolamento tenant.
- Migration aditiva `007_lead_file_imports.sql`.
- Regras operacionais documentadas em `docs/spreadsheet-import.md`.

## Fase 2B

- Tabela de leads reduzida a seis colunas operacionais.
- Cards responsivos entre 320px e 1023px, reutilizando o fluxo WhatsApp da 1A.
- Metadados Meta e WA2 movidos para “Detalhes da origem”.
- Busca rápida sempre visível e filtros avançados em drawer com resumo ativo.
- Paginação e ações comerciais preservam filtros validados.
- Navegação agrupada com drawer, focus trap, Escape, `inert` e retorno de foco.
- Indicadores reorganizados por prioridade comercial.
- Novo lead e mensagem inicial movidos para painéis recolhíveis.
- Critérios registrados em `docs/accessibility.md`.

# Fase 3 — Integrações, operações e monitoramento

- Separadas importações diretas da Meta e por arquivo.
- Formulários Meta convertidos em checklist com prevenção de envio vazio.
- Histórico, eventos WhatsApp e reconciliações reorganizados em cards,
  métricas, progresso e detalhes técnicos progressivos.
- Eventos Meta, jobs, conexões e instâncias recebem representação mobile sem
  rolagem horizontal operacional.
- Datas padronizadas em pt-BR no fuso de São Paulo.
- Retries renomeados para enfileiramento e condicionados aos estados elegíveis.
- QR WA2 mantido com `no-store`; nenhuma credencial passou a ser exibida.

# Fase 4 — PWA segura

- Adicionados manifest, ícones vetoriais, shell instalável e página offline.
- Cache limitado por allowlist a assets públicos versionados.
- Navegações e respostas dinâmicas mantidas em rede e com `no-store`.
- Atualização exige ação explícita e protege formulários alterados.
- Logout remove caches próprios e dados temporários da origem.
- Estados de conexão e instrução específica para iPhone adicionados.
