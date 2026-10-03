# Contexto · customer-assets-portal

Fecha de revisión: 2026-10-03. Objetivo original: portal privado para recibir fotos, mostrar assets y posts y simular Instagram, acompañado de CLI para agentes. El usuario autorizó aterrizar el plan, NO construir, migrar, desplegar o iniciar workers.

## Verified · repositorio
- `package.json`: Bun monorepo `packages/*`, build raíz = TypeScript noEmit, scripts `vm`, `studio:verify`, `studio:verify:r2` existentes. `tsconfig.build.json` cubre paquetes/scripts, no apps.
- `packages/schemas/src/studio.ts`: clientes con metadata JSON no secreta; proyectos cero/multi-cliente; assets abiertos con sources/inputs/outputs; outputs private/public; revisiones selladas con rootHash, clientSnapshots y recipeSnapshot. Snapshot requiere outputs; raw material no es revisión sellada.
- `packages/studio/src/contracts.ts`, `workspace.ts`, `snapshot.ts`, `catalog.ts`: SDK file-based completo. Catálogo construido de revisiones, no filesystem mutable ni DB. No ACL por usuario.
- `packages/cli/src/spec-types.ts`, `runtime.ts`, `specs/studio.ts`, `specs/studio-pairs.ts`, `all-specs.ts`: dispatcher único, pares whitelist, JSON schemaVersion/ok/data|error, codes 0/1/2, plan/dry-run sin run/red/credenciales.
- `packages/providers/src/storage/studio-r2.ts`: backup privado, putImmutable condicional, SHA e idempotencia; no equivale al archive legacy `packages/cli/src/persist/archive.ts` ni sus URLs públicas.
- `packages/dashboard/src/server.ts`, `ui/app.js`, `tailscale.ts`: viewer Bun read-only de red confiable; no autenticación pública. Filtro clientId NO es autorización. No exponer este proceso a Internet como portal.
- No app TanStack ni Better Auth/D1 implementados en áreas investigadas. `.plans/creative-workspace/goal.md` figura completed, pero eso no reemplaza rerun de validaciones.
- `git status --short` mostró 23 archivos modificados y 36 untracked previos, incluyendo registry/CLI/dashboard/schemas. No se modificaron, revirtieron ni repararon. Releer baseline antes de edición futura y coordinar owner de fronteras compartidas.

## Verified · documentación primaria
- [Better Auth Drizzle adapter](https://www.better-auth.com/docs/adapters/drizzle): SQLite soportado; la documentación actual usa `@better-auth/drizzle-adapter` (no asumir import/version histórica).
- [Drizzle Cloudflare D1](https://orm.drizzle.team/docs/connect-cloudflare-d1): soporte D1/Workers; [driver fuente](https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-orm/src/d1/driver.ts) usa binding D1.
- [Better Auth TanStack Start](https://www.better-auth.com/docs/integrations/tanstack): auth server route y cookies plugin (último en lista si se usa).
- [TanStack Start Cloudflare](https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack-start/): Workers/Vite plugin, nodejs_compat y entrypoint Start.
- [Magic link](https://www.better-auth.com/docs/plugins/magic-link): disableSignUp, token hashed, expiración, proveedor de email callback y consumo de token. Verificar comportamiento de la versión fijada.
- [API key](https://www.better-auth.com/docs/plugins/api-key), [advanced](https://www.better-auth.com/docs/plugins/api-key/advanced): plugin separado y scopes; session mocking no recomendado. No habilitarlo en v1.
- [D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/): statements batch transaccionales. [Drizzle session fuente](https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-orm/src/d1/session.ts) tiene ruta transaction con BEGIN/COMMIT: no asumir que funciona en D1; probar/configurar adapter compatible o bloquear, no cambiar a Postgres a escondidas.
- [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/): bearer reutilizable hasta expiry y dominio S3, no custom domain; motivo para proxy privado autenticado y staging en v1.

## Inferred / decisiones propuestas
App independiente Start/Workers con D1 y R2 privado. Bridge CLI ejecuta Studio local; Worker solo recibe schemas puros/proyecciones y outputs, nunca `node:fs`, Studio file-based, Bun dashboard ni renderer. SDK nuevo no depende de Node/Bun; imports puros reutilizan schemas existentes con prueba de bundle.

## Unknown / decisiones abiertas acotadas
1. Versiones exactas y comportamiento runtime de Better Auth+Drizzle+D1+plugins: P-001 las fija y demuestra, no se declara compatibilidad live probada por documentación.
2. Cuenta Cloudflare, zona/DNS, D1 ID, bucket y política secrets del portal: operador los asigna en gate live. No leer .env ni aprovisionar por conveniencia.
3. Proveedor email y remitente verificado: reutilizar aprobado si existe, o pedir alta al preparar live; ningún envío real en offline.
4. Cliente piloto/workspace y persona invitada: fixture sintético por defecto; adopción real solo selección explícita, sin deducir cliente del cwd.
5. Perfil exacto provider/model y presupuesto de sesión OMP: preflight de lanzamiento, sin sustituir modelos si no están disponibles. Plan no consume sesiones nuevas.
6. Retención/limpieza de staging y conversión HEIC/videos grandes: fuera de v1. Operador debe conocer que objetos huérfanos pueden requerir limpieza posterior autorizada.

Estas incógnitas no bloquean preparar el plan. Sí bloquean su fase correspondiente; no autorizan scope nuevo.
