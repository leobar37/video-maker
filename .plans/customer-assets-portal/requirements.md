# Requisitos · customer-assets-portal

## Objetivo
Un cliente invitado sube sus materiales, consulta assets entregables y ve los posts generados en una cuadrícula de Instagram; el administrador controla accesos y entregas y los agentes operan los mismos datos desde CLI.

## Funcionales
- FR-001: acceso por invitación y enlace de login enviado al email verificado; sin registro público, con expiración y revocación de acceso. Nunca dar privilegios al primer usuario que se registre.
- FR-002: el administrador selecciona clientes existentes, invita personas y consulta cada espacio. Una persona puede pertenecer a varios clientes; un cliente puede tener varias personas.
- FR-003: cliente y administrador suben y consultan materiales privados con progreso, límites, errores recuperables y estado verificable; no presentar una carga pendiente como material disponible.
- FR-004: el catálogo muestra assets seleccionados del estándar existente con revisión y outputs exactos. El cliente no ve fuentes internas, recetas, credenciales ni borradores ocultos.
- FR-005: posts con título, caption, uno o varios outputs ordenados (carrusel), portada y visibilidad; el administrador habilita u oculta contenido. Esa visibilidad no equivale a aprobación editorial ni a publicación social.
- FR-006: cuadrícula de Instagram de tres columnas con orden explícito, portada, detalle de post y contenido visible; una simulación, no consulta ni conexión a la cuenta real.
- FR-007: CLI permite consultar/importar materiales y entregar revisiones mediante el mismo backend con JSON estable, paginación, credenciales acotadas y dry-run sin red/escrituras.
- FR-008: integración conserva IDs de cliente, proyecto, asset, revisión, rootHash y procedencia. Reintentar importación o entrega no duplica archivos ni entidades ni modifica una revisión previa.
- FR-009: administrar membresías y credenciales de agentes; revocación efectiva en cada request. Solo administrador humano controla visibilidad e invitaciones en v1.

## No funcionales
- NFR-001: autorización en servidor para todas las operaciones y archivos, separación entre clientes y entre sesiones humanas/API keys. Relaciones internas de proyectos multi-cliente no otorgan acceso implícito.
- NFR-002: archivos privados por defecto; sin links públicos permanentes. Validar contenido, tamaño, cuota, paths y nombres; nunca ejecutar ni mostrar inline HTML/SVG aportados por clientes.
- NFR-003: compatibilidad con CLI, schemas v1, snapshot/restore y backup existentes; adopción explícita y no destructiva, sin migración masiva.
- NFR-004: frontend/backend TanStack Start en runtime Workers; D1 para acceso y proyecciones; R2 para archivos. Validar Better Auth/Drizzle/D1 con versiones fijadas antes de ampliar implementación.
- NFR-005: experiencia móvil para subir fotos, galería y posts; estados vacíos/carga/error, formularios accesibles y sin filtración de cache al cambiar de cliente.
- NFR-006: operaciones idempotentes, auditoría mínima sin secretos, lectura paginada y conflictos de concurrencia explícitos. No asumir transacción distribuida entre D1/R2/Studio.
- NFR-007: no gasto/infra/migraciones/emails reales/deploy sin gate humano específico. Evidencia offline y live diferenciadas; no afirmar portal publicado sin smoke HTTPS real.

## No objetivos
Publicación/programación en Instagram o TikTok; aprobación/rechazo por cliente; comentarios; editor visual; IA/render automático; colas/cron; antivirus con garantías de escaneo; HEIC/conversión de codecs en Workers; carga multipart de videos grandes; borrar/GC remoto; billing; rehacer el taller creativo; reemplazar el dashboard confiable existente.
