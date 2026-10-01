---
id: "P-004"
goal: "G-001"
title: "R2 completo, commit inmutable y recuperación remota"
status: "completed"
phase_type: "implementation"
description: "R2 completo, commit inmutable y recuperación remota para cumplir el contrato agente-first."
end_state: "Fake storage demuestra sync idempotente, fallos sin confirmed y recover remote-only; tests sync/adapter pasan con exit 0."
verification: "bun test packages/studio/src/sync.test.ts packages/providers/src/storage/studio-r2.test.ts && bun run build"
deliverables: ["packages/studio/src/sync.ts", "packages/studio/src/sync.test.ts", "packages/providers/src/storage/studio-r2.ts", "packages/providers/src/storage/studio-r2.test.ts"]
entry_criteria: "Contrato normativo leído; dependencias aceptadas en climier; G-cw-implement resuelto."
dependencies: ["P-003"]
requirements: ["FR-006", "FR-004", "NFR-001", "NFR-002", "NFR-005", "NFR-006"]
subagent: "task"
model: "zai/glm-5.3:high"
---

# P-004 · R2 completo, commit inmutable y recuperación remota

Modelo obligatorio: `zai/glm-5.3:high`.

## Context y resultado
Backup de archivos completos, no solo extensiones de medios. Protocolos y keys definidos en contracts.md. Existencia de adapter R2 no prueba un snapshot completo ni autoriza requests live.

## Archivos / ownership
studio/src/sync.ts; providers/src/storage/studio-r2.ts y wiring lazy reutilizando r2-store/cliente existentes sin cambiar interfaces legacy. Exportaciones compartidas bajo coordinador. P-003 ya aceptada: integrar sync push/verify/recover como specs en módulo específico y all-specs, siguiendo su mapa de subcomandos y tests; no rediseñar runtime.

## Acceptance obligatorio
- Implementar StudioStorage HEAD/GET/putImmutable/list con paginación y fake comparable. Verificar documentación/código del cliente para condición de creación de manifiestos/objetos y tratamiento 412. No carreras HEAD+PUT mutables ni alias ETag=sha256.
- Todos los archivos declarados incluidos (HTML/SVG/JSON/fonts/locks/output/preset), privados por default. Public output solamente opt-in separado; no subir fuentes a bucket público. Plan offline ni construye cliente que resuelva secretos.
- Manifest commit después de confirmar objetos; receipts aparte, failed no confirmed. Retry reusa objetos correctos y nunca regenera outputs; distintos bytes misma key => CONFLICT.
- Recuperación lista prefixes hasta fin, valida manifests/paths/hashes y restaura proyecto, clientes, presets y assets en directorio nuevo sin registry/cache/índice local. Distintas versiones metadata no se pisan según orden aleatorio: conservar snapshots y elegir explícitamente activo.
- Probar: falla antes de commit, response perdida después de commit, reintento, mismo manifiesto/ID diferente contenido, hash corrupto, metadata incorrecta, cursores y catálogo reconstruible. Deep verify realmente GET+SHA.
- Condición R2 desconocida se investiga read-only con fuente primaria. Live con gate NO resuelto está prohibido: probe real solo P-006 con permiso, no usar credenciales durante tests fake.

## Handoff
API y protocolo listo, límites reales del cliente documentados y comandos de sync. No decir respaldo live confirmado ni cambiar .env/buckets/infra; gate live permanece humano.

## Reglas de ejecución y reporte
Leer skill builder y feature-executor antes de implementar; mantener ownership. No ejecutar build/tests/formatters durante edición: al concluir la fase, correr verification una vez; coordinador lo reproduce antes de aceptar. Si falla por esta fase, corregir y repetir; si fallo ajeno, reportar sin reparar. No ejecutar gates/accept/commit/merge/deploy.

Reportar archivos modificados, cobertura de requisitos, comandos+exit codes, contratos preservados, bloqueos y limitaciones. Presupuesto de sesión en goal.md; presupuesto agotado => release/budget-limited, no done.
