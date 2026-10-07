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

## Verified · P-001 runtime (2026-10-04, emulado; evidencia `evidence/customer-assets-portal/p001-runtime.json`)
- Versiones fijadas y probadas en `apps/customer-assets` (bun.lock): better-auth 1.7.7, @better-auth/api-key 1.7.7, @better-auth/drizzle-adapter 1.7.7, drizzle-orm 0.45.3, @tanstack/react-start 1.168.60, @tanstack/react-router 1.170.41, react 19.3.0, vite 8.3.2, @vitejs/plugin-react 6.1.1, @cloudflare/vite-plugin 1.62.5, @cloudflare/vitest-plugin 1.3.6, vitest 4.1.11, wrangler 4.147.0, @noble/hashes 2.4.0, typescript 5.9.3. Verificación: 24 tests (auth 15 + upload 9) exit 0, typecheck exit 0, build app exit 0, build raíz exit 0. Emulado solamente; G-cap-live sigue OPEN y nada real fue tocado.
- Adapter transaccional probado por test: drizzle `.transaction()` sobre D1 falla con `Failed query: begin`; `@better-auth/drizzle-adapter` corre con `transaction: false` (sentencias secuenciales, default del adapter). Atómico multi-statement queda para batch D1/CAS en P-002 (contracts §6); no se fabricó atomicidad.
- Comportamiento better-auth 1.7.7 observado por tests: `disableSignUp` bloquea el signup en VERIFY (el envío sigue ocurriendo para emails desconocidos y se crea fila de verification → mantener rate limiting activo en producción); token almacenado hasheado y de consumo único; HTTP `/api-key/create` rechaza `permissions` con 400 SERVER_ONLY_PROPERTY (scopes solo server-side vía `auth.api.createApiKey`); `/api-key/delete` exige sesión (sessionMiddleware) incluso server-side; API key jamás crea sesión (`enableSessionForAPIKeys: false`).
- Bundle Start/Workers probado: `vite build` emite `dist/client` + `dist/server` (main index.js, nodejs_compat, compat date 2026-09-01); cero `node:fs`/`node:path` en dist/server; SDK `packages/customer-assets/src/contracts.ts` sin imports. wrangler.jsonc usa IDs sintéticos de emulación; deploy/DNS/emails reales no ejecutados.
- Pendiente/no probado (doc-claims): las URLs presigned y el batch D1 del contrato siguen siendo afirmaciones de documentación — no ejercitadas aquí; `wrangler dev`/preview local del bundle Start y el comportamiento de R2 copy condicional en workerd REAL (solo emulado) requieren G-cap-local extendido o G-cap-live.
- Quirk bun 1.4.2: `bun --cwd <dir> run <script>` lista scripts de raíz sin ejecutar nada; usar `bun run --cwd <dir> <script>`. Symlink `@videomaker/customer-assets` no materializado por `bun install`; creado manualmente.

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
