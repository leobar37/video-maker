---
id: "P-006"
goal: "G-001"
title: "Adopción no destructiva y prueba end-to-end real"
status: "completed"
phase_type: "integration"
description: "Adopción no destructiva y prueba end-to-end real para cumplir el contrato agente-first."
end_state: "Verificadores offline/live y build pasan con exit 0, restore remoto conserva SHA de dos revisiones imagen/video y capturas de dashboard están registradas."
verification: "bun run studio:verify && bun run studio:verify:r2 && bun run build"
deliverables: ["scripts/studio-verify.ts", "scripts/studio-verify-r2.ts", "demo/studio/", "evidence/creative-workspace/validation.json"]
entry_criteria: "Contrato normativo leído; dependencias aceptadas en climier; G-cw-implement resuelto. G-cw-live-r2 resuelto antes del probe real."
dependencies: ["P-005"]
requirements: ["FR-001", "FR-002", "FR-003", "FR-004", "FR-005", "FR-006", "FR-007", "FR-008", "NFR-001", "NFR-002", "NFR-003", "NFR-004", "NFR-005", "NFR-006", "NFR-007"]
subagent: "task"
model: "zai/glm-5.3:high"
---

# P-006 · Adopción no destructiva y prueba end-to-end real

Modelo obligatorio: `zai/glm-5.3:high`.

## Context y resultado
Probar el objetivo completo, no solo presencia de módulos. GLM coordina; Flash revisa capturas por su capacidad visual. Requiere G-cw-live-r2 resuelto para requests remotos. Si falta permiso, se pueden preparar/verificar partes offline pero la fase y goal quedan blocked, nunca completed.

## Archivos / ownership
scripts/studio-verify.ts y studio-verify-r2.ts + scripts package.json; demo/studio y evidencia redactada. Integración de exports/registry/lockfile de fases previas por coordinador. No modificar originales bfc/, videos/clip ni reparar fallos ajenos.

## Acceptance obligatorio
- Crear scripts named del goal. Offline ejecuta TODOS los tests de nuevas fases + tests legacy de dispatcher/registry/persistencia relevantes; scripts fallan si faltan archivos/suites, assertions o fixtures, no basta “0 tests”. Crear .test.ts bajo rutas declaradas para discovery Bun.
- Copiar ejemplo BFC existente de forma no destructiva: HTML cover-v3 con fonts/background embebidos si lo están, logo de captura original, outputs feed/story ya producidos y provenance. Asset creado/registrado sin usar asset render; revisión siguiente con fuente/output diferente local existente o edición gratuita. No gastar en fondos ni cambiar logo original.
- Agregar fixture de carpeta Remotion completa editable (package.json, lock propio, src y public) + MP4/cover existentes; no necesita IA ni render pesado. Crear dos revisiones, comprobar rootHashes y r1 estable al cambiar preset. Proyecto compartido dos clientes y uno sin cliente.
- LIVE: antes de actuar leer choice/rationale de G-cw-live-r2; fixture <=20 MiB, namespace de proyecto único, exclusivamente bucket privado y sin delete. Guardar inventario no secreto de keys/hashes y bytes. Upload/retry/verify deep; recover en nuevo directorio desde solo R2 y projectId, sin objetos/registry/cache locales. Comparar SHA de fuentes/inputs/presets/outputs exactos, reconstruir catálogo sin índice remoto. No fake fallback si credenciales faltan.
- Browser: coordinador prepara servicio solo con permiso, verifica listener 0.0.0.0 y Tailscale si se comparte. Flash valida desktop/mobile, filtros, formatos, comparación r1/r2, imagen/video, downloads y estados separados. Capturas y assertions en evidencia; GLM nunca interpreta imágenes directamente.
- Ejecutar verification del frontmatter y registrar commands/exits/fixtures/hashes/URLs de acceso NO firmadas. No publicar contenido ni reemplazar galerías existentes. Detener servicio efímero al terminar.

## Handoff / cierre
Entregar evidencia observable de todos los criterios del goal y lista breve de límites. Coordinador reproduce verificadores antes de accept. Si endpoint/live/permiso falla, registrar blocker exacto y release, no declarar completado por tener tests offline verdes.

## Reglas de ejecución y reporte
Leer skill builder y feature-executor antes de implementar; mantener ownership. No ejecutar build/tests/formatters durante edición: al concluir la fase, correr verification una vez; coordinador lo reproduce antes de aceptar. Si falla por esta fase, corregir y repetir; si fallo ajeno, reportar sin reparar. No ejecutar gates/accept/commit/merge/deploy.

Reportar archivos modificados, cobertura de requisitos, comandos+exit codes, contratos preservados, bloqueos y limitaciones. Presupuesto de sesión en goal.md; presupuesto agotado => release/budget-limited, no done.
