# Cerbero Security Bot

Cerbero es el ejecutor de seguridad de Zeus.

- **Zeus controla:** panel, permisos, configuración y órdenes.
- **Cerbero ejecuta:** acciones de moderación y detecciones de seguridad.
- **Supabase comunica ambos:** órdenes, eventos, estado y auditoría.

Cerbero no tiene panel ni comandos administrativos. Su configuración llega
desde Zeus mediante Supabase. La primera versión ejecuta órdenes explícitas y
registra anti-spam en modo alerta; no aplica sanciones automáticas por
detecciones propias.

## Desarrollo

1. Copia `.env.example` a `.env` y completa las variables.
2. Para una instalación nueva, aplica las migraciones numeradas de
   `supabase/migrations/` en orden (001–012). `APPLY_ALL_001_TO_007.sql` es un
   script histórico alternativo para las primeras siete migraciones; no lo
   combines con ellas ni lo uses como sustituto de las migraciones posteriores.
3. Ejecuta `npm install`.
4. Ejecuta `npm run typecheck` y `npm run build`.
5. Inicia con `npm start`.

Para generar un artefacto de compilación aislado sin sobrescribir `dist/`, usa
PowerShell desde el repositorio:

```powershell
$artifact = Join-Path $env:TEMP ("cerbero-dist-" + [guid]::NewGuid().ToString("N"))
npm run build -- --outDir $artifact
if ($LASTEXITCODE -ne 0) { throw "CERBERO build failed." }
Write-Output $artifact
```

Ese directorio es el artefacto candidato. No lo copies sobre `dist/` ni lo
despliegues hasta que una fase autorizada revise el paquete y el procedimiento
de publicación.

## Recuperación de órdenes

`011_safe_command_lease_recovery.sql` actualiza atómicamente la reclamación:
usa bloqueo `SKIP LOCKED`, emite un nuevo token de fencing y limita los intentos
a cinco. Una concesión vencida se puede reclamar de nuevo solo si CERBERO aún
no registró `execution_started_at`. CERBERO registra ese marcador con el token
vigente antes de cualquier acción externa o cambio de configuración.

Si la concesión vence después del marcador, la orden queda con
`result_state = 'unknown'`, sin propietario activo, y no se vuelve a ejecutar
automáticamente. Un operador debe comprobar el estado real en Telegram y
resolver la orden como `completed` o `failed` en el flujo administrativo
existente solo después de verificar el efecto. Si ese flujo no permite resolver
la orden, debe permanecer `unknown`; no se debe reencolar ni cambiarla mediante
SQL improvisado. Los errores de red o la pérdida de confirmación después de
iniciar una acción también se marcan como desconocidos; no se reintentan
acciones de moderación automáticamente.

Las reclamaciones de órdenes y las lecturas de configuración tienen hasta dos
reintentos con espera exponencial solo para errores transitorios. Los fallos
permanentes no se reintentan dentro de la operación. El estado de salud de
`command-queue` y `security-config` se conserva en memoria del proceso; el
consumidor aumenta temporalmente el intervalo de sondeo tras errores.

Si la configuración del grupo no se puede leer tras esos reintentos, CERBERO
continúa procesando actualizaciones en modo de detección: flood, spam repetido,
spam de stickers o multimedia, enlaces, reincidencia y contenido pueden
registrarse, pero las acciones por regla quedan desactivadas, el modo pasa a
`alert`, y se deshabilitan sanciones, advertencias y eliminaciones automáticas.
Así se evita sancionar con una configuración desconocida sin detener el bot.

Los tokens y la service role key solo se leen desde el entorno.

## Catálogo público de AFRODITA

La migración local `012_afrodita_verified_catalog_read.sql` depende de las
migraciones 001 (grupos), 006 (`verified_users`) y 010 (cierre del acceso
directo a las tablas). Añade una allowlist cerrada por defecto y la RPC de
lectura `get_afrodita_verified_catalog(group_id)`. La RPC solo devuelve ID,
nombre y username para filas con `verified = true`, `revoked_at IS NULL` y
grupos activos habilitados explícitamente; no devuelve permisos ni multimedia.

La RPC concede `EXECUTE` a `anon`, por lo que el catálogo de un grupo habilitado
es público, aunque no se conceda `SELECT` sobre `verified_users` ni sobre la
allowlist. No se habilita ningún grupo automáticamente. Una persona operadora
debe autorizar explícitamente la publicación de cada grupo usando una sesión
privilegiada antes de habilitarlo. No copies una clave `service_role` a
AFRODITA: usa una publishable key o la clave JWT legacy con rol `anon`.

La función usa `SECURITY DEFINER`, un `search_path` fijado y
`row_security = off`; por tanto, el rol que la crea debe tener permisos
suficientes para leer las tablas y el bypass de RLS necesario. Antes de
autorizar grupos en producción, verifica en un entorno de pruebas el propietario
de la función, los grants, el comportamiento con RLS y que los únicos campos
publicados sean los previstos. Esta migración es local y no implica que se haya
aplicado en ningún proyecto remoto.
