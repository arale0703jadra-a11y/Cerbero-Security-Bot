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
2. Aplica `supabase/migrations/001_initial_schema.sql` en Supabase.
3. Ejecuta `npm install`.
4. Ejecuta `npm run typecheck` y `npm run build`.
5. Inicia con `npm start`.

Los tokens y la service role key solo se leen desde el entorno.
