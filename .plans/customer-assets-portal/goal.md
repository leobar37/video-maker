---
id: "G-001"
title: "Portal privado de materiales y entregas conectado a Studio y CLI"
status: "completed"
end_state: "Los seis goal units pasan verification; cliente invitado sube material, CLI importa a Studio y entrega output sellado que admin habilita y cliente ve en grid; smoke HTTPS live en dominio aprobado pasa con aislamiento y revocación."
verification: "bun run portal:verify && bun run studio:verify && bun run build && bun --cwd apps/customer-assets run build && bun run portal:verify:live; todos exit 0; live solo tras G-cap-live"
deliverables: ["Portal Start admin/cliente", "Auth Better Auth con D1 y grants de CLI", "R2 privado con uploads verificables", "Bridge Studio y posts/grid", "Evidencia offline/live y operación"]
budget: "Por fijar por operador al lanzar OMP; un worker mutable; sin gastos de Cloudflare/email/modelos autorizados por este plan."
---

# G-001 · Portal de clientes y CLI

## Description
Completar el taller creativo con entrada privada de materiales y entrega visual por cliente, en customers-assets.theelena.me. El sistema de producción sigue siendo Studio; no otra fábrica de contenido ni otra copia editable de sus revisiones.

## End State
Un fixture de dos clientes demuestra login privado, subida de imagen, lectura/importación por CLI, output de revisión exacta entregado, habilitación por administrador y vista de Instagram; acceso cruzado/keys sin scope/revocación negados en API y archivos. Verifications de las seis fases pasan, incluido smoke real HTTPS autorizado. Si no hay permiso de nube, P-006 y el goal quedan blocked; offline listo es hito intermedio, no completed.

## Deliverables
App nueva Start/Workers y SDK puro; esquema D1 y políticas de acceso; R2 de portal privado aislado; specs portal-* dentro de CLI existente; dashboard admin/cliente con materiales/assets/posts/grid; pruebas y evidencia offline/live; checklist despliegue y rollback de app sin borrar datos.

## Definition of Done
1. Cada fase accepted tras reproducción por coordinador de sus verificaciones, no auto-accept.
2. `portal:verify` (se crea en P-005) exit 0 con etapa real cliente→CLI→Studio→entrega→grid y pruebas negativas/concurrencia/hash; sin 0-tests ni skips usados como evidencia.
3. `studio:verify`, build raíz y build app exit 0, conservando manifests y compatibilidad; fallos ajenos se reportan sin expansión de scope.
4. `portal:verify:live` (se crea en P-006) exit 0 bajo autorización explícita y evidencia HTTPS real en customers-assets.theelena.me, login/email y recursos privados, scope y revocación.
5. Evidencia desktop/móvil revisada personalmente y hashes materiales/outputs, entorno y counts registrados sin secretos en `evidence/customer-assets-portal/`.

## Constraints / Must Not Change
Preservar schemas Studio v1, referencias exactas, backup/checkpoints, CLI legacy, archivos/clientes reales y viewer confiable. No expose Bun dashboard a Internet. No DB/infra/migrations/emails/live requests en planificación. No publicación, generación pagada, editor, aprobación por cliente, migración masiva o GC remoto.

## Authorization
`G-cap-implement` = autorizar implementación acotada y tests sin DB/live; `G-cap-local` = autorizar aplicar schemas únicamente a D1 emulado temporal de tests; `G-cap-live` = aprobar inventario concreto de recursos, DB/migraciones/cloud/secrets/email/DNS/deploy/piloto y límites. Ninguno se autoriza desde agentes ni se deduce de este plan. No iniciar OMP ni consumir provider quota sin lanzamiento autorizado.
