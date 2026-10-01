# Índice ejecutable · creative-workspace

Goal: [G-001](goal.md). Contrato normativo: [contracts.md](contracts.md). Alcance: [requirements.md](requirements.md). Operación: [orchestration/runbook.md](orchestration/runbook.md). Todos los estados iniciales pending, no implementación iniciada.

| Fase | Modelo obligatorio | Depende de | Unidad |
|---|---|---|---|
| P-001 | `zai/glm-5.3:high` | G-cw-implement | [Dominio, schemas y contrato portable](phases/01-studio-domain-contracts.md) |
| P-002 | `zai/glm-5.3:high` | P-001 | [Assets abiertos y revisiones locales recuperables](phases/02-open-assets-local-revisions.md) |
| P-003 | `zai/glm-5.3-flash:high` | P-002 | [CLI declarativa y recipe explícita opcional](phases/03-cli-open-workspace-commands.md) |
| P-004 | `zai/glm-5.3:high` | P-003 | [R2 completo, commit inmutable y recuperación remota](phases/04-r2-manifest-sync-recovery.md) |
| P-005 | `zai/glm-5.3-flash:high` | P-003, P-004 | [Un dashboard read-only por catálogo y URLs](phases/05-one-catalog-dashboard.md) |
| P-006 | `zai/glm-5.3:high` | P-005 | [Adopción no destructiva y prueba end-to-end real](phases/06-adoption-end-to-end-verification.md) |

```text
G-cw-implement -> P-001 -> P-002 -> P-003 -> P-004 -> P-005 -> P-006
G-cw-live-r2 ---------------------------------------------> P-006
```

Orden conservador serial P-001..P-006, un worker mutable a la vez. R2 depende de CLI porque también integra sus specs; no iniciar la integración antes de congelar el dispatcher. Coordinator controla registry/exports/lockfile y valida personalmente cada acceptance. No realizar R2 live en P-004. P-006 puede preparar offline sin permiso live, pero no se acepta hasta superar gate y prueba real.
