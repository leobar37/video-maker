# Índice ejecutable · serie-sabias-que

Goal: [G-001](./goal.md). Contrato normativo: [contracts.md](./contracts.md). Alcance: [requirements.md](./requirements.md).
Detalle creativo: [series.md](./series.md). Operación: [orchestration/runbook.md](./orchestration/runbook.md).
Todos los estados iniciales `pending`; la implementación no ha comenzado.

| Fase | Tipo | Modelo obligatorio | Depende de | Unidad |
|---|---|---|---|---|
| P-001 | investigation | `xiaomi-token-plan-sgp/mimo-v2.6-pro:high` | `G-start` | [Investigación factual y guiones](./phases/01-research-scripts.md) |
| P-002 | implementation | `xiaomi-token-plan-sgp/mimo-v2.6-flash:high` | P-001 | [Identidad de serie, escenas y motion (Remotion)](./phases/02-series-identity-motion.md) |
| P-003 | implementation | `xiaomi-token-plan-sgp/mimo-v2.6-flash:high` | P-002, `G-ai-spend` | [B-roll generado y portadas](./phases/03-generated-media-covers.md) |
| P-004 | implementation | `xiaomi-token-plan-sgp/mimo-v2.6-flash:high` | P-003 | [Narración TTS continua](./phases/04-narration-tts.md) |
| P-005 | validation | `xiaomi-token-plan-sgp/mimo-v2.6-pro:high` | P-004 | [Render y QA de los seis MP4](./phases/05-render-qa.md) |
| P-006 | integration | `xiaomi-token-plan-sgp/mimo-v2.6-flash:high` | P-005 | [Paquete de publicación y enlace Tailscale](./phases/06-publish-package-link.md) |

```text
G-start ─▶ P-001 ─▶ P-002 ─▶ P-003 ─▶ P-004 ─▶ P-005 ─▶ P-006
                    G-ai-spend ──────┘
```

Orden conservador serial P-001..P-006, **un worker mutable a la vez**. `G-ai-spend` se necesita antes
de P-003; si no está resuelto, P-003/P-004 quedan `blocked` y P-002 sigue siendo válido (motion gratis).
El coordinador controla el verificador, los `video.json` compartidos y la integración de la identidad.

## Modelos por fase (no automático)
El overlay fija roles (`pro`=default/slow/plan/advisor, `flash`=smol/tiny/commit). **No asume** que el
overlay elige fase: el coordinador fija `set_model` con provider `xiaomi-token-plan-sgp` y el modelId
exacto de la tabla antes de cada delegación, y verifica el modelo devuelto/status line.

## Definition of Done
Ver [goal.md](./goal.md) §Definition of Done. Completa solo con las verificaciones observables en verde
y seis tasks `accepted`.
