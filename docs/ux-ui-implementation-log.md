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
