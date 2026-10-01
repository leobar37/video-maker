# Requisitos · creative-workspace

## Funcionales
- FR-001: clientes y presets de marca versionados; cambio de logo conserva versiones previas y su procedencia.
- FR-002: proyectos independientes de clientes; cero o varios clientes y varias marcas/presets por asset.
- FR-003: asset abierto para imagen, SVG, video y otros; inspección muestra fuentes, recursos y paths reales; creación no exige output ni renderer.
- FR-004: snapshot de outputs existentes + fuentes/inputs/presets exactos; historial, diff y restore sin regeneración; checkpoint de revisiones de varios assets.
- FR-005: gestión desde CLI declarativa, subcomandos y JSON estables; dry-run describe efectos sin ejecutarlos; recipe opcional y ejecución explícita.
- FR-006: backup R2 completo e idempotente; manifest como commit; recuperación en carpeta vacía sin catálogo/registry local; índice reconstruible.
- FR-007: un dashboard común por datos/URLs, filtros, previews, descargas, comparación de revisiones y estados separados de editorial/producción/backup.
- FR-008: adopción no destructiva de BFC y un asset de proyecto Remotion sin encerrar el agente en plantillas; no copiar todos los trabajos ni cambiar videos existentes.

## No funcionales
- NFR-001: revisiones inmutables y SHA-256 comprobado; ningún ETag o metadata editable equivale a backup confirmado.
- NFR-002: paths seguros, ninguna credencial/cookie/key en snapshots/logs/manifests; contenido activo no ejecutado por dashboard ni restore.
- NFR-003: contratos y comandos legacy conservados; baseline build y tests de compatibilidad deben pasar.
- NFR-004: fuentes visibles y exportables, sin renderer obligatorio, sin código de presentación por cliente, sin base de datos/infraestructura nueva.
- NFR-005: fallo de sync preserva trabajo local y retry no repite producción; índices y URLs efímeras no son fuente de verdad.
- NFR-006: datos privados por defecto, entregables públicos solo opt-in; UI en red de confianza y links Tailscale verificados, nunca loopback para usuario.
- NFR-007: tareas/fases con evidencia reproducida por coordinador; modelos exactos GLM/Flash, gates humanos y presupuesto explícito.

## Fuera de alcance
Publicar en Instagram/TikTok, IA pagada, editar escenas de clips, catálogo obligatorio de templates, editor visual, auth/RBAC multiusuario para Internet, migración masiva, borrado/GC remoto, workers de render automáticos, merge/commit/deploy o contenedores.
