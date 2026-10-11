# Rollback de aplicación sin destruir datos · customer-assets (P-005 · DOCUMENTACIÓN, nada aplicado)

Estado: **PENDING G-cap-live**. Políticas escritas ANTES del primer deploy; nada fue
ejecutado. Principio rector (contracts.md §2): `DeliveryRevision` y los bytes
comprometidos son INMUTABLES; una nueva versión son filas/referencias nuevas — el
rollback de la app nunca reescribe ni borra datos.

## 1. Qué se puede revertir y cómo

| Pieza | Mecanismo de rollback | Impacto en datos |
|---|---|---|
| Bundle del Worker | `wrangler versions rollback` (o redeploy del bundle anterior de `dist/`) | Ninguno: solo código. D1 y R2 quedan intactos. |
| Var/config (`PORTAL_ORIGIN`) | `wrangler versions` view/edit + redeploy | Ninguno. |
| Secret (`BETTER_AUTH_SECRET`) | Rotación por `wrangler secret put` | Invalida sesiones vivas (usuarios re-loguean); NO toca filas. |
| Migraciones D1 | **NO se revierten.** Forward-only (ver §3). | — |

Pasos de app rollback (orden):
1. Congelar cambios: sin nuevos deploys durante la ventana.
2. `wrangler versions list` y elegir la última versión GOOD conocida (etiquetarla en el momento del deploy healthy).
3. `wrangler versions rollback <id>` y verificar: `GET /api/health` → `{d1:true,r2:true}`; login magic link real de prueba; una descarga con hash verificado; un 404 cross-client.
4. Comunicar ventana a los clientes solo si hubo escritura fallida visible (p. ej. upload a medio).

## 2. Qué NUNCA se borra / toca durante un rollback

- **Base D1 completa** (`<d1-database-name>`): usuarios, sesiones, memberships, invitations, grants, materiales, entregas, posts, grid, audit. El borrado rompe accesos y auditoría.
- **Objetos R2 del portal** (`<r2-bucket-name>`): bytes de materiales y outputs comprometidos son inmutables y content-addressed; borrar rompe entregas ya visibles para clientes (y no hay re-render implícito).
- **Bucket de backup Studio**: el portal NO lo usa; nunca debe ser alcanzado por scripts de limpieza del portal.
- **Filas `apikey` de agentes**: para cortar acceso se revoca el `agent_grant` (`revoked_ms`) o se deshabilita la key (`enabled=false`) — jamás DELETE arbitrario (pérdida de auditoría y de trazabilidad del principal).
- **`audit_event`**: apéndice-only; es la evidencia de operación.

## 3. Política de migraciones (forward-only)

- Toda migración nueva es ADITIVA (columnas/tablas nuevas, sin drops ni renombres destructivos) y se revisa en el checklist antes de aplicar.
- Aplicar ANTES del deploy que usa el schema nuevo (deploy compatible-hacia-atrás: código nuevo tolera schema viejo por una versión cuando sea posible).
- Si una migración sale mal: NO se edita a mano. Se detiene el deploy, se corrige con una NUEVA migración aditiva. Restauración puntual solo vía D1 Time Travel / backup por el operador (decisión PENDING, ver resource-inventory).
- Las migraciones de emulación (`apps/customer-assets/tests/e2e` fixture reset) son SOLO de test: jamás correr contra la base real.

## 4. Degradaciones seguras (menores que rollback)

- Output/asset comprometido: admin lo OCULTA (`PATCH /api/v1/client-assets/:id/visibility` → `internal`); la cascada retira catálogo/post/URL directa. Los bytes permanecen para auditoría.
- Key de agente comprometida: revocar grant desde la UI admin; corta el siguiente request sin tocar sesiones humanas.
- Cliente comprometido: revocar membership/invitación desde la UI admin; la sesión viva pierde acceso en el próximo request (autorización re-leída por request).
- Cuota agotada / uploads erróneos: no hay GC en v1; la limpieza es operación manual autorizada y documentada.

## 5. Ejercicio de rollback (a realizar en P-006 con G-cap-live, no antes)

- [ ] Simular fallo: deploy de una versión rota en staging/dev de Cloudflare y rollback documentado con exit codes y tiempos.
- [ ] Verificar post-rollback: hashes de una entrega previa descargada sin cambios; audit_event registra la ventana.
