# video-maker

Pipeline de producción de videos como producto independiente (extraído y desacoplado
del monorepo `elena`). Bun workspaces, sin dependencias del monorepo origen.

## Workspace

| Paquete | Rol |
|---|---|
| `@videomaker/core` | Contratos de proyecto/escena, rutas seguras, hashing sha256, gates file-based, motor de operaciones pagadas |
| `@videomaker/schemas` | Schemas Zod versionados (propuesta/progreso/resultado, SceneResult, narración continua, catálogo) |
| `@videomaker/credentials` | Resolución de secretos (env-first, Doppler `elena-tech/prd`, lazy, cache, redacción) |
| `@videomaker/providers` | Adapters de medios, object storage y publicación (Zernio) |
| `@videomaker/motion-core` / `@videomaker/motion-remotion` | Frame math, timing continuo, composición `Film`, render adapter |
| `@videomaker/cli` | CLI declarativa de producción (comandos como datos) |

## Comandos

```bash
bun install
bun test
bun run build
bun run credentials:probe   # imprime solo nombres y longitudes, nunca valores
```

## Credenciales

Estrategia env-first con fallback a Doppler `elena-tech` / config `prd`:

1. Variables de entorno (incl. `.env` en la raíz del proyecto).
2. Token global `DOPPLER_TOKEN_ELENA_TECH` o `~/.config/elena-tech/config.json`
   (`dopplerToken`) → descarga
   `https://api.doppler.com/v3/configs/config/secrets/download?format=json&project=elena-tech&config=prd`.

La resolución es lazy (solo en operaciones que gastan), cacheada por proceso y
los secretos nunca se imprimen, persisten ni viajan en metadata/journals/bundles.

Credenciales cubiertas: `FAL_KEY`, `ZERNIO_API_KEY`, `ELEVENLABS_API_KEY` y `R2Env`
(`R2_ENDPOINT` del que se deriva el accountId, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`
y el par bucket/URL pública: `R2_BUNDLES_BUCKET_NAME`, `R2_MARKETING_BUCKET_NAME` +
`R2_MARKETING_PUBLIC_URL`, o el par genérico `R2_BUCKET_NAME` + `R2_PUBLIC_URL`).

Buckets de este producto (config local en `.env`, gitignored; el fallback Doppler
`elena-tech/prd` queda intacto): `video-maker-media-prd` (público, objetos
content-addressed servidos en `https://video.theelena.me/<key>`) y
`video-maker-archive-prd` (privado, copia fría).
