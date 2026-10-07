# Deployment checklist · customer-assets (P-005 · DOCUMENTACIÓN, nada aplicado)

Estado: **PENDING G-cap-live**. Este checklist NO fue ejecutado: ningún recurso fue
creado, ningún secret cargado, ningún deploy ni email enviado. Los valores entre
`<…>` los asigna el operador humano detrás del gate. Referencias: `wrangler.jsonc`
(bindings `DB` y `ASSETS`, ids sintéticos de emulación), `migrations/`,
`contracts.md` §3/§4/§6, `context.md` (incógnitas 1-6).

## 0. Autorizaciones previas (bloqueantes)

- [ ] G-cap-live aprobado por humano (recursos, migraciones, secrets, email, DNS, deploy, piloto).
- [ ] Cuenta Cloudflare y zona `theelena.me` accesibles solo al operador.
- [ ] Confirmar que la app desplegada NO lleva la var `E2E_FIXTURE` (es dead-code de test: el endpoint fixture responde 404 sin ella).

## 1. Worker

- [ ] Worker name: `customer-assets` (ya fijo en `wrangler.jsonc`).
- [ ] Compatibilidad: `compatibility_date 2026-09-01`, `nodejs_compat` (no cambiar sin re-verificación).
- [ ] Observability: decidir ON/OFF y retención (hoy `enabled: false`).
- [ ] Build artefacto: `bun run --cwd apps/customer-assets build` emite `dist/client` + `dist/server`; deploy desde ese bundle (P-001 probó el bundle, no el deploy).

## 2. D1 (binding `DB`)

- [ ] Crear base D1 `<d1-database-name>` (PENDING; emulación usa `customer-assets-local` con id sintético `local-emulation-only`).
- [ ] Anotar `database_id` real en `wrangler.jsonc` (reemplaza el placeholder) — nunca commitear credenciales, solo el id.
- [x] Aplicar migraciones EN ORDEN (forward-only) — D1 `customer-assets-prod`: todas aplicadas 2026-10-05/06 (`wrangler d1 migrations list` vacío):
  1. `migrations/0001_auth.sql` — tablas Better Auth (`user`, `session`, `account`, `verification`, `apikey`) según versiones fijadas 1.7.7.
  2. `migrations/0002_portal.sql` — portal (`portal_workspace`, `portal_client`, `membership`, `invitation`, `agent_grant`, `upload_session`, `material`, `delivery_revision`, `delivery_output`, `client_asset`, `post`, `post_output`, `client_grid`, `client_quota`, `idempotency_record`, `audit_event`).
  3. `migrations/0003_portal_projects.sql` — proyección `portal_project` + `material.portal_project_id` NULLable (R-1; sin backfill, uploads libres intactos).
  4. `migrations/0004_upload_requests.sql` — `upload_request` + `upload_request_token` (hash SHA-256) + `material.upload_request_id` NULLable (R-2).
  5. `migrations/0005_asset_upload_links.sql` — `asset_upload_link` (token SHA-256) + `material.asset_target` NULLable (asset-links; ninguna fila existente se altera).
- [x] Verificado post-migración: `wrangler d1 migrations list` vacío; tablas presentes (2026-10-06).
- [ ] Habilitar D1 Time Travel / política de backup (PENDING decisión del operador; es la red de seguridad del rollback).
- [ ] Provisioning inicial controlado: usuario admin + workspace + integrador vía flujo admin (NUNCA primer-registro; `disableSignUp` activo) y rate limiting de Better Auth ENCENDIDO (hallazgo P-001: para emails desconocidos se crean filas de verification aunque el signup esté bloqueado).

## 3. R2 (binding `ASSETS`)

- [ ] Crear bucket `<r2-bucket-name>` **privado, aislado** (PENDING; nombre propuesto `customer-assets-prod`).
- [ ] VERIFICAR que NO es el bucket de backup Studio (`packages/providers` studio-r2): cuentas/bucket/credenciales separadas; el portal nunca toca el backup.
- [ ] Sin dominio público ni acceso S3 compartido: lectura/escritura SOLO vía el Worker autenticado (staging inaccesible desde rutas de lectura; keys finales content-addressed).
- [ ] Sin GC automático en v1: documentar que objetos huérfanos (fallo D1 post-R2) requieren limpieza manual autorizada.

## 4. Secrets y vars (solo NOMBRES — valores por `wrangler secret put` / dashboard, jamás en repo)

| Nombre | Tipo | Nota |
|---|---|---|
| `BETTER_AUTH_SECRET` | secret | requerido por Better Auth; rotable; nunca en vars plaintext. |
| `<EMAIL_PROVIDER_API_KEY>` | secret | nombre exacto según proveedor elegido (PENDING; p. ej. `RESEND_API_KEY`). |
| `PORTAL_ORIGIN` | var | `https://customers-assets.theelena.me` (origen explícito, sin path). |
| `E2E_FIXTURE` | **PROHIBIDO en deploy** | solo harness e2e loopback. |

- El CLI consume `CUSTOMER_ASSETS_API_KEY` como env inyectada del agente (lado cliente, no es secret del Worker).

## 5. Email (magic link)

- [ ] Proveedor elegido y alta completada (PENDING; reutilizar el aprobado si existe — `context.md` incógnita 3).
- [ ] Dominio remitente VERIFICADO (SPF/DKIM/DMARC en la zona) y dirección `From` definida, p. ej. `portal@theelena.me` (PENDING).
- [ ] Plantilla magic link: token hasheado, un uso, expiración corta; respuesta neutra para emails desconocidos (sin enumeración).
- [ ] Enviar SOLO tras verificar el sender con un email de prueba autorizado por el operador (ningún envío real en offline).

## 6. DNS / dominio

- [ ] Route/Custom Domain: `customers-assets.theelena.me` → worker `customer-assets` (zona `theelena.me`).
- [ ] HTTPS gestionado por Cloudflare; sin paths públicos hacia R2.
- [ ] Smoke post-deploy: `GET /api/health` responde `{d1:true,r2:true}` desde el dominio.

## 7. Presupuesto del piloto (PENDING confirmación del operador)

- Alcance piloto: 2-5 clientes portal, 1 integrador CLI, decenas de materiales/entregas. Sin IA/render/publicación (fuera de alcance v1).
- Límites por archivo (v1, ya en código): JPEG/PNG/WebP ≤ 20 MiB; MP4 ≤ 50 MiB; HEIC rechazado.
- Cuota: 1 GiB por cliente (`DEFAULT_CLIENT_QUOTA_BYTES`), reservada por upload concurrente (CAS) — presupuestar R2 ≈ cuota × clientes activos + staging transitorio (TTL de sesión 1 h).
- Requests Workers: estimar por operación (login/magic link, listados, upload 3 llamadas, descarga streaming con Range para MP4); margen para rate limit de auth.
- D1: lecturas por request de autorización (relee estado vivo en cada request — diseño intencional); writes acotados a mutaciones; batch D1 para operaciones atómicas.
- Emails: 1 magic link por login + 1 por invitación (decenas/mes en piloto; nada de bulk).
- Sin gasto de modelos/generación ni publicación social.

## 8. Verificación del piloto (tras deploy, antes de clientes reales)

- [ ] `bun run portal:verify:live` (se crea en P-006) exit 0 con evidencia HTTPS real.
- [ ] Alta admin → invitación → login real por email → upload → CLI pull/push → visibilidad → grid → descarga con hashes coincidentes.
- [ ] Negativos en vivo: revocación corta siguiente request; cross-client 404; salida oculta 404.
- [ ] Offline success ≠ dominio publicado: no declarar el portal abierto sin este smoke.
