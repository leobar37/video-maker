# Índice ejecutable · customer-assets-portal

Goal: [G-001](goal.md). [Contexto](context.md), [requisitos](requirements.md), [contratos](contracts.md), [decisiones](decisions.json), [runbook](orchestration/runbook.md).

| Fase | Resultado independiente | Dependencies / gates | Estado |
|---|---|---|---|
| P-001 | [Auth y credenciales demostradas en D1/Workers](phases/01-auth-d1-workers-proof.md) | G-cap-implement + G-cap-local | accepted |
| P-002 | [Backend privado de clientes, materiales y entregas](phases/02-private-client-materials-and-deliveries.md) | P-001 | accepted |
| P-003 | [CLI conecta materiales y outputs con Studio sin duplicación](phases/03-agent-cli-studio-bridge.md) | P-002 | accepted |
| P-004 | [Dashboard admin/cliente y simulación de Instagram](phases/04-admin-client-and-instagram-dashboard.md) | P-003 | accepted |
| P-005 | [Flujo completo offline y preparación de operación](phases/05-offline-end-to-end-and-operations-readiness.md) | P-004 | accepted |
| P-006 | [Piloto HTTPS autorizado en customers-assets.theelena.me](phases/06-authorized-cloudflare-domain-pilot.md) | P-005 + G-cap-live | accepted |

```text
G-cap-implement + G-cap-local → P-001 → P-002 → P-003 → P-004 → P-005 → P-006
G-cap-live ----------------------------------------------------------→ P-006
```

Seis goal units: el sexto separa despliegue/piloto de validación offline para no confundir permisos ni evidencia. Orden serial conservador, un mutable worker. No paralelizar registry/SDK/lockfile/contratos sin integration owner. Una fase corresponde a una task del DAG T-CAP-001..006.

Ejecución COMPLETADA 2026-10-05: seis fases accepted tras reproducción del coordinator; G-001 completed. Verificación final reproducida: portal:verify (10 etapas/135 aserciones), studio:verify (275/275), build raíz y app exit 0, portal:verify:live (14 etapas/122 aserciones, HTTPS customers-assets.theelena.me, emails=0). Excepción documentada por decisión del operador (leobar37): entrega de email real diferida — login del piloto vía magic link copiado (captura wrangler tail, single-use, PORTAL_LIVE_SMOKE=1); evidencia live.json marca emailDelivery deferred-by-operator.
