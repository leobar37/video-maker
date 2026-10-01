---
id: "P-005"
goal: "G-001"
title: "Un dashboard read-only por catálogo y URLs"
status: "completed"
phase_type: "implementation"
description: "Un dashboard read-only por catálogo y URLs para cumplir el contrato agente-first."
end_state: "Una aplicación muestra catálogo imagen/SVG/video, diff y descargas seguras; tests HTTP/catalog pasan con exit 0."
verification: "bun test packages/dashboard/src/server.test.ts packages/dashboard/src/catalog.test.ts && bun run build"
deliverables: ["packages/dashboard/package.json", "packages/dashboard/src/server.ts", "packages/dashboard/src/ui/", "packages/dashboard/src/server.test.ts", "packages/dashboard/src/catalog.test.ts"]
entry_criteria: "Contrato normativo leído; dependencias aceptadas en climier; G-cw-implement resuelto."
dependencies: ["P-003", "P-004"]
requirements: ["FR-007", "FR-003", "FR-004", "NFR-002", "NFR-004", "NFR-006"]
subagent: "task"
model: "zai/glm-5.3-flash:high"
---

# P-005 · Un dashboard read-only por catálogo y URLs

Modelo obligatorio: `zai/glm-5.3-flash:high`.

## Context y resultado
Consumidor único del catálogo, no renderer ni HTML por cliente. Flash permite revisión visual de outputs. Leer contrato HTTP y DTO congelado; no redefinir manifest en la UI.

## Archivos / ownership
Nuevo packages/dashboard: Bun server con HTML/CSS/TS simple, sin React/framework/dependencias de infraestructura. Server/API consumo de studio; UI read-only. Cableado dashboard serve/url en specs dedicadas e integración por coordinador, no edición concurrente de runtime.

## Acceptance obligatorio
- Endpoints y filtros del contrato; URLs por nombre declarado de output y revisión inmutable, no paths/URLs arbitrarios. Resolver local desde snapshot o remoto desde storage inyectado. No resolver credenciales para --plan/health o catálogo local.
- Galería por cliente/proyecto/asset/kind, r1/r2, previews/formatos por nombres declarados, video controls, descargas exactas y fallback sin thumbnail. Separar producción/editorial/backup; mostrar failure/missing, no “backup confirmado” por boolean editable.
- XSS y traversal tests: metadatos escapados, CSP, tipos verificados, HTML/JS nunca embebido ni ejecutado, SVG descargable attachment, ninguna fuente privada publicada accidentalmente. No acciones mutadoras HTTP.
- UI responsive y accesible con loading/error/empty states. Sirve los mismos componentes para BFC y Remotion; no código por cliente.
- Bind/port explícitos, no iniciar servidor en plan. dashboard url genera enlace Tailscale comprobando IP y listener; no fallback loopback para usuario. Exponer requiere modelo trusted-tailnet explícito; no introducir auth/RBAC pública en esta fase.
- Tests arrancan y cierran servidor efímero local de prueba sin Docker/DB. Exposición duradera o navegación del operador se hace solo con autorización; evidencia visual final P-006.

## Handoff
Una app y comandos comunes, rutas y permisos documentados, fixtures compatibles y smoke tests HTTP. No generar otra galería para BFC ni copiar su HTML como dashboard final.

## Reglas de ejecución y reporte
Leer skill builder y feature-executor antes de implementar; mantener ownership. No ejecutar build/tests/formatters durante edición: al concluir la fase, correr verification una vez; coordinador lo reproduce antes de aceptar. Si falla por esta fase, corregir y repetir; si fallo ajeno, reportar sin reparar. No ejecutar gates/accept/commit/merge/deploy.

Reportar archivos modificados, cobertura de requisitos, comandos+exit codes, contratos preservados, bloqueos y limitaciones. Presupuesto de sesión en goal.md; presupuesto agotado => release/budget-limited, no done.
