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
