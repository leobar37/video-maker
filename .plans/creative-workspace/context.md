# Contexto · creative-workspace

## Pedido y autorización
Crear un plan con `orchestrate-session`, contratos/APIs anti-desvío y reparto GLM-5.3 para lo pesado, Flash para el resto. El formato estructurado es el requerido por ese workflow: seis unidades independientes, un contrato normativo y configuración aislada. Se prepara el plan y se registra su DAG; NO se implementa la aplicación ni se lanza la sesión.

## Verified
- CLI declarativa: `packages/cli/src/spec-types.ts`, `all-specs.ts`, `runtime.ts`, `args.ts`. Actualmente verbos planos; `CommandSpec` declara args, writes, plan/run y gates. Plan no puede resolver credenciales ni tocar red.
- `packages/core` no depende de schemas; `packages/schemas` depende de Zod. Nuevo dominio en paquete separado evita acoplar core con storage/dashboard.
- `packages/providers/src/storage/r2-store.ts`, `ports.ts`, `packages/cli/src/persist/archive.ts`, `policy.ts`, `r2-wiring.ts`: storage y verificación de SHA existentes; archive legacy solo inventaría medios y no equivale a snapshot completo de fuentes/JSON/lockfiles.
- `packages/motion-remotion/src/brand.ts`: presets de tokens para video, no registry versionado de marcas. `VideoConfig.branding.preset` sigue siendo un string; no reemplazarlo.
- Caso BFC: `bfc/render-designs.ts`, `bfc/assets/logo-bfc-profile.png`, `bfc/covers/cover-v3.html`, `bfc/posts/02/covers/cover-v3.html`, `bfc/posts/03/covers/cover-v3.html` y outputs existentes. Logo recuperado de captura original, no vector original. No redibujarlo ni llamarlo SVG oficial.
- `scripts/omp-session.sh` existente permite goal/bootstrap distintos pero NO tiene check anti fuzzy-match: crear launcher propio basado en template de la skill, sin tocar sesiones anteriores.
- `omp` y `climier` instalados; `.climier.json` existente. Catálogo `omp models zai --json` confirma glm-5.3 y glm-5.3-flash. GLM-5.3 no admite imágenes, Flash sí. Modelos exactos, thinking high.
- Baseline `bun run build`: exit 0 al preparar el plan. Árbol ya contiene cambios de tareas anteriores; no limpiar, resetear, commitear ni atribuirse su trabajo.

## Inferred / decisión conservadora
Archivos locales + snapshots privados R2 bastan para el MVP. Un único dashboard read-only, vanilla TS/HTML y servidor Bun, encaja sin framework nuevo ni base de datos. Estos son límites del plan, no afirmación de que ya existan.

## Unknown / riesgos a comprobar dentro de las fases
- Soporte real de PUT condicional del adapter/endpoint: P-004 lo verifica y escala si no permite el protocolo inmutable.
- Acceso actual a buckets y permiso live: gate separado; no leer valores de .env ni probar R2 al planificar.
- Fuentes y dependencias externas de obras existentes: documentarlas; exactitud de restore de outputs no implica reproducibilidad del render en otra máquina. Para BFC usar HTML ya embebido como fuente portable y copiar recursos necesarios, sin cambiar render-designs.ts.
- Alcance de auth Internet/multiusuario: fuera del MVP. Dashboard solo red de confianza, exposición explícita; no prometer seguridad pública.

## Orden y prioridades
Contrato -> snapshots locales -> CLI y R2 -> dashboard -> integración. Fuentes abiertas y outputs primero. No comenzar creando layouts o renderers. No acoplar proyectos a un solo cliente. `contracts.md` manda sobre ideas anteriores de templates obligatorios.
