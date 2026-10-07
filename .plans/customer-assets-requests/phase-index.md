# Índice ejecutable · customer-assets-requests

Goal: [R-001 / G-002](goal.md). [Contexto](context.md), [requisitos](requirements.md), [contratos aditivos](contracts.md), [decisiones](decisions.json).

| Fase | Resultado independiente | Dependencies / gates | Estado |
|---|---|---|---|
| R-1 (P-101) | [Proyección PortalProject, pestaña admin y material con proyecto](phases/R-1.md) | Aprobación vigente offline (2026-10-04) | accepted |
| R-2 (P-102) | [Upload requests con enlace de invitado, móvil y cuotas](phases/R-2.md) | R-1 | accepted |
| R-3 (P-103) | [CLI portal-request-pull, cierre/expiración y auditoría](phases/R-3.md) | R-2 | accepted |

```text
G-cap-implement + G-cap-local (aprobación vigente del operador 2026-10-04, precedente G-001) → R-1 → R-2 → R-3
G-cap-live (ABIERTO) ------------------------------------------------------------------→ cualquier uso live: deploy, links reales, invitado real
```

Ejecución offline COMPLETADA 2026-10-05: R-1..R-3 accepted tras reproducción del coordinator (CLI 112/112; worker 120/120; ui 27/27; e2e OK; portal:verify 11 etapas/198 aserciones con sonda de sabotaje exit 1 solo-07). Contrato §6 alineado: portal-request-create/list usan `--project <portalProjectId>` (los agentes no resuelven studioProjectId porque §3 veta listar proyectos; cross-check post-creación). LIVE PENDIENTE: deploy de R-features + migraciones 0003/0004 a prod + links reales requieren aprobación explícita del operador (el nodo G-cap-live resuelto cubrió solo el piloto del portal v1).

Tres goal units seriales, un mutable worker `zai/glm-5.3-flash:high` (asignación explícita, sin heredar default). Una fase corresponde a una task del DAG T-REQ-001..003. Los gates offline de esta iniciativa reutilizan la semántica de G-001 y están cubiertos por las aprobaciones vigentes del operador del 2026-10-04 (mismo app, mismos scripts, sin infra nueva): R-1..R-3 pueden ejecutarse offline. `G-cap-live` permanece ABIERTO: el feature no se despliega, no mintea links reales ni prueba invitados reales sin aprobación humana explícita con inventario y límites; el goal offline-completo se reporta como hito, no como live publicado.
