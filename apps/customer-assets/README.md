# customer-assets · portal privado de clientes (Start/Workers + D1 + R2)

App TanStack Start sobre Cloudflare Workers. Studio sigue siendo la fuente de
verdad (clientes/proyectos/assets/revisiones); D1 guarda acceso, uploads y
proyecciones de entrega; R2 privado guarda los bytes. Producción:
https://customers-assets.theelena.me

## Scripts (desde la raíz del repo)

| Comando | Qué hace |
|---|---|
| `bun run --cwd apps/customer-assets test:worker` | suites workerd emulado (D1/R2 reales emulados, mail fake) |
| `bun run --cwd apps/customer-assets test:ui` | tests de componentes/rutas |
| `bun run --cwd apps/customer-assets test:e2e` | Playwright contra servidor efímero 127.0.0.1 |
| `bun run --cwd apps/customer-assets typecheck` | `tsc --noEmit` |
| `bun run --cwd apps/customer-assets build` | bundle cliente+servidor |
| `bun run portal:verify` | E2E offline completo (11 etapas, no-vacuo; sonda `PORTAL_VERIFY_SABOTAGE=1`) |
| `bun run portal:verify:live` | smoke HTTPS contra producción (requiere credenciales CF; 0 emails por defecto) |

## Rutas

- `/login` — magic link (email diferido en prod: acceso por link minteado, ver CLI)
- `/portal`, `/portal/:clientId/{materials,assets,posts,instagram}` — vista miembro
- `/admin/clients`, `/admin/clients/:clientId/{materials,assets,posts,projects,access}` — admin
- `/request/:token` — subida de invitado por solicitud (sin login)
- `/asset-upload/:token` — subida de invitado atada a un asset exacto (sin login)
- `/api/v1/*` — API versionada (envelope `{items,nextCursor}` / `{error:{code,message,requestId}}`)
- `/api/auth/*` — handler Better Auth (magic link `disableSignUp`, API keys sin impersonación)

## CLI (desde raíz: `bun packages/cli/src/main.ts …` o `bun run vm` + spec)

Credencial por env `CUSTOMER_ASSETS_API_KEY` (nunca `--token`); origen HTTPS
explícito; mutaciones requieren `--execute` (sin él: plan, cero red/escrituras).

- `portal-auth-status`, `portal-client-adopt/list`, `portal-material-list/show/pull`
- `portal-delivery-push`, `portal-asset-list`
- `portal-access-link --client <id> --email <e> --expires-in 7d` → URL de login single-use (admin o key `access:write`)
- `portal-request-create/list/close/link` + `portal-request-pull` (requieren scope `requests:read/write`)
- `portal-asset-upload-link --workspace <dir> --project <studioId> --asset <id> --expires-in 24h` → URL de subida atada al asset (scope `assets:write`)
- `portal-asset-pull`, `portal-asset-ingest-pull` — importan al asset abierto exacto (SHA verificado, idempotente)
- `portal-ingest-serve --origin <https> --ingest-port 8787` — servidor tailnet (ata SOLO la IP Tailscale, nunca 0.0.0.0) para videos pesados con subida chunked reanudable

## Env / bindings (producción en `wrangler.jsonc`)

Vars: `PORTAL_ORIGIN`, `PORTAL_MAIL_FROM`, `PORTAL_LIVE_SMOKE=1` (emite el
magic link a `wrangler tail` en vez de enviarlo; el stub rehúsa sin ella).
Secret: `BETTER_AUTH_SECRET` (solo `wrangler secret put`). Bindings: D1 `DB`,
R2 `ASSETS`. `E2E_FIXTURE` PROHIBIDA en deploy (sonda 404 en vivo).

Migraciones (forward-only, en orden): `0001_auth` → `0002_portal` →
`0003_portal_projects` → `0004_upload_requests` → `0005_asset_upload_links`.

## Operación

Ver `ops/` (checklist, inventario aplicado, rollback, runbook del piloto).
Evidencia: `evidence/customer-assets-portal/` (offline/live) y
`evidence/customer-assets-requests/`. Secretos: canal Doppler `elena-tech/prd`
(vía resolver de `packages/credentials`); jamás en repo, logs ni evidencia.
