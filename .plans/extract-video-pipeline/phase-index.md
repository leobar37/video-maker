# Phase Index — extract-video-pipeline

Goal: [goal.md](./goal.md) — `G-001`

| ID | Fase | Tipo | Estado | Depende de | Requisitos |
|---|---|---|---|---|---|
| P-001 | [Fundaciones: workspace, contratos, schemas y credenciales Doppler](./phases/P-001-foundations-core-schemas-credentials.md) | implementation | done | — | FR-001, FR-002, FR-011 |
| P-002 | [Capa de providers: media, storage y publicación con operaciones pagadas](./phases/P-002-providers-media-storage-publication.md) | implementation | done | P-001 | FR-003, FR-004, FR-005, FR-006, FR-012 |
| P-003 | [Motion kit de Remotion con render adapter](./phases/P-003-motion-kit-remotion.md) | implementation | done | P-001 | FR-007, FR-008 |
| P-004 | [CLI de producción con gates derivados del filesystem](./phases/P-004-production-cli-gates.md) | integration | done | P-002, P-003 | FR-008, FR-009, FR-010, FR-012 |
| P-005 | [Validación end-to-end con providers reales](./phases/P-005-end-to-end-validation-live.md) | validation | done | P-004 | FR-003, FR-004, FR-008, FR-011 |

Paralelismo seguro: **P-002 y P-003 pueden ejecutarse en paralelo** (ambas dependen solo de
P-001 y no comparten superficie de archivos: providers vs. motion). P-004 integra ambas.
