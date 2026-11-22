# minimarket-dashboard

Panel financiero de **Minimarket Marín 376** y **Minimarket Argomedo 455** (una sola página, `index.html`, instalable como app).

## De dónde saca los datos
- Todo viene de la Edge Function de Supabase **`finanzas-api`**: `https://znywepjclzhgkctzrjxb.supabase.co/functions/v1/finanzas-api/` (constante `WORKER_FINANZAS_URL` en `index.html`). El código del servidor está en el repo `marin376-finanzas`.
- Las bases son esquemas del mismo Postgres de Supabase: `marin376` (Marín) y `argomedo455` (Argomedo). **Ya no se usa Cloudflare ni D1**; el Worker de Cloudflare solo reenvía a la Edge Function.
- Un ajuste global de `fetch` (al inicio del script) agrega `?forceFunctionRegion=sa-east-1` a toda llamada a las funciones de Supabase; sin eso la función se ejecuta en EE. UU. y tarda 5-10 s.
- La clave de acceso se pide la primera vez y queda en `localStorage` (`tokenFinanzas`). Vive en la tabla `configuracion` (clave `token_dashboard`) del esquema `marin376`.
- La selección de local (Marín / Argomedo) se manda como `local` en cada llamada.

## Pestañas principales
Resumen · Cierre (carga del cierre de caja, también por foto con Gemini) · Revisar (movimientos del banco sin clasificar; permite crear proveedores o rubros nuevos) · Registros · Más (cartolas, abonos de Compraquí, etc.).

## Publicación
Los cambios de `index.html` se publican al fusionar a `main`. Los cambios del servidor van aparte, en `marin376-finanzas`, y se despliegan a Supabase.
