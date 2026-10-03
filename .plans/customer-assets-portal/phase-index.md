# Índice ejecutable · customer-assets-portal

Goal: [G-001](goal.md). [Contexto](context.md), [requisitos](requirements.md), [contratos](contracts.md), [decisiones](decisions.json), [runbook](orchestration/runbook.md).

| Fase | Resultado independiente | Dependencies / gates | Estado |
|---|---|---|---|
| P-001 | [Auth y credenciales demostradas en D1/Workers](phases/01-auth-d1-workers-proof.md) | G-cap-implement + G-cap-local | pending |
| P-002 | [Backend privado de clientes, materiales y entregas](phases/02-private-client-materials-and-deliveries.md) | P-001 | pending |
| P-003 | [CLI conecta materiales y outputs con Studio sin duplicación](phases/03-agent-cli-studio-bridge.md) | P-002 | pending |
| P-004 | [Dashboard admin/cliente y simulación de Instagram](phases/04-admin-client-and-instagram-dashboard.md) | P-003 | pending |
| P-005 | [Flujo completo offline y preparación de operación](phases/05-offline-end-to-end-and-operations-readiness.md) | P-004 | pending |
| P-006 | [Piloto HTTPS autorizado en customers-assets.theelena.me](phases/06-authorized-cloudflare-domain-pilot.md) | P-005 + G-cap-live | pending |

```text
G-cap-implement + G-cap-local → P-001 → P-002 → P-003 → P-004 → P-005 → P-006
G-cap-live ----------------------------------------------------------→ P-006
```

Seis goal units: el sexto separa despliegue/piloto de validación offline para no confundir permisos ni evidencia. Orden serial conservador, un mutable worker. No paralelizar registry/SDK/lockfile/contratos sin integration owner. Una fase corresponde a una task del DAG T-CAP-001..006.

Estado inicial de todos los goals/phases pending; el plan no se ha sembrado en climier, no hay session/worker nuevo. Frontmatter refleja avance de ejecución, climier registra claims/gates/submit/accept; sincronizarlos sin inventar progreso.
