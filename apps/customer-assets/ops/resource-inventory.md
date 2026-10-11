# Inventario de recursos del piloto · customer-assets (ESTADO REAL al 2026-10-06: recursos aplicados; email proveedor diferido)

Estado: **APLICADO 2026-10-05/06** bajo G-cap-live aprobado (nota R: en T-CAP-006). La tabla de abajo refleja el estado real. Los ids de emulación en `wrangler.jsonc` (`local-emulation-only`, bucket `customer-assets-local`) fueron reemplazados por los reales de producción en el deploy.

## Recursos Cloudflare

| # | Recurso | Nombre/valor | Estado | Notas |
|---|---|---|---|---|
| 1 | Worker | `customer-assets` | DESPLEGADO (versión vigente en custom domain) | bundle `dist/client` + `dist/server`; `compatibility_date 2026-09-01`; `nodejs_compat`. |
| 2 | Custom domain / route | `customers-assets.theelena.me` → worker | ACTIVO (zona `theelena.me`, HTTPS Cloudflare) | sin paths públicos a R2; `/` redirige 307 → `/login`. |
| 3 | D1 database (binding `DB`) | `customer-assets-prod` + id real en `wrangler.jsonc` | CREADA | solo el id commiteado, jamás credenciales. |
| 4 | Migraciones D1 | `0001_auth` → `0002_portal` → `0003_portal_projects` → `0004_upload_requests` → `0005_asset_upload_links` (en ese orden, forward-only) | APLICADAS 2026-10-05/06 (`migrations list` vacío) | detalle en `deployment-checklist.md` §2. |
| 5 | R2 bucket (binding `ASSETS`) | `customer-assets-prod` | CREADO, privado y aislado | NO es el bucket de backup Studio (`packages/providers` studio-r2); solo lectura/escritura vía Worker autenticado. |
| 6 | Secret `BETTER_AUTH_SECRET` | nombre fijo; valor solo en Cloudflare | CARGADO (`wrangler secret put`, 32B hex) | rotable; jamás en repo ni vars. |
| 7 | Secret email provider | diferido por decisión del operador (login por link copiado; 0 emails) | DIFERIDO (ver fila 13) | ver `portal:verify:live` y nota R: en T-CAP-006. |
| 8 | Var `PORTAL_ORIGIN` | `https://customers-assets.theelena.me` (+ `PORTAL_MAIL_FROM=portal@theelena.me`, `PORTAL_LIVE_SMOKE=1`) | SET en deploy | origen explícito; el CLI valida https (loopback http solo en tests). |
| 9 | Var `E2E_FIXTURE` | **PROHIBIDO en deploy** | AUSENTE (verificado por sonda 404 en vivo) | dead-code de test si no está seteada. |
| 10 | Observabilidad Worker | ON/OFF + retención | PENDING decisión | hoy `enabled: false`. |
| 11 | D1 Time Travel / backup policy | ON + retención | PENDING decisión | red de seguridad del rollback (`rollback.md` §3). |
| 12 | Credencial de deploy CI/operador | token `CLOUDFLARE_API_TOKEN` en Doppler `elena-tech/prd` (canal del resolver de credenciales) | OPERATIVA (verificada: zona theelena.me, Workers/D1/R2) | mínima privilegio; nunca en repo; valores jamás en logs/evidencia. |

## Email (magic link)

| # | Ítem | Valor | Estado |
|---|---|---|---|
| 13 | Proveedor | NINGUNO — diferido por decisión del operador 2026-10-05 (login por link copiado vía tail, single-use) | DIFERIDO (0 emails en todo el piloto) | retomar si se requiere entrega real. |
| 14 | Dominio remitente verificado (SPF/DKIM/DMARC) | n/a mientras el email siga diferido | DIFERIDO | — |
| 15 | Dirección `From` | `PORTAL_MAIL_FROM=portal@theelena.me` (var seteada; sin envíos) | SET sin uso | — |
| 16 | Volumen piloto | 1 magic link por login + 1 por invitación (decenas/mes) | presupuesto, no config |

## Presupuesto operativo del piloto (resumen; detalle en `deployment-checklist.md` §7)

- 2-5 clientes portal, 1 integrador CLI; sin IA/render/publicación.
- Archivos: JPEG/PNG/WebP ≤ 20 MiB; MP4 ≤ 50 MiB; HEIC rechazado; cuota 1 GiB/cliente.
- R2 ≈ cuota × clientes + staging transitorio (sesiones de upload expiran en 1 h; sin GC en v1 → limpieza manual autorizada si hay huérfanos).
- Requests Workers y D1: dimensionar por operación (auth re-lee estado por request — diseño intencional).
- Sin gasto de modelos ni publicación social en ninguna fase.

## Fuera de alcance v1 (no inventariar)

Publicación/programación social; aprobaciones de cliente; editor visual; IA/render; colas/cron; antivirus con garantías; HEIC/conversión; multipart de videos grandes; GC remoto; billing; reemplazo de Studio/dashboard.
