# Runbook P-006 · Stage B del piloto live (G-cap-live) · customer-assets

Secuencia EXACTA y única autorizada para el piloto `customers-assets.theelena.me`.
Cada paso es idempotente salvo los marcados; los valores `<…>` los inyecta el
operador/coordinador por env. Nada de este archivo se ejecutó offline: P-001..P-005
fueron emulación. Referencias: `deployment-checklist.md` (plan autorizado),
`rollback.md` (reversión sin destruir datos), `resource-inventory.md` (presupuesto).

Reglas duras:
- El token viaja SOLO por env (`CLOUDFLARE_API_TOKEN`); nunca en repo, logs ni evidencia.
- `E2E_FIXTURE` jamás se configura en deploy (dead-code del harness e2e).
- El bucket del portal es `customer-assets-prod` (privado, aislado): NUNCA el
  bucket backup Studio (`R2_BUNDLES_BUCKET_NAME`) ni el marketing.
- Migraciones forward-only; `d1 execute` solo para el provisioning controlado
  del piloto (INSERT OR IGNORE); sin DELETEs.

## 0. Preflight (local, sin mutations)

```bash
bun run portal:verify:live -- --preflight
# exit 0 = listo; exit 1 = gaps nombrados (hoy: credenciales cloud, database_id, email operador)
```

## 1. Credenciales (coordinador → env de esta shell)

```bash
export CLOUDFLARE_API_TOKEN='<token mínimo-privilegio del operador>'
export PORTAL_LIVE_EMAIL='<email aprobado del operador para el magic link>'
# opcionales:
export PORTAL_LIVE_INTEGRATOR_EMAIL='integrator@theelena.me'   # principal CLI (no recibe email)
export PORTAL_LIVE_EMAIL_SECRET_NAME='RESEND_API_KEY'           # nombre del secreto del proveedor
```

## 2. Recursos (crear SOLO lo autorizado; re-ejecutar es seguro)

```bash
cd apps/customer-assets
bunx wrangler d1 create customer-assets-prod
#   → copiar "database_id" a wrangler.jsonc (reemplaza REPLACE_WITH_REAL_D1_DATABASE_ID_AT_STAGE_B)
bunx wrangler r2 bucket create customer-assets-prod   # privado por defecto; sin dominio público
```

## 3. Migraciones (forward-only, en orden)

```bash
bunx wrangler d1 migrations apply customer-assets-prod --remote
bunx wrangler d1 migrations list customer-assets-prod --remote   # → vacío
# spot-check (opcional): sqlite_master debe listar user/session/…/audit_event
bunx wrangler d1 execute customer-assets-prod --remote --json \
  --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

## 4. Secret (valor SOLO del operador; jamás por argv/repo)

```bash
openssl rand -hex 32 | bunx wrangler secret put BETTER_AUTH_SECRET   # pega por stdin; nunca impreso
bunx wrangler secret list                       # verificación por NOMBRES
```

Sin proveedor de email en el piloto: el operador decidió **login = copiar el
enlace** (decisión registrada). Con la var `PORTAL_LIVE_SMOKE=1` (ya declarada
en `wrangler.jsonc`) el mailer LOGRA el magic link en los logs del worker —
visible SOLO en `wrangler tail` — y salen CERO emails. La entrega por proveedor
(`RESEND_API_KEY` + `PORTAL_MAIL_FROM` verificado, SPF/DKIM/DMARC) queda
diferida hasta decisión del operador (deployment-checklist §5).

## 5. Deploy + dominio

```bash
bun run build && bun run --cwd apps/customer-assets build   # tsc repo + vite bundle
cd apps/customer-assets && bunx wrangler deploy             # adjunta custom_domain customers-assets.theelena.me
```

Tras el deploy: `GET https://customers-assets.theelena.me/api/health` → `{"d1":true,"r2":true}`.

## 6. Smoke autorizado (una sola corrida; reproduce `live.json`)

```bash
bun run portal:verify:live -- --request-login
# → captura EL enlace vía `wrangler tail` (CERO emails) y lo deja en /tmp/p006-live-magic-link (0600)

PORTAL_LIVE_MAGIC_LINK="$(cat /tmp/p006-live-magic-link)" bun run portal:verify:live
# → 14 etapas: recursos/migraciones/deploy/dns/health/login/upload/CLI push/
#   grid/negativas/evidencia; escribe evidence/customer-assets-portal/live.json
```

Presupuestos aplicados por construcción: foto ≤ 1 MiB, uploads ≤ 20 MiB totales,
0 emails (techo 2), sin render/IA/publicación, sin borrado remoto.

## 7. Rollback (detalle en rollback.md)

- Código: `bunx wrangler versions list` → `wrangler versions rollback <id GOOD>`; verificar health + login + descarga.
- Datos: NUNCA se borra D1 ni objetos R2; migraciones no se revierten.
- Acceso: revocar grant/membership desde la UI admin (corta el siguiente request).
