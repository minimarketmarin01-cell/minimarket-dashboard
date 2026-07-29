/****************************************************************
 *  MARÍN 376 · WORKER (Cloudflare) — reemplaza Codigo.gs
 *  ---------------------------------------------------------
 *  ALCANCE DE HOY (Fase 3, parte 1):
 *   ✅ Dashboard: items + ventas (u7/u14/u30/u90) desde D1
 *   ✅ Vencimientos: listar, registrar lote, marcar revisado,
 *      eliminar lote, marcar cambiado, editar fecha
 *   ✅ Mermas: listar historial, registrar, corregir motivo
 *   ✅ Llegadas: listar, asignar fecha, ignorar
 *   ✅ Config categorías "cambio", reporte sin costo, consumo interno
 *
 *  PENDIENTE (Fase 3, parte 2 — más adelante):
 *   ⏳ Sincronización en vivo con Loyverse (recibos, catálogo)
 *   ⏳ Crear/eliminar productos y categorías en Loyverse
 *   ⏳ Actualizar costo/precio directo en Loyverse
 *
 *  Mientras tanto, este Worker corre EN PARALELO a Apps Script.
 *  El frontend (index.html) sigue apuntando a Apps Script hasta
 *  que probemos este Worker a fondo.
 ****************************************************************/

// ============================================================
//  CONFIG
// ============================================================
const STORE_ID = "86f82792-eb98-44fa-ab6f-5c5ab5dd05d3";
const LOYVERSE_API = "https://api.loyverse.com/v1.0";
const PAGE = 250;
const MAX_HIST_API = 31;   // máximo días de recibos que el plan Loyverse entrega por API
const DIAS_VENTANA = 90;   // días de historial que se conservan en ventas_diarias

const VIDA_UTIL_DEFAULT = { dias: 15, tipo: "larga" };
const MOTIVOS_VALIDOS = ["liquidado", "vencido", "dañado", "robo", "consumo_interno", "cambio_proveedor"];

// ============================================================
//  CORS + RESPUESTAS
// ============================================================
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS }
  });
}

// ============================================================
//  HELPERS DE FECHA (mismas convenciones que Codigo.gs)
// ============================================================
function fechaDDMMAAAA() {
  const p = chileNowParts();
  return p.dd + "/" + p.mm + "/" + p.yyyy;
}
function fechaHoraDDMMAAAA() {
  const p = chileNowParts();
  return p.dd + "/" + p.mm + "/" + p.yyyy + " " + p.hh + ":" + p.mi;
}
function parseFechaDDMMAAAA(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s || "").trim());
  if (!m) return null;
  return new Date(+m[3], +m[2] - 1, +m[1]);
}

// ============================================================
//  ZONA HORARIA — Cloudflare Workers corre en UTC, sin huso local
//  (a diferencia de Apps Script, que usa el huso del proyecto,
//  configurado en America/Santiago). Estas funciones traducen
//  "ahora" a la fecha/hora real de Santiago para que los cálculos
//  de días (hoy, ventas 7d/14d/30d, etc.) coincidan con lo que
//  el equipo ve en la tienda.
// ============================================================
function chileTodayISODate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago" }).format(new Date());
}
// Convierte un timestamp UTC de un recibo Loyverse a la fecha (YYYY-MM-DD) real en Santiago —
// NO usar .slice(0,10) sobre el timestamp crudo, eso da la fecha en UTC y desfasa cualquier
// venta hecha después de las ~21:00 hora Chile al día siguiente (Bug reportado desde Finanzas).
function fechaChileDesdeISO(isoUtc) {
  if (!isoUtc) return "";
  const d = new Date(isoUtc);
  if (isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago" }).format(d);
}
// Instante UTC exacto que corresponde a las 00:00 de HOY en Santiago
// (prueba los dos desfaces posibles de Chile, -3 y -4, y usa el que calza)
function chileMidnightUtcISO() {
  const todayStr = chileTodayISODate();
  for (const offset of [3, 4]) {
    const guess = new Date(todayStr + "T00:00:00.000-0" + offset + ":00");
    const backToChile = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago" }).format(guess);
    if (backToChile === todayStr) return guess.toISOString();
  }
  return todayStr + "T04:00:00.000Z";
}
// Componentes de fecha/hora ACTUALES en Santiago (para timestamps DD/MM/AAAA)
function chileNowParts() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(new Date());
  const get = t => parts.find(p => p.type === t).value;
  return { dd: get("day"), mm: get("month"), yyyy: get("year"), hh: get("hour"), mi: get("minute") };
}
function redondeoPsicologico(p) {
  const base = Math.floor(p / 100) * 100;
  const candidatos = [base + 90, base + 50, base + 190, base + 150];
  let best = candidatos[0], bd = Math.abs(candidatos[0] - p);
  candidatos.forEach(c => { const d = Math.abs(c - p); if (d < bd) { bd = d; best = c; } });
  return best;
}

// ============================================================
//  HELPERS D1
// ============================================================
async function q(env, sql, ...params) {
  const stmt = params.length ? env.DB.prepare(sql).bind(...params) : env.DB.prepare(sql);
  const res = await stmt.all();
  return res.results || [];
}
async function qOne(env, sql, ...params) {
  const rows = await q(env, sql, ...params);
  return rows[0] || null;
}
async function run(env, sql, ...params) {
  const stmt = params.length ? env.DB.prepare(sql).bind(...params) : env.DB.prepare(sql);
  return stmt.run();
}
async function logMsg(env, mensaje) {
  try { await run(env, "INSERT INTO logs (mensaje) VALUES (?)", mensaje); } catch (_) {}
}
function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
async function batchRun(env, stmts, size = 400) {
  let changes = 0;
  for (const chunk of chunkArray(stmts, size)) {
    const results = await env.DB.batch(chunk);
    results.forEach(r => { changes += (r.meta && r.meta.changes) || 0; });
  }
  return changes;
}

async function getProducto(env, sku) {
  return qOne(env, "SELECT * FROM productos WHERE sku = ?", String(sku));
}
async function getVentaResumen(env, sku) {
  const hoy = chileTodayISODate();
  return qOne(env,
    `SELECT sku,
       SUM(unidades) AS u_all,
       SUM(CASE WHEN fecha >= date(?, '-7 day')  THEN unidades ELSE 0 END) AS u7,
       SUM(CASE WHEN fecha >= date(?, '-14 day') THEN unidades ELSE 0 END) AS u14,
       SUM(CASE WHEN fecha >= date(?, '-30 day') THEN unidades ELSE 0 END) AS u30,
       SUM(CASE WHEN fecha >= date(?, '-90 day') THEN unidades ELSE 0 END) AS u90,
       SUM(venta) AS rev, SUM(utilidad) AS prof
     FROM ventas_diarias WHERE sku = ? GROUP BY sku`,
    hoy, hoy, hoy, hoy, sku);
}
async function getVentasResumenTodas(env) {
  const hoy = chileTodayISODate();
  return q(env,
    `SELECT sku,
       SUM(unidades) AS u_all,
       SUM(CASE WHEN fecha >= date(?, '-7 day')  THEN unidades ELSE 0 END) AS u7,
       SUM(CASE WHEN fecha >= date(?, '-14 day') THEN unidades ELSE 0 END) AS u14,
       SUM(CASE WHEN fecha >= date(?, '-30 day') THEN unidades ELSE 0 END) AS u30,
       SUM(CASE WHEN fecha >= date(?, '-90 day') THEN unidades ELSE 0 END) AS u90,
       SUM(venta) AS rev, SUM(utilidad) AS prof
     FROM ventas_diarias GROUP BY sku`,
    hoy, hoy, hoy, hoy);
}
async function getVidaUtilTabla(env) {
  const rows = await q(env, "SELECT * FROM config_vida_util");
  const out = {};
  rows.forEach(r => { out[r.categoria] = { dias: r.dias_alerta, tipo: r.tipo, nota: r.nota }; });
  return out;
}
function vidaUtilCat(cat, tabla) {
  return tabla[cat] || VIDA_UTIL_DEFAULT;
}

// Margen promedio real de la categoría (mín. 3 productos comparables)
async function margenPromedioCategoria(env, cat) {
  const rows = await q(env,
    "SELECT costo, precio FROM productos WHERE categoria = ? AND costo > 0 AND precio > 0 AND precio > costo",
    cat);
  if (rows.length < 3) return null;
  const ms = rows.map(r => (r.precio - r.costo) / r.precio);
  return ms.reduce((a, b) => a + b, 0) / ms.length;
}

// ============================================================
//  CÁLCULO DE ESTADO/PRIORIDAD/PRECIO de UN lote (idéntico a Codigo.gs)
// ============================================================
async function calcularLote(env, lote, productoRow, ventaRow, tablaVidaUtil, saltarMargen) {
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const venc = parseFechaDDMMAAAA(lote.fechaVencimiento);
  if (!venc) return { estado: "Vigente", prioridad: "—", accion: "⚠️ Fecha inválida", precioRecomendado: null, costoUsado: 0, costoOrigen: "" };

  const diasRestantes = Math.round((venc - hoy) / 86400000);
  const cfgCat = vidaUtilCat(lote.categoria, tablaVidaUtil);

  const it = productoRow || {};
  const precioActual = it.precio || 0;
  let costoUsado = it.costo || 0, costoOrigen = "real";
  if (!costoUsado) {
    const m = saltarMargen ? null : await margenPromedioCategoria(env, lote.categoria);
    if (m != null) { costoUsado = Math.round(precioActual * (1 - m)); costoOrigen = "estimado"; }
    else costoOrigen = "sin_datos";
  }

  const v = ventaRow || {};
  const ventaDiaria = (v.u30 || 0) / 30;
  const cobertura = ventaDiaria > 0 ? (it.stock || 0) / ventaDiaria : Infinity;
  const acelerar = diasRestantes >= 0 && diasRestantes <= 7 && cobertura > diasRestantes * 1.3;

  let estado, prioridad, accion, descuento = 0;
  if (diasRestantes <= 0) {
    if (cfgCat.tipo === "cambio") { estado = "Vencido"; prioridad = "⚫"; accion = "Vencido — gestionar cambio con proveedor"; descuento = 0; }
    else { estado = "Vencido"; prioridad = "⚫"; accion = "Vencido — retirar y registrar merma"; descuento = 1; }
  } else if (diasRestantes > cfgCat.dias) {
    estado = "Vigente"; prioridad = "—"; accion = "—"; descuento = 0;
  } else if (cfgCat.tipo === "cambio") {
    estado = "Por vencer";
    const diasEnVentana = cfgCat.dias - diasRestantes;
    if (diasEnVentana <= 5) { prioridad = "🟢"; accion = "Gestionar cambio con proveedor"; }
    else if (diasEnVentana <= 15) { prioridad = "🟡"; accion = "Gestionar cambio con proveedor (urgente)"; }
    else { prioridad = "🔴"; accion = "Gestionar cambio con proveedor (muy atrasado)"; }
    descuento = 0;
  } else {
    estado = "Por vencer";
    if (cfgCat.tipo === "corta") {
      if (diasRestantes >= 5) { prioridad = "🟡"; accion = "Reubicar, sin rebaja"; descuento = 0; }
      else if (diasRestantes >= 3) { prioridad = "🟠"; accion = "Rebaja 25%"; descuento = 0.25; }
      else if (diasRestantes >= 1) { prioridad = "🔴"; accion = "Rebaja 45%"; descuento = 0.45; }
      else { prioridad = "⚫"; accion = "Liquidar al costo"; descuento = 1; }
      if (acelerar && descuento < 0.45 && diasRestantes >= 1) {
        prioridad = "🔴"; accion = "Rebaja 45% (acelerado: el stock no alcanza a rotar)"; descuento = 0.45;
      }
    } else {
      const diasEnVentana = cfgCat.dias - diasRestantes;
      if (diasEnVentana <= 1) { prioridad = "🟢"; accion = "Gestionar cambio con proveedor"; descuento = 0; }
      else if (diasEnVentana <= 6) { prioridad = "🟡"; accion = "Rebaja 10%"; descuento = 0.10; }
      else if (diasEnVentana <= 11) { prioridad = "🟠"; accion = "Rebaja 20%"; descuento = 0.20; }
      else { prioridad = "🔴"; accion = "Liquidación 50%"; descuento = 0.50; }
      if (acelerar && descuento < 0.50) {
        prioridad = "🔴"; accion = "Liquidación 50% (acelerado: el stock no alcanza a rotar)"; descuento = 0.50;
      }
    }
  }

  let precioRecomendado = null;
  if (precioActual > 0 && cfgCat.tipo !== "cambio") {
    if (descuento === 0) precioRecomendado = (estado === "Vigente") ? null : precioActual;
    else if (descuento === 1) precioRecomendado = costoUsado || null;
    else precioRecomendado = redondeoPsicologico(Math.max(Math.round(precioActual * (1 - descuento)), costoUsado || 0));
  }

  return { estado, prioridad, accion, precioRecomendado, costoUsado, costoOrigen, diasRestantes };
}

// ============================================================
//  LOYVERSE — ajuste de stock (única llamada usada hoy)
// ============================================================
async function loyversePost(env, endpoint, body) {
  const res = await fetch(LOYVERSE_API + endpoint, {
    method: "POST",
    headers: { "Authorization": "Bearer " + env.LOYVERSE_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(endpoint + " HTTP " + res.status + ": " + (await res.text()).slice(0, 200));
  return res.json();
}

// GET simple (una página) con reintento ante 429/5xx
async function loyverseGet(env, endpoint, params, intento = 0) {
  const qs = new URLSearchParams();
  Object.keys(params || {}).forEach(k => {
    if (params[k] !== null && params[k] !== undefined && params[k] !== "") qs.set(k, params[k]);
  });
  const res = await fetch(LOYVERSE_API + endpoint + "?" + qs.toString(), {
    headers: { "Authorization": "Bearer " + env.LOYVERSE_TOKEN }
  });
  if (res.status === 429 || res.status >= 500) {
    if (intento >= 5) throw new Error(endpoint + " HTTP " + res.status + " tras 5 reintentos");
    await new Promise(r => setTimeout(r, 1500 * (intento + 1)));
    return loyverseGet(env, endpoint, params, intento + 1);
  }
  if (!res.ok) throw new Error(endpoint + " HTTP " + res.status + ": " + (await res.text()).slice(0, 200));
  return res.json();
}

// GET con paginación (equivalente a _getAll de Codigo.gs)
async function loyverseGetAll(env, endpoint, key, extra) {
  let all = [], cursor = null;
  do {
    const params = Object.assign({ limit: PAGE }, extra || {});
    if (cursor) params.cursor = cursor;
    const data = await loyverseGet(env, endpoint, params);
    all = all.concat(data[key] || []);
    cursor = data.cursor || null;
  } while (cursor);
  return all;
}

// Stock fresco de UNA sola variante (para operaciones de escritura seguras)
async function stockFrescoDeVariante(env, vid) {
  try {
    const data = await loyverseGet(env, "/inventory", { store_id: STORE_ID, variant_ids: vid });
    const nivel = (data.inventory_levels || []).find(x => x.variant_id === vid);
    if (nivel) return nivel.in_stock;
  } catch (e) { /* sigue al respaldo */ }
  const inv = await loyverseGetAll(env, "/inventory", "inventory_levels", { store_id: STORE_ID });
  const nivel = inv.find(x => x.variant_id === vid);
  return nivel ? nivel.in_stock : null;
}

// Descuenta stock leyendo el valor FRESCO de Loyverse antes (usado en reversiones,
// donde la seguridad importa más que la velocidad — igual que eliminarLoteVencimiento
// en Codigo.gs).
async function descontarStockFresco(env, productoRow, cantidad) {
  if (!productoRow || !productoRow.track_stock) return { ok: true, motivo: "sin control de stock" };
  if (!productoRow.variant_id) return { ok: false, motivo: "falta variant_id" };
  const stockActual = await stockFrescoDeVariante(env, productoRow.variant_id);
  if (stockActual == null) return { ok: false, motivo: "Loyverse no devolvió inventario para este producto" };
  const nuevoStock = Math.round((stockActual - cantidad) * 1000) / 1000;
  await loyversePost(env, "/inventory", {
    inventory_levels: [{ variant_id: productoRow.variant_id, store_id: STORE_ID, stock_after: nuevoStock }]
  });
  await run(env, "UPDATE productos SET stock = ? WHERE sku = ?", nuevoStock, productoRow.sku);
  return { ok: true, antes: stockActual, despues: nuevoStock };
}

// Descarga recibos entre dos fechas ISO → [{ fecha, ref, uds, venta, prof }]
async function descargarVentas(env, desdeISO, hastaISO) {
  const extra = { created_at_min: desdeISO };
  if (hastaISO) extra.created_at_max = hastaISO;
  const recibos = await loyverseGetAll(env, "/receipts", "receipts", extra);
  const ventas = [];
  recibos.forEach(r => {
    if (r.cancelled_at) return;
    // Bug de zona horaria (reportado desde Finanzas): antes se usaba .slice(0,10) sobre el
    // timestamp UTC crudo, lo que corría al día siguiente cualquier venta después de ~21:00
    // hora Chile. Ahora se convierte explícitamente a la fecha real de Santiago.
    const fecha = fechaChileDesdeISO(r.receipt_date || r.created_at);
    const signo = r.receipt_type === "REFUND" ? -1 : 1;
    (r.line_items || []).forEach(li => {
      // Bug de completitud (reportado desde Finanzas): antes se descartaba en silencio
      // cualquier ítem sin SKU (ventas rápidas/manuales sin producto de catálogo), lo que
      // dejaba el total de ventas_diarias por debajo del "Ventas netas" real de Loyverse.
      // Se conservan bajo un SKU sintético para que el total SIEMPRE cuadre; quedan
      // agrupados aparte y no se les puede atribuir a un producto real del catálogo.
      const ref = li.sku ? String(li.sku) : "__SIN_SKU__";
      ventas.push({
        fecha, ref,
        uds: signo * (li.quantity || 0),
        venta: signo * (li.total_money || 0),
        prof: signo * ((li.gross_total_money || li.total_money || 0) - (li.cost_total || 0))
      });
    });
  });
  return ventas;
}

// Agrupa ventas crudas por fecha+sku y las guarda en ventas_diarias
// (reemplaza los días afectados por completo — evita duplicar boletas)
async function guardarVentasEnD1(env, ventasCrudas) {
  const porDiaSku = {};
  ventasCrudas.forEach(v => {
    const key = v.fecha + "|" + v.ref;
    if (!porDiaSku[key]) porDiaSku[key] = { fecha: v.fecha, sku: v.ref, unidades: 0, venta: 0, utilidad: 0 };
    porDiaSku[key].unidades += v.uds;
    porDiaSku[key].venta += v.venta;
    porDiaSku[key].utilidad += v.prof;
  });
  const fechasAfectadas = [...new Set(ventasCrudas.map(v => v.fecha))].filter(Boolean);
  if (fechasAfectadas.length) {
    const delStmts = fechasAfectadas.map(f => env.DB.prepare("DELETE FROM ventas_diarias WHERE fecha = ?").bind(f));
    await batchRun(env, delStmts);
  }
  const filas = Object.values(porDiaSku);
  const insStmts = filas.map(f => env.DB.prepare(
    "INSERT INTO ventas_diarias (fecha, sku, unidades, venta, utilidad) VALUES (?,?,?,?,?)"
  ).bind(f.fecha, f.sku, Math.round(f.unidades * 10) / 10, Math.round(f.venta), Math.round(f.utilidad)));
  await batchRun(env, insStmts);// ===== NUEVO: espejo sin purga, para historial multi-año del Panel financiero =====
  const histStmts = filas.map(f => env.DB.prepare(
    `INSERT INTO ventas_diarias_historico (fecha, sku, unidades, venta, utilidad) VALUES (?,?,?,?,?)
     ON CONFLICT(fecha, sku) DO UPDATE SET
       unidades=excluded.unidades, venta=excluded.venta, utilidad=excluded.utilidad`
  ).bind(f.fecha, f.sku, Math.round(f.unidades * 10) / 10, Math.round(f.venta), Math.round(f.utilidad)));
  await batchRun(env, histStmts, 500);
  // ===== FIN NUEVO =====

  // purga días fuera de la ventana de retención
  const corte = new Date(new Date(chileMidnightUtcISO()).getTime() - DIAS_VENTANA * 86400000).toISOString().slice(0, 10);
  await run(env, "DELETE FROM ventas_diarias WHERE fecha < ?", corte);
  return { dias: fechasAfectadas.length, filas: filas.length };
}

// ---- SYNC RÁPIDO: solo stock (todas las variantes) + ventas de HOY ----
async function refreshInventoryStock(env) {
  const inv = await loyverseGetAll(env, "/inventory", "inventory_levels", { store_id: STORE_ID });
  const stmts = inv.map(x => env.DB.prepare("UPDATE productos SET stock = ? WHERE variant_id = ?").bind(x.in_stock, x.variant_id));
  return batchRun(env, stmts);
}

// ---- SYNC COMPLETO: catálogo entero (nombre/categoría/costo/precio/stock/barcode) ----
async function refreshFullCatalog(env) {
  const [items, cats, inv] = await Promise.all([
    loyverseGetAll(env, "/items", "items"),
    loyverseGetAll(env, "/categories", "categories"),
    loyverseGetAll(env, "/inventory", "inventory_levels", { store_id: STORE_ID })
  ]);
  const catMap = {}; cats.forEach(c => { catMap[c.id] = c.name; });
  const stockMap = {}; inv.forEach(x => { stockMap[x.variant_id] = x.in_stock; });

  const prodStmts = [], vmapStmts = [];
  const saltados = []; // diagnóstico: productos que Loyverse devolvió pero el sync no pudo guardar
  items.forEach(it => {
    const v = (it.variants && it.variants[0]) ? it.variants[0] : null;
    if (!v || !v.sku) {
      saltados.push((it.item_name || "(sin nombre)") + " — " + (!v ? "sin variante" : "SKU vacío en Loyverse"));
      return;
    }
    let precio = v.default_price;
    if (v.stores && v.stores[0] && v.stores[0].price != null) precio = v.stores[0].price;
    const stock = stockMap[v.variant_id] != null ? stockMap[v.variant_id] : null;
    const peso = !!(it.sold_by_weight || it.soldByWeight);

    prodStmts.push(env.DB.prepare(
      `INSERT INTO productos (sku, id_loyverse, variant_id, nombre, categoria, costo, precio, stock, track_stock, barcode, sold_by_weight, fecha_creacion, imagen_url, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))
       ON CONFLICT(sku) DO UPDATE SET
         id_loyverse=excluded.id_loyverse, variant_id=excluded.variant_id, nombre=excluded.nombre,
         categoria=excluded.categoria, costo=excluded.costo, precio=excluded.precio, stock=excluded.stock,
         track_stock=excluded.track_stock, barcode=excluded.barcode, sold_by_weight=excluded.sold_by_weight,
         fecha_creacion=excluded.fecha_creacion, imagen_url=excluded.imagen_url, updated_at=datetime('now')`
    ).bind(v.sku, it.id, v.variant_id, it.item_name, catMap[it.category_id] || "SIN CATEGORÍA",
      v.cost || 0, precio || 0, stock, it.track_stock ? 1 : 0, v.barcode || "", peso ? 1 : 0,
      (it.created_at || "").slice(0, 10) || null, it.image_url || null));

    vmapStmts.push(env.DB.prepare(
      `INSERT INTO variant_map (variant_id, sku) VALUES (?,?)
       ON CONFLICT(variant_id) DO UPDATE SET sku=excluded.sku`
    ).bind(v.variant_id, v.sku));
  });

  await batchRun(env, prodStmts, 500);
  await batchRun(env, vmapStmts, 1000);
  if (saltados.length) {
    await logMsg(env, "⚠️ Catálogo completo: " + saltados.length + " producto(s) de Loyverse NO se pudieron guardar (revisar SKU en Loyverse) — " + saltados.slice(0, 15).join(" · ") + (saltados.length > 15 ? " · …" : ""));
  }
  return prodStmts.length;
}

// ---- Ventas de HOY: siempre se refresca completo (no incremental, más simple y seguro en Workers) ----
async function syncVentasHoy(env) {
  const ventas = await descargarVentas(env, chileMidnightUtcISO(), null);
  const r = await guardarVentasEnD1(env, ventas);
  return r.filas;
}

// ---- Recarga el histórico completo permitido por el plan Loyverse (31 días) ----
async function recargarHistorial(env) {
  const hoy0iso = chileMidnightUtcISO();
  // Loyverse rechaza (HTTP 402) cualquier "desde" más antiguo que MAX_HIST_API días respecto
  // al INSTANTE actual — no respecto a la medianoche de Chile. Restar los días desde medianoche
  // puede quedar varias horas más atrás del límite real (según la hora del día en que corra el
  // sync) y Loyverse lo rechaza. Se calcula desde el instante actual (Date.now()) con 1 día de
  // margen de seguridad, para no pisar el límite justo por errores de redondeo/latencia.
  const desde = new Date(Date.now() - (MAX_HIST_API - 1) * 86400000);
  const ventas = await descargarVentas(env, desde.toISOString(), hoy0iso);
  return guardarVentasEnD1(env, ventas);
}

// ---- Recalcula estado/prioridad/acción de todos los lotes activos ----
async function recalcularVencimientosD1(env) {
  const rows = await q(env, "SELECT * FROM vencimientos WHERE estado NOT IN ('Revisado','Retirado') AND sku IS NOT NULL");
  if (!rows.length) return 0;
  // Precarga TODO de una vez (2 consultas) en vez de 2 por lote — evita el límite de subrequests
  const [prodRows, ventaRows, tablaVidaUtil] = await Promise.all([
    q(env, "SELECT * FROM productos"),
    getVentasResumenTodas(env),
    getVidaUtilTabla(env)
  ]);
  const prodMap = {}; prodRows.forEach(p => { prodMap[p.sku] = p; });
  const ventaMap = {}; ventaRows.forEach(v => { ventaMap[v.sku] = v; });

  const stmts = [];
  for (const row of rows) {
    const calc = await calcularLoteSync(row.categoria, row.fecha_vencimiento, prodMap[row.sku], ventaMap[row.sku], tablaVidaUtil);
    stmts.push(env.DB.prepare(
      "UPDATE vencimientos SET estado=?, prioridad=?, accion=?, precio_recomendado=?, costo_usado=?, costo_origen=? WHERE id=?"
    ).bind(calc.estado, calc.prioridad, calc.accion, calc.precioRecomendado || null, calc.costoUsado || null, calc.costoOrigen, row.id));
  }
  await batchRun(env, stmts, 100);
  return stmts.length;
}

// Variante de calcularLote SIN llamadas a D1 (recibe todo precargado) — usada
// por recalcularVencimientosD1 para evitar 1 consulta de margen por lote.
async function calcularLoteSync(categoria, fechaVencimiento, productoRow, ventaRow, tablaVidaUtil) {
  return calcularLote(null, { sku: null, categoria, fechaVencimiento }, productoRow, ventaRow, tablaVidaUtil, true);
}

// Descuenta stock usando el valor de caché (snapshot) — no lee Loyverse antes.
async function descontarStockCache(env, productoRow, cantidad) {
  if (!productoRow || !productoRow.track_stock) return { ok: true, motivo: "sin control de stock" };
  if (!productoRow.variant_id) return { ok: false, motivo: "falta variant_id" };
  const stockActual = productoRow.stock != null ? productoRow.stock : 0;
  const nuevoStock = Math.round((Math.max(0, stockActual) - cantidad) * 1000) / 1000;
  await loyversePost(env, "/inventory", {
    inventory_levels: [{ variant_id: productoRow.variant_id, store_id: STORE_ID, stock_after: nuevoStock }]
  });
  await run(env, "UPDATE productos SET stock = ? WHERE sku = ?", nuevoStock, productoRow.sku);
  return { ok: true, antes: stockActual, despues: nuevoStock };
}

// Suma stock usando el valor de caché (recepción de mercadería)
async function sumarStockCache(env, productoRow, cantidad) {
  if (!productoRow || !productoRow.track_stock) return { ok: true, motivo: "sin control de stock" };
  if (!productoRow.variant_id) return { ok: false, motivo: "falta variant_id" };
  const stockActual = productoRow.stock != null ? productoRow.stock : 0;
  const base = Math.max(0, stockActual);
  const nuevoStock = Math.round((base + cantidad) * 1000) / 1000;
  await loyversePost(env, "/inventory", {
    inventory_levels: [{ variant_id: productoRow.variant_id, store_id: STORE_ID, stock_after: nuevoStock }]
  });
  await run(env, "UPDATE productos SET stock = ? WHERE sku = ?", nuevoStock, productoRow.sku);
  return { ok: true, antes: stockActual, despues: nuevoStock };
}

// ============================================================
//  GET — REPORTES DE SOLO LECTURA
// ============================================================
async function repSinCosto(env) {
  const rows = await q(env, "SELECT sku, nombre, categoria, sold_by_weight FROM productos WHERE track_stock = 1 AND (costo IS NULL OR costo = 0)");
  const items = rows.map(r => ({ ref: r.sku, nombre: r.nombre, prov: r.categoria, peso: !!r.sold_by_weight }));
  items.sort((a, b) => (b.peso - a.peso) || String(a.nombre).localeCompare(String(b.nombre)));
  return { total: items.length, porPeso: items.filter(x => x.peso).length, items };
}

// Normaliza texto en el Worker igual que el frontend (sin tildes/mayúsculas) — usado para
// detectar categorías duplicadas antes de crear una nueva.
function normTxtServer(s) { return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }

// FASE 5 — Catálogo para el formulario "Crear producto": categorías + impuestos, leídos en vivo de Loyverse.
async function repCatalogoCrear(env) {
  const [cats, taxes] = await Promise.all([
    loyverseGetAll(env, "/categories", "categories"),
    loyverseGetAll(env, "/taxes", "taxes")
  ]);
  return {
    categorias: cats.map(c => ({ id: c.id, name: c.name })),
    impuestos: taxes.map(t => ({ id: t.id, name: t.name, rate: t.rate }))
  };
}

// Proveedores extra por producto — permite que un mismo sku (registrado UNA sola vez en
// Loyverse) aparezca también al filtrar por otro proveedor en Pedidos, sin duplicar el
// producto ni su stock. "proveedor" usa el mismo texto que productos.categoria (el "prov"
// que ya se muestra en toda la app), no la tabla normalizada `proveedores`/`proveedor_id`
// (esa es de otro sistema — clasificación/sector — y no se toca acá).
let _tablaProdProvOk = false;
async function asegurarTablaProductoProveedores(env) {
  if (_tablaProdProvOk) return;
  await run(env, "CREATE TABLE IF NOT EXISTS producto_proveedores (sku TEXT NOT NULL, proveedor TEXT NOT NULL, PRIMARY KEY(sku, proveedor))");
  _tablaProdProvOk = true;
}
async function accionAgregarProveedorExtra(env, payload) {
  await asegurarTablaProductoProveedores(env);
  const sku = String((payload && payload.sku) || "");
  const proveedor = String((payload && payload.proveedor) || "").trim();
  if (!sku || !proveedor) throw new Error("Falta sku o proveedor");
  const prod = await getProducto(env, sku);
  if (!prod) throw new Error("SKU no encontrado en el catálogo: " + sku);
  if (proveedor === prod.categoria) throw new Error("Ese ya es el proveedor principal del producto");
  await run(env, "INSERT OR IGNORE INTO producto_proveedores (sku, proveedor) VALUES (?,?)", sku, proveedor);
  await logMsg(env, "🔁 Proveedor extra agregado: " + prod.nombre + " → también en " + proveedor);
  return { ok: true, sku, proveedor };
}
async function accionQuitarProveedorExtra(env, payload) {
  await asegurarTablaProductoProveedores(env);
  const sku = String((payload && payload.sku) || "");
  const proveedor = String((payload && payload.proveedor) || "").trim();
  await run(env, "DELETE FROM producto_proveedores WHERE sku = ? AND proveedor = ?", sku, proveedor);
  return { ok: true, sku, proveedor };
}

async function repFichaProducto(env, sku) {
  const producto = await getProducto(env, sku);
  if (!producto) throw new Error("SKU no encontrado en el catálogo: " + sku);
  const venta = await getVentaResumen(env, sku);

  const lotes = await q(env, "SELECT * FROM vencimientos WHERE sku = ? ORDER BY fecha_vencimiento ASC", sku);
  const ordenPrio = { "⚫": 0, "🔴": 1, "🟠": 2, "🟡": 3, "🟢": 4, "—": 5 };
  const lotesActivos = lotes.filter(l => l.estado !== "Revisado")
    .sort((a, b) => (ordenPrio[a.prioridad] ?? 9) - (ordenPrio[b.prioridad] ?? 9));

  const mermas = await q(env, "SELECT * FROM mermas WHERE sku = ? ORDER BY id DESC LIMIT 20", sku);
  const auditoria = await q(env, "SELECT * FROM auditoria WHERE sku = ? ORDER BY id DESC LIMIT 30", sku);
  const historialPrecios = await q(env, "SELECT * FROM historial_precios WHERE sku = ? ORDER BY id DESC LIMIT 20", sku);

  // "Última modificación" real = el movimiento más reciente registrado para este SKU
  // (mermas, lotes, reconteos, activaciones de seguimiento) — no la hora del último sync general.
  const fechasCandidatas = [];
  if (auditoria[0]) fechasCandidatas.push(auditoria[0].fecha);
  if (mermas[0]) fechasCandidatas.push(mermas[0].fecha);
  if (lotes[0]) fechasCandidatas.push(lotes[0].fecha_ingreso);
  const ultimaModificacion = fechasCandidatas.sort((a, b) => {
    const da = parseFechaDDMMAAAA((a || "").slice(0, 10)), db = parseFechaDDMMAAAA((b || "").slice(0, 10));
    return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
  })[0] || null;

  const proveedor = producto.proveedor_id
    ? await qOne(env, "SELECT id, nombre FROM proveedores WHERE id = ?", producto.proveedor_id)
    : null;
  await asegurarTablaProductoProveedores(env);
  const proveedoresExtraRows = await q(env, "SELECT proveedor FROM producto_proveedores WHERE sku = ?", sku);

  return {
    producto: {
      sku: producto.sku, nombre: producto.nombre, categoria: producto.categoria,
      barcode: producto.barcode, costo: producto.costo, precio: producto.precio,
      margen: producto.precio > 0 ? Math.round((1 - producto.costo / producto.precio) * 100) : null,
      stock: producto.stock, trackStock: !!producto.track_stock, soldByWeight: !!producto.sold_by_weight,
      descripcion: producto.descripcion || "", idLoyverse: producto.id_loyverse || "",
      proveedorId: producto.proveedor_id || null, proveedor: proveedor ? proveedor.nombre : null,
      sector: producto.sector || null,
      proveedoresExtra: proveedoresExtraRows.map(r => r.proveedor),
      ultimaModificacion
    },
    ventas: venta ? { u7: venta.u7, u14: venta.u14, u30: venta.u30, u90: venta.u90, rev: Math.round(venta.rev), prof: Math.round(venta.prof) } : null,
    lotes: lotesActivos.map(l => ({
      filaIndex: l.id, lote: l.lote, cantidad: l.cantidad, fechaVencimiento: l.fecha_vencimiento,
      estado: l.estado, prioridad: l.prioridad, accion: l.accion, precioRecomendado: l.precio_recomendado
    })),
    mermasRecientes: mermas.map(m => ({ fecha: m.fecha, cantidad: m.cantidad, motivo: m.motivo, costoTotal: m.costo_total, responsable: m.responsable })),
    movimientos: auditoria.map(a => ({ fecha: a.fecha, accion: a.accion, stock: a.stock, motivo: a.motivo, responsable: a.responsable })),
    historialPrecios: historialPrecios.map(h => ({
      fecha: h.fecha, precioAntes: h.precio_antes, precioDespues: h.precio_despues,
      costoAntes: h.costo_antes, costoDespues: h.costo_despues, responsable: h.responsable
    }))
  };
}

async function repVencimientosActivos(env) {
  const rows = await q(env, "SELECT * FROM vencimientos WHERE estado != 'Revisado' AND sku IS NOT NULL");
  const orden = { "⚫": 0, "🔴": 1, "🟠": 2, "🟡": 3, "🟢": 4, "—": 5 };
  const out = rows.map(r => ({
    filaIndex: r.id, sku: r.sku, nombre: r.producto, categoria: r.categoria, unidad: r.unidad,
    lote: r.lote, cantidad: r.cantidad, fechaVencimiento: r.fecha_vencimiento, estado: r.estado,
    prioridad: r.prioridad, accion: r.accion, precioRecomendado: r.precio_recomendado || null,
    costoUsado: r.costo_usado || null, costoOrigen: r.costo_origen
  }));
  out.sort((a, b) => (orden[a.prioridad] ?? 9) - (orden[b.prioridad] ?? 9));
  return out;
}

async function repHistorialMermas(env, limite = 50) {
  const rows = await q(env, "SELECT * FROM mermas ORDER BY id DESC LIMIT ?", limite);
  const totalRow = await qOne(env, "SELECT COUNT(*) AS n, SUM(costo_total) AS suma FROM mermas");
  const items = rows.map(r => ({
    filaIndex: r.id, fecha: r.fecha, sku: r.sku, nombre: r.producto, categoria: r.categoria,
    unidad: r.unidad, lote: r.lote, cantidad: r.cantidad, costoUnitario: r.costo_unitario,
    costoTotal: r.costo_total, motivo: r.motivo, estadoCosto: r.estado_costo,
    responsable: r.responsable, origen: r.origen
  }));
  return { total: totalRow.n || 0, sumaCostoTotal: Math.round(totalRow.suma || 0), items };
}

async function repCategoriasCambio(env) {
  const rows = await q(env, "SELECT categoria FROM config_vida_util WHERE tipo = 'cambio'");
  return rows.map(r => r.categoria);
}

async function repLlegadasPendientes(env) {
  const rows = await q(env, "SELECT * FROM llegadas WHERE estado = 'pendiente' ORDER BY aumento DESC");
  return rows.map(r => ({
    filaIndex: r.id, fecha: r.fecha_deteccion, sku: r.sku, nombre: r.producto, categoria: r.categoria,
    stockAntes: r.stock_antes, stockDespues: r.stock_despues, aumento: r.aumento
  }));
}

async function repConsumoCategoria(env, dias = 30) {
  const rows = await q(env, "SELECT categoria, fecha, costo_total FROM mermas WHERE motivo = 'consumo_interno'");
  const corte = Date.now() - dias * 86400000;
  const cats = {};
  rows.forEach(r => {
    const f = parseFechaDDMMAAAA(r.fecha);
    if (!f || f.getTime() < corte) return;
    const cat = r.categoria || "SIN CATEGORÍA";
    cats[cat] = (cats[cat] || 0) + (Number(r.costo_total) || 0);
  });
  const arr = Object.keys(cats).map(c => ({ categoria: c, total: Math.round(cats[c]) })).sort((a, b) => b.total - a.total);
  const total = arr.reduce((s, x) => s + x.total, 0);
  return { total, dias, cats: arr };
}

// Payload principal del dashboard: items + ventas (formato idéntico al de Apps Script)
async function payloadDashboard(env, synced, syncMsg) {
  const productos = await q(env, "SELECT * FROM productos");
  const itemsRows = {};
  productos.forEach(p => {
    itemsRows[p.sku] = {
      id: p.id_loyverse, vid: p.variant_id || "", ref: p.sku, nombre: p.nombre,
      prov: p.categoria || "SIN CATEGORÍA", costo: p.costo || 0, precio: p.precio || 0,
      stock: p.stock, track: !!p.track_stock, barcode: p.barcode || "", peso: !!p.sold_by_weight,
      creado: p.fecha_creacion || null, descripcion: p.descripcion || "", imagen: p.imagen_url || ""
    };
  });

  const resumen = await getVentasResumenTodas(env);
  const ventasRows = {};
  resumen.forEach(r => {
    ventasRows[r.sku] = {
      ref: r.sku, u_all: r.u_all, u7: r.u7, u14: r.u14, u30: r.u30, u90: r.u90,
      rev: Math.round(r.rev), prof: Math.round(r.prof)
    };
  });

  const hoyISO = chileTodayISODate();
  const ventasHoyRows = await q(env, "SELECT sku FROM ventas_diarias WHERE fecha = ?", hoyISO);
  const hoyRowsObj = {};
  ventasHoyRows.forEach(r => { hoyRowsObj[r.sku] = 1; });

  // Pedidos pendientes (ver asegurarTablaPedidosPendientes) — se manda siempre junto al resto
  // del dashboard para que el frontend pueda avisar "ya pedido" sin una consulta extra por
  // producto. Si la tabla o la consulta fallan por lo que sea, el dashboard sigue funcionando
  // igual, solo sin avisos de duplicado esta vez.
  let pendientesRows = [];
  try {
    await asegurarTablaPedidosPendientes(env);
    pendientesRows = await q(env, "SELECT sku, barcode, nombre, proveedor, cantidad, canal, fecha FROM pedidos_pendientes");
  } catch (err) { await logMsg(env, "⚠️ No se pudieron leer pedidos_pendientes: " + err.message); }

  // Proveedores extra (Opción A: un solo sku en Loyverse, visible también bajo otros
  // proveedores en Pedidos) — mapa sku → [proveedor,...] para que itemsFor() del frontend
  // pueda incluir el producto sin duplicarlo ni tocar sus ventas/stock.
  let provsExtraObj = {};
  try {
    await asegurarTablaProductoProveedores(env);
    const provsExtraRows = await q(env, "SELECT sku, proveedor FROM producto_proveedores");
    provsExtraRows.forEach(r => { (provsExtraObj[r.sku] = provsExtraObj[r.sku] || []).push(r.proveedor); });
  } catch (err) { await logMsg(env, "⚠️ No se pudo leer producto_proveedores: " + err.message); }

  return {
    ok: true,
    version: "v2",
    synced: !!synced,
    syncMsg: syncMsg || "",
    ventasHoy: ventasHoyRows.length,
    items: { rows: itemsRows },
    ventas: { rows: ventasRows, hoy: { fecha: hoyISO, rows: hoyRowsObj } },
    pendientes: { rows: pendientesRows },
    provsExtra: provsExtraObj,
    serverTime: new Date().toISOString()
  };
}

// ============================================================
//  POST — ESCRITURA
// ============================================================

// registrar merma (usa snapshot del frontend si viene, igual que Apps Script)
// Columnas nuevas de vencimientos (motivo_cierre/fecha_retiro/merma_id) — migración perezosa,
// igual patrón que las tablas nuevas (asegurarTablaPendientes, etc). SQLite no soporta
// "ADD COLUMN IF NOT EXISTS", así que se intenta y se ignora el error si ya existe (a partir
// del segundo request en el mismo isolate ya ni siquiera se intenta, por el flag en memoria).
let _vencColumnasOk = false;
async function asegurarColumnasVencimientos(env) {
  if (_vencColumnasOk) return;
  const alters = [
    "ALTER TABLE vencimientos ADD COLUMN motivo_cierre TEXT",
    "ALTER TABLE vencimientos ADD COLUMN fecha_retiro TEXT",
    "ALTER TABLE vencimientos ADD COLUMN merma_id INTEGER",
    "ALTER TABLE vencimientos ADD COLUMN monto_descuento REAL"
  ];
  for (const sql of alters) {
    try { await run(env, sql); } catch (e) { /* columna ya existe — normal salvo la primera vez */ }
  }
  _vencColumnasOk = true;
}

async function accionMerma(env, payload) {
  payload = payload || {};
  let it;
  if (payload.snap && payload.snap.id) {
    it = {
      sku: payload.sku, id_loyverse: payload.snap.id, variant_id: payload.snap.vid,
      nombre: payload.snap.nombre, categoria: payload.snap.prov, sold_by_weight: payload.snap.peso ? 1 : 0,
      precio: payload.snap.precio, costo: payload.snap.costo, stock: payload.snap.stock,
      track_stock: payload.snap.track !== false ? 1 : 0, barcode: payload.snap.barcode || ""
    };
  } else {
    it = await getProducto(env, payload.sku);
    if (!it) throw new Error("SKU no encontrado en el catálogo: " + payload.sku);
  }

  const cantidad = Number(payload.cantidad);
  if (!cantidad || cantidad <= 0) throw new Error("Cantidad inválida para " + (it.nombre || payload.sku));

  const unidad = it.sold_by_weight ? "kg" : "un";
  let costoUnit = it.costo || 0, estadoCosto = "OK";
  if (!costoUnit) {
    const manual = Number(payload.costoManual);
    if (manual > 0) { costoUnit = manual; estadoCosto = "OK (manual)"; }
    else { costoUnit = 0; estadoCosto = "⚠️ SIN COSTO"; }
  }
  const costoTotal = Math.round(cantidad * costoUnit);
  const motivoOk = MOTIVOS_VALIDOS.includes(payload.motivo) ? payload.motivo : "otro";
  const origenOk = payload.origen === "vencimiento" ? "vencimiento" : "manual";
  const fecha = fechaDDMMAAAA();

  const insertRes = await run(env,
    `INSERT INTO mermas (fecha, sku, producto, categoria, unidad, lote, cantidad, costo_unitario, costo_total, motivo, estado_costo, responsable, origen)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    fecha, payload.sku, it.nombre, it.categoria, unidad, payload.lote || "", cantidad,
    costoUnit, costoTotal, motivoOk, estadoCosto, payload.responsable || "", origenOk);

  await logMsg(env, "🗑️ Merma registrada: " + it.nombre + " · " + cantidad + unidad + " · $" + costoTotal);

  const out = {
    filaIndex: insertRes.meta.last_row_id,
    fecha, sku: payload.sku, nombre: it.nombre, categoria: it.categoria, unidad,
    lote: payload.lote || "", cantidad, costoUnitario: costoUnit, costoTotal,
    motivo: motivoOk, estadoCosto, responsable: payload.responsable || "", origen: origenOk
  };

  try {
    const res = await descontarStockCache(env, it, cantidad);
    if (res.ok && res.antes != null) {
      out.nuevoStock = res.despues;
      await logMsg(env, "📉 Stock descontado: " + it.nombre + " · " + res.antes + " → " + res.despues);
    } else if (!res.ok) {
      out.avisoStock = "⚠️ No se pudo descontar el stock en Loyverse (" + res.motivo + "). Revísalo a mano.";
    } else {
      out.nuevoStock = null;
    }
  } catch (e) {
    out.avisoStock = "⚠️ No se pudo descontar el stock en Loyverse. Revísalo a mano.";
    await logMsg(env, "⚠️ Error al descontar stock (" + it.nombre + "): " + e.message);
  }

  // Si esta merma viene de "Es merma" en Vencimientos (vcRender → mmPrefill), el lote ya
  // quedó cerrado en accionRevisarLote(resultado:'merma') — acá solo guardamos la referencia
  // a la merma real para poder trazar Vencimiento→Merma. No crítico: si falla, la merma ya
  // quedó guardada igual, solo no se podrá seguir el hilo desde el lote.
  if (payload.vencFilaIndex) {
    try {
      await asegurarColumnasVencimientos(env);
      await run(env, "UPDATE vencimientos SET merma_id = ? WHERE id = ?", insertRes.meta.last_row_id, Number(payload.vencFilaIndex));
    } catch (e) { await logMsg(env, "⚠️ No se pudo enlazar merma con el lote de vencimiento: " + e.message); }
  }

  return out;
}

async function accionLoteNuevo(env, payload) {
  payload = payload || {};
  let it;
  if (payload.snap && payload.snap.vid && payload.snap.id) {
    it = {
      sku: payload.sku, id_loyverse: payload.snap.id, variant_id: payload.snap.vid,
      nombre: payload.snap.nombre, categoria: payload.snap.prov, sold_by_weight: payload.snap.peso ? 1 : 0,
      precio: payload.snap.precio, costo: payload.snap.costo, stock: payload.snap.stock,
      track_stock: payload.snap.track !== false ? 1 : 0, barcode: payload.snap.barcode || ""
    };
  } else {
    it = await getProducto(env, payload.sku);
    if (!it) throw new Error("SKU no encontrado en el catálogo: " + payload.sku);
  }

  const cantidad = Number(payload.cantidad);
  if (!cantidad || cantidad <= 0) throw new Error("Cantidad inválida");

  const fechaTxt = String(payload.fechaVencimiento || "").trim();
  const tieneFecha = fechaTxt !== "";
  if (tieneFecha && !parseFechaDDMMAAAA(fechaTxt)) throw new Error("Fecha de vencimiento inválida (usa DD/MM/AAAA)");

  const unidad = it.sold_by_weight ? "kg" : "un";
  let calc;
  if (tieneFecha) {
    const tablaVidaUtil = await getVidaUtilTabla(env);
    calc = await calcularLote(env, { sku: payload.sku, categoria: it.categoria, fechaVencimiento: fechaTxt }, it, null, tablaVidaUtil);
  } else {
    calc = { estado: "Sin fecha", prioridad: "—", accion: "Sin vencimiento", precioRecomendado: "", costoUsado: "", costoOrigen: "" };
  }

  const fechaIngreso = fechaDDMMAAAA();
  const insertRes = await run(env,
    `INSERT INTO vencimientos (fecha_ingreso, sku, producto, categoria, unidad, lote, cantidad, fecha_vencimiento, estado, prioridad, accion, precio_recomendado, costo_usado, costo_origen, fecha_revision, revisado_por)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    fechaIngreso, payload.sku, it.nombre, it.categoria, unidad, payload.lote || "", cantidad,
    fechaTxt, calc.estado, calc.prioridad, calc.accion, calc.precioRecomendado || null,
    calc.costoUsado || null, calc.costoOrigen, "", "");

  await logMsg(env, "📅 Lote registrado: " + it.nombre + " · vence " + fechaTxt + " · " + calc.estado);

  const out = {
    filaIndex: insertRes.meta.last_row_id, fecha: fechaIngreso, sku: payload.sku, nombre: it.nombre,
    categoria: it.categoria, unidad, lote: payload.lote || "", cantidad, fechaVencimiento: fechaTxt,
    estado: calc.estado, prioridad: calc.prioridad, accion: calc.accion,
    precioRecomendado: calc.precioRecomendado || "", costoUsado: calc.costoUsado || "", costoOrigen: calc.costoOrigen,
    nuevoStock: null
  };

  try {
    const res = await sumarStockCache(env, it, cantidad);
    if (res.ok && res.antes != null) {
      out.nuevoStock = res.despues;
      await logMsg(env, "📈 Stock sumado: " + it.nombre + " · " + res.antes + " → " + res.despues);
    } else if (!res.ok) {
      out.avisoStock = "⚠️ No se pudo sumar el stock en Loyverse (" + res.motivo + "). Revísalo a mano.";
    }
  } catch (e) {
    out.avisoStock = "⚠️ No se pudo sumar el stock en Loyverse. Revísalo a mano.";
    await logMsg(env, "⚠️ Error al sumar stock (" + it.nombre + "): " + e.message);
  }

  // Costo y/o precio (opcional al recibir mercadería): se aplican en Loyverse con el mismo
  // patrón seguro ya usado en la Ficha del producto (leer completo → cambiar la variante →
  // reenviar → verificar). No crea artículos nuevos, solo actualiza el existente por su
  // variant_id/id_loyverse reales — nunca duplica la solicitud de stock hecha arriba.
  const precioNuevo = payload.precio != null && payload.precio !== "" ? Number(payload.precio) : null;
  const costoNuevo = payload.costo != null && payload.costo !== "" ? Number(payload.costo) : null;
  if (precioNuevo != null || costoNuevo != null) {
    if (!it.id_loyverse || !it.variant_id) {
      out.avisoStock = (out.avisoStock ? out.avisoStock + " " : "") +
        "⚠️ No se pudo actualizar costo/precio: falta id de Loyverse — toca ♻️ Catálogo y vuelve a intentar.";
    } else {
      try {
        await actualizarPrecioCostoLoyverse(env, it.id_loyverse, it.variant_id, precioNuevo, costoNuevo);
        const sets = [], vals = [];
        if (precioNuevo != null) { sets.push("precio = ?"); vals.push(precioNuevo); }
        if (costoNuevo != null) { sets.push("costo = ?"); vals.push(costoNuevo); }
        vals.push(payload.sku);
        await run(env, "UPDATE productos SET " + sets.join(", ") + " WHERE sku = ?", ...vals);
        await run(env,
          `INSERT INTO historial_precios (sku, fecha, precio_antes, precio_despues, costo_antes, costo_despues, responsable)
           VALUES (?,?,?,?,?,?,?)`,
          payload.sku, fechaHoraDDMMAAAA(), it.precio, precioNuevo != null ? precioNuevo : it.precio,
          it.costo, costoNuevo != null ? costoNuevo : it.costo, payload.responsable || "");
        out.precioAplicado = precioNuevo != null ? precioNuevo : it.precio;
        out.costoAplicado = costoNuevo != null ? costoNuevo : it.costo;
        await logMsg(env, "💲 Costo/precio actualizado al recibir mercadería: " + it.nombre + " (" + payload.sku + ")");
      } catch (e) {
        out.avisoStock = (out.avisoStock ? out.avisoStock + " " : "") +
          "⚠️ Costo/precio no se pudo actualizar en Loyverse (" + e.message + "). Se guardó el resto de la recepción igual.";
        await logMsg(env, "⚠️ Error al actualizar costo/precio en recepción (" + it.nombre + "): " + e.message);
      }
    }
  }

  // Ya llegó: saca este producto de "pedidos pendientes" para que vuelva a estar disponible
  // para pedir. Si comparte código de barras con otro sku (mismo artículo, otro proveedor),
  // borra también ese aviso — la mercadería ya está en la tienda sin importar bajo qué sku
  // quedó registrada la recepción. No es crítico: si falla, el aviso se limpia solo en la
  // próxima recepción de este producto.
  try {
    await asegurarTablaPedidosPendientes(env);
    if (it.barcode) {
      await run(env, "DELETE FROM pedidos_pendientes WHERE sku = ? OR (barcode != '' AND barcode = ?)", payload.sku, it.barcode);
    } else {
      await run(env, "DELETE FROM pedidos_pendientes WHERE sku = ?", payload.sku);
    }
  } catch (e) { await logMsg(env, "⚠️ No se pudo limpiar pedidos_pendientes al recibir " + it.nombre + ": " + e.message); }

  return out;
}

// El frontend ya mandaba `resultado` ("retirado" | "vendido" | "merma") desde hace tiempo,
// pero esta función lo ignoraba y siempre grababa 'Revisado' — el estado FINAL, que saca el
// lote de la lista de pendientes y de RETIRADOS_POR_SKU. Por eso "Retirar de góndola" hacía
// que el producto volviera a aparecer con stock disponible en Armar pedido, en vez de quedar
// en el estado intermedio "Pendiente de cambio" hasta que el proveedor lo retire/cambie.
// 'retirado' → estado intermedio 'Retirado' (sigue restado del stock disponible, sigue
//              apareciendo en "Armar pedido" como cambio pendiente — ver analyze() en el front).
// cualquier otro resultado ('vendido', 'merma', etc.) → 'Revisado', el cierre final de siempre.
async function accionRevisarLote(env, payload) {
  await asegurarColumnasVencimientos(env);
  const fi = Number(payload.filaIndex);
  const row = await qOne(env, "SELECT * FROM vencimientos WHERE id = ?", fi);
  if (!row) throw new Error("Lote no encontrado");
  const ahora = fechaHoraDDMMAAAA();
  if (payload.resultado === "retirado") {
    // Estado intermedio "Pendiente reposición": se retiró físicamente de la góndola pero
    // todavía no se sabe si el proveedor lo cambia o queda como merma. fecha_retiro (no
    // fecha_revision) para no perder este momento cuando después se cierre el lote.
    await run(env, "UPDATE vencimientos SET estado='Retirado', fecha_retiro=?, revisado_por=? WHERE id=?",
      ahora, payload.revisadoPor || "", fi);
    return { sku: row.sku, nombre: row.producto, categoria: row.categoria, unidad: row.unidad, lote: row.lote, cantidad: row.cantidad, estado: "Retirado" };
  }
  // Cierre directo (sin pasar por "Retirado"): 'vendido' o 'merma'. motivo_cierre distingue
  // el tipo de cierre — antes todo quedaba igual como "Revisado" y no se podía saber cuál fue cuál.
  const motivoCierre = payload.resultado === "merma" ? "merma" : "vendido";
  await run(env, "UPDATE vencimientos SET estado='Revisado', motivo_cierre=?, fecha_revision=?, revisado_por=? WHERE id=?",
    motivoCierre, ahora, payload.revisadoPor || "", fi);
  return { sku: row.sku, nombre: row.producto, categoria: row.categoria, unidad: row.unidad, lote: row.lote, cantidad: row.cantidad, estado: "Revisado" };
}

async function accionEliminarLote(env, payload) {
  const fi = Number(payload.filaIndex);
  const row = await qOne(env, "SELECT * FROM vencimientos WHERE id = ?", fi);
  if (!row) throw new Error("Lote no encontrado");
  const cantidad = Number(row.cantidad) > 0 ? Number(row.cantidad) : (Number(payload.cantidad) || 0);

  let avisoStock, nuevoStock = null;
  if (cantidad > 0) {
    const it = await getProducto(env, row.sku);
    try {
      const res = await descontarStockFresco(env, it, cantidad);
      if (res.ok && res.antes != null) {
        nuevoStock = res.despues;
        await logMsg(env, "↩️ Lote eliminado, stock revertido: " + row.producto + " · " + res.antes + " → " + res.despues);
      } else if (!res.ok) {
        avisoStock = "⚠️ No se pudo revertir el stock en Loyverse (" + res.motivo + "). Revísalo a mano.";
      }
    } catch (e) {
      avisoStock = "⚠️ No se pudo revertir el stock en Loyverse. Revísalo a mano.";
    }
  }

  await run(env, "DELETE FROM vencimientos WHERE id = ?", fi);
  await logMsg(env, "🗑️ Lote eliminado: " + row.producto + " · SKU " + row.sku);

  const out = { sku: row.sku, nombre: row.producto, cantidad, nuevoStock };
  if (avisoStock) out.avisoStock = avisoStock;
  return out;
}

async function accionMarcarCambiado(env, payload) {
  await asegurarColumnasVencimientos(env);
  const fi = Number(payload.filaIndex);
  const row = await qOne(env, "SELECT * FROM vencimientos WHERE id = ?", fi);
  if (!row) throw new Error("Lote no encontrado");
  if (row.estado !== "Retirado") throw new Error("Este lote no está en estado 'Retirado' — puede que ya se haya cerrado.");
  await run(env, "UPDATE vencimientos SET estado='Revisado', motivo_cierre='cambiado_proveedor', fecha_revision=?, revisado_por=? WHERE id=?",
    fechaHoraDDMMAAAA(), payload.revisadoPor || "", fi);
  await logMsg(env, "✓ Cambio confirmado con proveedor: " + row.producto);
  return { sku: row.sku, nombre: row.producto, categoria: row.categoria, unidad: row.unidad, lote: row.lote, cantidad: row.cantidad };
}
// Alternativa a "cambiado": el proveedor no repuso el producto físico, pero aplicó un
// descuento/nota de crédito en la factura por lo vencido. Cierra el lote igual (ya no
// aparece en Pendientes) con un motivo_cierre distinto, y guarda el monto si lo indicaron.
async function accionMarcarDescuentoFactura(env, payload) {
  await asegurarColumnasVencimientos(env);
  const fi = Number(payload.filaIndex);
  const row = await qOne(env, "SELECT * FROM vencimientos WHERE id = ?", fi);
  if (!row) throw new Error("Lote no encontrado");
  if (row.estado !== "Retirado") throw new Error("Este lote no está en estado 'Retirado' — puede que ya se haya cerrado.");
  const monto = payload.montoDescuento != null && payload.montoDescuento !== "" && !isNaN(Number(payload.montoDescuento))
    ? Number(payload.montoDescuento) : null;
  await run(env, "UPDATE vencimientos SET estado='Revisado', motivo_cierre='descuento_factura', monto_descuento=?, fecha_revision=?, revisado_por=? WHERE id=?",
    monto, fechaHoraDDMMAAAA(), payload.revisadoPor || "", fi);
  await logMsg(env, "💰 Descuento en factura confirmado: " + row.producto + (monto != null ? " · $" + monto : " · monto no indicado"));
  return { sku: row.sku, nombre: row.producto, categoria: row.categoria, unidad: row.unidad, lote: row.lote, cantidad: row.cantidad, montoDescuento: monto };
}

async function accionEditarFecha(env, payload) {
  const nuevaFecha = String(payload.nuevaFecha || "").trim();
  if (!parseFechaDDMMAAAA(nuevaFecha)) throw new Error("Fecha inválida (usa DD/MM/AAAA)");
  const fi = Number(payload.filaIndex);
  const row = await qOne(env, "SELECT * FROM vencimientos WHERE id = ?", fi);
  if (!row) throw new Error("Lote no encontrado");

  const it = await getProducto(env, row.sku);
  const venta = await getVentaResumen(env, row.sku);
  const tablaVidaUtil = await getVidaUtilTabla(env);
  const calc = await calcularLote(env, { sku: row.sku, categoria: row.categoria, fechaVencimiento: nuevaFecha }, it, venta, tablaVidaUtil);

  await run(env,
    "UPDATE vencimientos SET fecha_vencimiento=?, estado=?, prioridad=?, accion=?, precio_recomendado=? WHERE id=?",
    nuevaFecha, calc.estado, calc.prioridad, calc.accion, calc.precioRecomendado || null, fi);
  await logMsg(env, "📅 Fecha corregida: " + row.producto + " → " + nuevaFecha + " · " + calc.estado);
  return { ok: true, filaIndex: fi, nuevaFecha, estado: calc.estado };
}

async function accionCorregirMotivoMerma(env, payload) {
  const nuevoMotivo = String(payload.nuevoMotivo || "").trim();
  if (!MOTIVOS_VALIDOS.includes(nuevoMotivo)) throw new Error("Motivo no válido: " + nuevoMotivo);
  const fi = Number(payload.filaIndex);
  const row = await qOne(env, "SELECT * FROM mermas WHERE id = ?", fi);
  if (!row) throw new Error("Merma no encontrada");
  await run(env, "UPDATE mermas SET motivo=? WHERE id=?", nuevoMotivo, fi);
  await logMsg(env, "✏️ Motivo de merma corregido: " + row.motivo + " → " + nuevoMotivo);
  return { ok: true, filaIndex: fi, motivoAnterior: row.motivo, nuevoMotivo };
}

// Elimina un registro de merma y revierte automáticamente el movimiento de inventario
// correspondiente (restaura el stock que esa merma había descontado). Usa el mismo patrón
// read-modify-write-verify que ya usa el resto del proyecto para Loyverse (sumarStockCache).
// Si el producto ya no existe en el catálogo (borrado después), solo se elimina el registro
// y se avisa — no hay forma de restaurar el stock de un producto que ya no está.
async function accionEliminarMerma(env, payload) {
  const fi = Number(payload && payload.filaIndex);
  if (!fi) throw new Error("Falta el identificador de la merma");
  const row = await qOne(env, "SELECT * FROM mermas WHERE id = ?", fi);
  if (!row) throw new Error("Merma no encontrada");

  let stockNuevo = null, avisoStock = null;
  const it = await getProducto(env, row.sku);
  if (it) {
    try {
      const res = await sumarStockCache(env, it, row.cantidad);
      if (res.ok && res.despues != null) {
        stockNuevo = res.despues;
        await logMsg(env, "📈 Stock restaurado por eliminación de merma: " + row.producto + " · " + res.antes + " → " + res.despues);
      } else if (!res.ok) {
        avisoStock = "⚠️ No se pudo restaurar el stock en Loyverse (" + res.motivo + "). Revísalo a mano.";
      }
    } catch (e) {
      avisoStock = "⚠️ No se pudo restaurar el stock en Loyverse. Revísalo a mano.";
      await logMsg(env, "⚠️ Error al restaurar stock tras eliminar merma (" + row.producto + "): " + e.message);
    }
  } else {
    avisoStock = "⚠️ El producto ya no existe en el catálogo — no se pudo restaurar el stock, solo se borró el registro.";
  }

  await run(env, "DELETE FROM mermas WHERE id = ?", fi);
  await logMsg(env, "🗑️ Merma eliminada: " + row.producto + " (" + row.cantidad + row.unidad + ", $" + row.costo_total + ") · responsable original: " + row.responsable);

  return { ok: true, filaIndex: fi, sku: row.sku, cantidadRevertida: row.cantidad, stockNuevo, avisoStock };
}

// Patrón seguro y reutilizable para CUALQUIER cambio a un producto en Loyverse:
// lee el ítem COMPLETO por su ID exacto (endpoint /items/{id}, nunca un filtro de lista —
// así no hay riesgo de tomar el producto equivocado), aplica solo los campos indicados en
// `cambios`, reenvía el ítem completo (para no perder el resto de sus datos), y VUELVE A LEERLO
// para confirmar que Loyverse aplicó de verdad cada cambio antes de darlo por bueno.
async function actualizarCamposItemLoyverse(env, idLoyverse, cambios) {
  const item = await loyverseGet(env, "/items/" + idLoyverse, {});
  if (!item || !item.id) throw new Error("No se encontró el producto en Loyverse (id " + idLoyverse + ")");
  if (item.id !== idLoyverse) throw new Error("Loyverse devolvió un producto distinto al esperado — no se modificó nada");

  Object.assign(item, cambios);
  await loyversePost(env, "/items", item);

  // Confirmación: vuelve a leer el ítem para asegurarnos de que Loyverse aplicó el cambio de verdad
  // (su API puede aceptar el POST con 200 OK sin que el campo realmente cambie).
  await new Promise(r => setTimeout(r, 500));
  const verificado = await loyverseGet(env, "/items/" + idLoyverse, {});
  for (const k of Object.keys(cambios)) {
    if (JSON.stringify(verificado ? verificado[k] : undefined) !== JSON.stringify(cambios[k])) {
      throw new Error("Loyverse no aplicó el cambio en '" + k + "' (su API lo rechazó silenciosamente)");
    }
  }
  return verificado;
}

async function habilitarTrackStockLoyverse(env, idLoyverse) {
  return actualizarCamposItemLoyverse(env, idLoyverse, { track_stock: true });
}

// Paso 1 del flujo de dos pasos: SOLO intenta activar "Seguir inventario", sin tocar el stock.
async function accionHabilitarTrackStock(env, payload) {
  const sku = String(payload.sku || "");
  if (!sku) throw new Error("Falta el SKU");
  const it = await getProducto(env, sku);
  if (!it) throw new Error("SKU no encontrado en el catálogo: " + sku);
  if (it.track_stock) return { sku, nombre: it.nombre, ok: true, yaEstaba: true };
  if (!it.id_loyverse) throw new Error("Falta id de Loyverse — toca ♻️ Catálogo y vuelve a intentar");

  const item = await habilitarTrackStockLoyverse(env, it.id_loyverse);
  await run(env, "UPDATE productos SET track_stock = 1, stock = ? WHERE sku = ?",
    item.variants && item.variants[0] ? (item.variants[0].in_stock != null ? item.variants[0].in_stock : 0) : 0, sku);
  await logMsg(env, "🔓 'Seguir inventario' habilitado en Loyverse: " + it.nombre + " (" + sku + ")");
  return { sku, nombre: it.nombre, ok: true, yaEstaba: false };
}

async function accionAjustarStock(env, payload) {
  const sku = String(payload.sku || "");
  const nuevo = Number(payload.stockNuevo);
  if (!sku) throw new Error("Falta el SKU");
  if (isNaN(nuevo) || nuevo < 0) throw new Error("Cantidad de reconteo inválida");

  const it = await getProducto(env, sku);
  if (!it) throw new Error("SKU no encontrado en el catálogo: " + sku);

  const stockAntes = it.stock;
  let trackHabilitadoAhora = false;

  if (!it.track_stock) {
    if (!it.id_loyverse) throw new Error("Falta id de Loyverse — toca ♻️ Catálogo y vuelve a intentar");
    try {
      await habilitarTrackStockLoyverse(env, it.id_loyverse);
      await run(env, "UPDATE productos SET track_stock = 1 WHERE sku = ?", sku);
      it.track_stock = 1;
      trackHabilitadoAhora = true;
      await logMsg(env, "🔓 'Seguir inventario' habilitado en Loyverse: " + it.nombre + " (" + sku + ")");
    } catch (e) {
      // No se pudo habilitar en Loyverse (API lo rechazó o falló la conexión) — igual guardamos
      // el conteo como referencia local, para no dejar al usuario sin poder registrar su trabajo.
      await run(env, "UPDATE productos SET stock = ? WHERE sku = ?", nuevo, sku);
      await run(env,
        `INSERT INTO auditoria (fecha, accion, sku, producto, categoria, id_loyverse, stock, motivo, responsable)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        fechaHoraDDMMAAAA(), "reconteo_stock", sku, it.nombre, it.categoria, it.id_loyverse, nuevo,
        "Reconteo físico (solo local — no se pudo habilitar seguimiento en Loyverse: " + e.message + "): " +
        (stockAntes == null ? "s/d" : stockAntes) + " → " + nuevo, payload.responsable || "");
      await logMsg(env, "⚠️ No se pudo habilitar seguimiento en Loyverse (" + it.nombre + "): " + e.message);
      return {
        sku, nombre: it.nombre, ok: true, sinControlStock: true, stockAntes, stockNuevo: nuevo,
        avisoStock: "⚠️ No se pudo activar 'Seguir inventario' en Loyverse automáticamente (" + e.message + "). El conteo quedó guardado solo en el sistema local — actívalo a mano en Loyverse si quieres que quede sincronizado."
      };
    }
  }

  if (!it.variant_id) throw new Error("Falta variant_id — toca ♻️ Catálogo y vuelve a intentar");

  await loyversePost(env, "/inventory", {
    inventory_levels: [{ variant_id: it.variant_id, store_id: STORE_ID, stock_after: nuevo }]
  });
  await run(env, "UPDATE productos SET stock = ? WHERE sku = ?", nuevo, sku);
  await run(env,
    `INSERT INTO auditoria (fecha, accion, sku, producto, categoria, id_loyverse, stock, motivo, responsable)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    fechaHoraDDMMAAAA(), "reconteo_stock", sku, it.nombre, it.categoria, it.id_loyverse, nuevo,
    (trackHabilitadoAhora ? "Se habilitó 'Seguir inventario' y se registró el primer conteo: " : "Reconteo físico: ") +
    (stockAntes == null ? "s/d" : stockAntes) + " → " + nuevo, payload.responsable || "");
  await logMsg(env, "🔢 Reconteo: " + it.nombre + " (" + sku + ") · " + stockAntes + " → " + nuevo);

  return { sku, nombre: it.nombre, ok: true, stockAntes, stockNuevo: nuevo, trackHabilitado: trackHabilitadoAhora };
}

// FASE 2 — Editar producto: nombre, categoría y descripción.
// (Impuesto y estado activo/inactivo quedan pendientes: no se pudo confirmar con certeza
// el formato exacto que usa la API de Loyverse para esos dos campos.)
async function accionEditarProducto(env, payload) {
  const sku = String(payload.sku || "");
  if (!sku) throw new Error("Falta el SKU");
  const it = await getProducto(env, sku);
  if (!it) throw new Error("SKU no encontrado en el catálogo: " + sku);
  if (!it.id_loyverse) throw new Error("Falta id de Loyverse — toca ♻️ Catálogo y vuelve a intentar");

  const nombre = payload.nombre != null ? String(payload.nombre).trim() : null;
  const categoria = payload.categoria != null ? String(payload.categoria).trim() : null;
  const descripcion = payload.descripcion != null ? String(payload.descripcion).trim() : null;
  if (nombre === "") throw new Error("El nombre no puede quedar vacío");

  const cambios = {};
  const setsLocales = [];
  const valoresLocales = [];

  if (nombre != null && nombre !== it.nombre) {
    cambios.item_name = nombre;
    setsLocales.push("nombre = ?"); valoresLocales.push(nombre);
  }
  let categoriaFinal = it.categoria;
  if (categoria != null && categoria !== it.categoria) {
    const cats = await q(env, "SELECT DISTINCT categoria FROM productos WHERE categoria = ?", categoria);
    if (!cats.length) throw new Error("La categoría '" + categoria + "' no existe — elige una de la lista");
    // Necesitamos el category_id real de Loyverse: lo tomamos leyendo cualquier otro producto ya
    // asignado a esa categoría desde Loyverse mismo (evita mantener un mapeo aparte que se desactualice).
    const otro = await qOne(env, "SELECT id_loyverse FROM productos WHERE categoria = ? AND id_loyverse IS NOT NULL AND sku != ? LIMIT 1", categoria, sku);
    if (!otro) throw new Error("No se pudo determinar el ID de Loyverse para la categoría '" + categoria + "'");
    const refItem = await loyverseGet(env, "/items/" + otro.id_loyverse, {});
    if (!refItem || !refItem.category_id) throw new Error("No se pudo leer el ID de la categoría desde Loyverse");
    cambios.category_id = refItem.category_id;
    categoriaFinal = categoria;
    setsLocales.push("categoria = ?"); valoresLocales.push(categoria);
  }
  if (descripcion != null && descripcion !== (it.descripcion || "")) {
    cambios.description = descripcion;
    setsLocales.push("descripcion = ?"); valoresLocales.push(descripcion);
  }
  // Tipo de venta (Unidad/Peso) — campo de Loyverse, mismo patrón que nombre/categoría/descripción.
  if (payload.soldByWeight !== undefined) {
    const sbw = !!payload.soldByWeight;
    if (sbw !== !!it.sold_by_weight) {
      cambios.sold_by_weight = sbw;
      setsLocales.push("sold_by_weight = ?"); valoresLocales.push(sbw ? 1 : 0);
    }
  }

  const stockMinimo = payload.stockMinimo != null && payload.stockMinimo !== "" ? Number(payload.stockMinimo) : undefined;
  if (stockMinimo !== undefined && (isNaN(stockMinimo) || stockMinimo < 0)) throw new Error("El stock mínimo no puede ser negativo");

  // Proveedor y Sector son campos solo-D1 (no existen en Loyverse) — se editan directo en la
  // tabla local, sin pasar por actualizarCamposItemLoyverse. Ver doc de diseño Proveedor/Sector.
  if (payload.proveedor_id !== undefined || payload.sector !== undefined) {
    await asegurarColumnasProveedorSector(env);
  }
  let huboCambioLocalExtra = false;
  if (payload.proveedor_id !== undefined) {
    const provId = (payload.proveedor_id === null || payload.proveedor_id === "") ? null : Number(payload.proveedor_id);
    if (provId !== null) {
      const provOk = await qOne(env, "SELECT id FROM proveedores WHERE id = ?", provId);
      if (!provOk) throw new Error("El proveedor indicado no existe");
    }
    setsLocales.push("proveedor_id = ?"); valoresLocales.push(provId);
    huboCambioLocalExtra = true;
  }
  if (payload.sector !== undefined) {
    const sectorVal = (payload.sector === null || payload.sector === "") ? null : String(payload.sector).trim().toUpperCase();
    if (sectorVal !== null && !(await sectorEsValido(env, sectorVal))) throw new Error("Sector no válido: " + sectorVal);
    setsLocales.push("sector = ?"); valoresLocales.push(sectorVal);
    huboCambioLocalExtra = true;
  }

  if (!Object.keys(cambios).length && stockMinimo === undefined && !huboCambioLocalExtra) {
    return { sku, nombre: it.nombre, ok: true, sinCambios: true };
  }

  if (Object.keys(cambios).length) await actualizarCamposItemLoyverse(env, it.id_loyverse, cambios);
  if (stockMinimo !== undefined) {
    if (!it.variant_id) throw new Error("Falta variant_id — toca ♻️ Catálogo y vuelve a intentar");
    await actualizarStockMinimoLoyverse(env, it.id_loyverse, it.variant_id, stockMinimo);
  }

  valoresLocales.push(sku);
  await run(env, "UPDATE productos SET " + setsLocales.join(", ") + " WHERE sku = ?", ...valoresLocales);

  // Si la edición terminó de fijar proveedor + sector, el producto deja de estar "pendiente
  // de revisión" (si lo estaba tras la clasificación automática masiva).
  if (payload.proveedor_id !== undefined && payload.sector !== undefined) {
    await run(env, "DELETE FROM clasificacion_pendiente WHERE sku = ?", sku).catch(() => {});
  }

  await run(env,
    `INSERT INTO auditoria (fecha, accion, sku, producto, categoria, id_loyverse, stock, motivo, responsable)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    fechaHoraDDMMAAAA(), "editar_producto", sku, nombre || it.nombre, categoriaFinal, it.id_loyverse, it.stock,
    "Editado: " + Object.keys(cambios).join(", "), payload.responsable || "");
  await logMsg(env, "✏️ Producto editado: " + (nombre || it.nombre) + " (" + sku + ") · campos: " + Object.keys(cambios).join(", "));

  return { sku, nombre: nombre || it.nombre, categoria: categoriaFinal, ok: true };
}

// El código de barras vive en item.variants[], no en el ítem general — variante del mismo
// patrón seguro (leer completo → cambiar solo la variante indicada → reenviar → verificar).
async function actualizarBarcodeItemLoyverse(env, idLoyverse, variantId, nuevoBarcode) {
  const item = await loyverseGet(env, "/items/" + idLoyverse, {});
  if (!item || !item.id) throw new Error("No se encontró el producto en Loyverse (id " + idLoyverse + ")");
  if (item.id !== idLoyverse) throw new Error("Loyverse devolvió un producto distinto al esperado — no se modificó nada");
  const variantes = item.variants || [];
  const v = variantes.find(x => x.variant_id === variantId) || variantes[0];
  if (!v) throw new Error("El producto no tiene variantes en Loyverse");
  v.barcode = nuevoBarcode;
  await loyversePost(env, "/items", item);

  await new Promise(r => setTimeout(r, 500));
  const verificado = await loyverseGet(env, "/items/" + idLoyverse, {});
  const vv = (verificado.variants || []).find(x => x.variant_id === (v.variant_id || variantId));
  if (!vv || (vv.barcode || "") !== (nuevoBarcode || "")) {
    throw new Error("Loyverse no aplicó el cambio de código de barras (su API lo rechazó silenciosamente)");
  }
  return verificado;
}

// FASE 3 — Código de barras: agregar/editar, con validación de duplicados contra el catálogo local.
async function accionEditarCodigoBarras(env, payload) {
  const sku = String(payload.sku || "");
  const nuevoBarcode = String(payload.barcode || "").trim();
  if (!sku) throw new Error("Falta el SKU");
  const it = await getProducto(env, sku);
  if (!it) throw new Error("SKU no encontrado en el catálogo: " + sku);
  if (!it.id_loyverse || !it.variant_id) throw new Error("Falta id de Loyverse — toca ♻️ Catálogo y vuelve a intentar");

  if (nuevoBarcode === (it.barcode || "")) return { sku, nombre: it.nombre, ok: true, sinCambios: true };

  if (nuevoBarcode) {
    const dup = await qOne(env, "SELECT sku, nombre FROM productos WHERE barcode = ? AND sku != ?", nuevoBarcode, sku);
    if (dup) throw new Error("Ese código de barras ya está en uso por '" + dup.nombre + "' (SKU " + dup.sku + ") — no se puede repetir");
  }

  await actualizarBarcodeItemLoyverse(env, it.id_loyverse, it.variant_id, nuevoBarcode);
  await run(env, "UPDATE productos SET barcode = ? WHERE sku = ?", nuevoBarcode, sku);

  await run(env,
    `INSERT INTO auditoria (fecha, accion, sku, producto, categoria, id_loyverse, stock, motivo, responsable)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    fechaHoraDDMMAAAA(), "editar_barcode", sku, it.nombre, it.categoria, it.id_loyverse, it.stock,
    "Código de barras: '" + (it.barcode || "—") + "' → '" + (nuevoBarcode || "—") + "'", payload.responsable || "");
  await logMsg(env, "🏷️ Código de barras actualizado: " + it.nombre + " (" + sku + ")");

  return { sku, nombre: it.nombre, barcode: nuevoBarcode, ok: true };
}

// Precio y costo también viven en item.variants[] (igual que el código de barras) —
// mismo patrón seguro de leer → cambiar solo esa variante → reenviar → verificar.
async function actualizarPrecioCostoLoyverse(env, idLoyverse, variantId, precio, costo) {
  const item = await loyverseGet(env, "/items/" + idLoyverse, {});
  if (!item || !item.id) throw new Error("No se encontró el producto en Loyverse (id " + idLoyverse + ")");
  if (item.id !== idLoyverse) throw new Error("Loyverse devolvió un producto distinto al esperado — no se modificó nada");
  const variantes = item.variants || [];
  const vExacta = variantes.find(x => x.variant_id === variantId);
  const v = vExacta || variantes[0];
  if (!v) throw new Error("El producto no tiene variantes en Loyverse");
  // Si el variant_id guardado en D1 ya no existe en Loyverse (catálogo desincronizado), se
  // cae al fallback variantes[0] — pero esa variante puede no ser la que el usuario ve/vende,
  // y algunas variantes de fallback vienen con reglas de precio propias que Loyverse ignora
  // silenciosamente. Se deja registrado para poder diagnosticarlo sin adivinar.
  const variantMismatch = !vExacta && variantes.length > 0;
  const costoAntesLog = v.cost, precioAntesLog = v.default_price;
  if (precio != null) {
    v.default_price = precio;
    if (v.stores && v.stores[0]) v.stores[0].price = precio; // particularidad de Loyverse: el precio por tienda puede pisar el general
  }
  if (costo != null) v.cost = costo;
  await loyversePost(env, "/items", item);

  // Verificación con reintento: Loyverse a veces demora más de 500ms en propagar el cambio
  // (consistencia eventual de su API) — antes de declarar el cambio rechazado, se reintenta
  // una vez más con una espera mayor.
  // FIX: la comparación solo miraba default_price, pero Loyverse aplica el cambio real a
  // nivel de tienda (stores[].price) — el mismo comentario de arriba ya lo advertía ("el
  // precio por tienda puede pisar el general"). Por eso el precio SÍ quedaba actualizado en
  // Loyverse pero la verificación lo marcaba como rechazado. Ahora se acepta como correcto
  // si default_price O el precio de la tienda coinciden, con una pequeña tolerancia de
  // redondeo — un rechazo real (ninguno de los dos cambia) se sigue detectando igual.
  function valoresCasiIguales(a, b) {
    if (a == null || b == null) return false;
    return Math.abs(Number(a) - Number(b)) < 0.5;
  }
  const esperas = [500, 1500];
  let verificado, vv, precioOk, costoOk;
  for (let i = 0; i < esperas.length; i++) {
    await new Promise(r => setTimeout(r, esperas[i]));
    verificado = await loyverseGet(env, "/items/" + idLoyverse, {});
    vv = (verificado.variants || []).find(x => x.variant_id === (v.variant_id || variantId));
    precioOk = precio == null || (vv && (valoresCasiIguales(vv.default_price, precio) || (vv.stores && vv.stores[0] && valoresCasiIguales(vv.stores[0].price, precio))));
    costoOk = costo == null || (vv && valoresCasiIguales(vv.cost, costo));
    if (vv && precioOk && costoOk) return verificado;
  }
  // Se agotaron los reintentos: queda diagnóstico completo en logs (?action=ver_logs) en vez
  // de solo el mensaje genérico — para no tener que reproducir el error a ciegas otra vez.
  await logMsg(env, "❌ Loyverse rechazó el cambio en id " + idLoyverse +
    (variantMismatch ? " (variant_id guardado no coincide — se usó variantes[0] como fallback, revisar ♻️ Catálogo)" : "") +
    " · precio: " + precioAntesLog + " → " + (precio != null ? precio : "(sin cambio)") + " quedó en " + (vv ? vv.default_price : "?") +
    " · costo: " + costoAntesLog + " → " + (costo != null ? costo : "(sin cambio)") + " quedó en " + (vv ? vv.cost : "?"));
  if (!vv) throw new Error("Loyverse no devolvió la variante al verificar");
  if (!precioOk) {
    throw new Error("Loyverse no aplicó el cambio de precio (su API lo rechazó silenciosamente)" +
      (variantMismatch ? " — el variant_id guardado no coincide con Loyverse, toca ♻️ Catálogo y vuelve a intentar" : " — revisa este producto directo en la app de Loyverse, puede tener una regla de precio propia"));
  }
  if (!costoOk) {
    throw new Error("Loyverse no aplicó el cambio de costo (su API lo rechazó silenciosamente)" +
      (variantMismatch ? " — el variant_id guardado no coincide con Loyverse, toca ♻️ Catálogo y vuelve a intentar" : " — revisa este producto directo en la app de Loyverse, puede tener una regla de precio propia"));
  }
  return verificado;
}

// Actualiza SOLO el umbral de "inventario bajo" de una variante ya existente en Loyverse
// (mismo patrón de lectura→cambio→escritura que actualizarPrecioCostoLoyverse).
async function actualizarStockMinimoLoyverse(env, idLoyverse, variantId, stockMinimo) {
  const item = await loyverseGet(env, "/items/" + idLoyverse, {});
  if (!item || !item.id) throw new Error("No se encontró el producto en Loyverse (id " + idLoyverse + ")");
  const variantes = item.variants || [];
  const v = variantes.find(x => x.variant_id === variantId) || variantes[0];
  if (!v) throw new Error("El producto no tiene variantes en Loyverse");
  if (!v.stores || !v.stores[0]) throw new Error("El producto no tiene tienda asignada en Loyverse");
  v.stores[0].low_stock = stockMinimo;
  await loyversePost(env, "/items", item);
  return item;
}

// FASE 4 — Editar precio/costo, dejando registro en historial_precios ANTES de escribir en
// Loyverse (así el historial queda completo aunque la escritura falle a mitad de camino).
async function accionEditarPrecio(env, payload) {
  const sku = String(payload.sku || "");
  if (!sku) throw new Error("Falta el SKU");
  const it = await getProducto(env, sku);
  if (!it) throw new Error("SKU no encontrado en el catálogo: " + sku);
  if (!it.id_loyverse || !it.variant_id) throw new Error("Falta id de Loyverse — toca ♻️ Catálogo y vuelve a intentar");

  const precioNuevo = payload.precio != null && payload.precio !== "" ? Number(payload.precio) : null;
  const costoNuevo = payload.costo != null && payload.costo !== "" ? Number(payload.costo) : null;
  if (precioNuevo != null && (isNaN(precioNuevo) || precioNuevo < 0)) throw new Error("El precio no puede ser negativo");
  if (costoNuevo != null && (isNaN(costoNuevo) || costoNuevo < 0)) throw new Error("El costo no puede ser negativo");

  const precioAntes = it.precio, costoAntes = it.costo;
  const sinCambioPrecio = precioNuevo == null || precioNuevo === precioAntes;
  const sinCambioCosto = costoNuevo == null || costoNuevo === costoAntes;
  if (sinCambioPrecio && sinCambioCosto) return { sku, nombre: it.nombre, ok: true, sinCambios: true };

  const advertencia = (precioNuevo != null && costoNuevo != null && costoNuevo > precioNuevo)
    ? "⚠️ El costo quedó por encima del precio de venta — revisa si es intencional (venta a pérdida)."
    : ((precioNuevo == null && costoNuevo != null && costoNuevo > precioAntes) || (costoNuevo == null && precioNuevo != null && costoAntes > precioNuevo))
      ? "⚠️ El costo queda por encima del precio de venta con este cambio — revisa si es intencional."
      : "";

  await run(env,
    `INSERT INTO historial_precios (sku, fecha, precio_antes, precio_despues, costo_antes, costo_despues, responsable)
     VALUES (?,?,?,?,?,?,?)`,
    sku, fechaHoraDDMMAAAA(), precioAntes, sinCambioPrecio ? precioAntes : precioNuevo,
    costoAntes, sinCambioCosto ? costoAntes : costoNuevo, payload.responsable || "");

  await actualizarPrecioCostoLoyverse(env, it.id_loyverse, it.variant_id,
    sinCambioPrecio ? null : precioNuevo, sinCambioCosto ? null : costoNuevo);

  const setsLocales = [], valoresLocales = [];
  if (!sinCambioPrecio) { setsLocales.push("precio = ?"); valoresLocales.push(precioNuevo); }
  if (!sinCambioCosto) { setsLocales.push("costo = ?"); valoresLocales.push(costoNuevo); }
  valoresLocales.push(sku);
  await run(env, "UPDATE productos SET " + setsLocales.join(", ") + " WHERE sku = ?", ...valoresLocales);

  await run(env,
    `INSERT INTO auditoria (fecha, accion, sku, producto, categoria, id_loyverse, stock, motivo, responsable)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    fechaHoraDDMMAAAA(), "editar_precio", sku, it.nombre, it.categoria, it.id_loyverse, it.stock,
    "Precio: $" + precioAntes + " → $" + (sinCambioPrecio ? precioAntes : precioNuevo) +
    " · Costo: $" + costoAntes + " → $" + (sinCambioCosto ? costoAntes : costoNuevo), payload.responsable || "");
  await logMsg(env, "💲 Precio/costo editado: " + it.nombre + " (" + sku + ")");

  return { sku, nombre: it.nombre, ok: true, precio: sinCambioPrecio ? precioAntes : precioNuevo, costo: sinCambioCosto ? costoAntes : costoNuevo, advertencia };
}

// FASE 6 — Escanear factura: Claude (visión) extrae producto/cantidad/costo de la foto.
// Nunca escribe nada solo — el frontend siempre muestra una tabla editable para que el
// usuario revise/corrija antes de guardar (ver accionGuardarCalculoPrecio más abajo).
async function accionProcesarFactura(env, payload) {
  const imagenB64 = payload && payload.imagen_base64;
  const mediaType = (payload && payload.media_type) || "image/jpeg";
  if (!imagenB64) throw new Error("Falta la imagen de la factura");
  if (!env.ANTHROPIC_API_KEY) throw new Error("Falta configurar el secreto ANTHROPIC_API_KEY en Cloudflare (wrangler secret put ANTHROPIC_API_KEY)");

  const prompt = "Esta imagen es una factura o boleta de un proveedor de un minimarket chileno. " +
    "Las facturas de este tipo suelen tener columnas en este orden: CANTIDAD, CÓDIGO, " +
    "DESCRIPCIÓN PRODUCTO, P. UNITARIO, DESCUENTO %, DESCUENTO $, $ TOTALES. " +
    "Extrae cada producto/línea de la factura y responde SOLO con un array JSON, sin texto antes ni " +
    "después, sin marcadores de código (nada de ```), con esta forma exacta:\n" +
    '[{"producto":"nombre tal como aparece","cantidad":numero,"costo_unitario":numero,"incluye_iva":true|false,"categoria_sugerida":"bebidas|snacks|confites|abarrotes|premium|otro"}]\n' +
    "Reglas de mapeo — son las más importantes, léelas con cuidado porque son la causa más común " +
    "de error: \"cantidad\" va SIEMPRE de la columna CANTIDAD (la primera columna numérica, a la " +
    "izquierda, normalmente un número chico como 1, 2, 5, 10, 24). \"costo_unitario\" va SIEMPRE de " +
    "la columna P. UNITARIO (el precio de ESA línea/presentación tal como está impreso, antes de " +
    "descuentos) — NUNCA tomes el valor de la columna $ TOTALES (que ya viene multiplicado por la " +
    "cantidad) ni el de DESCUENTO $ para \"costo_unitario\". Si tienes dudas entre dos columnas " +
    "numéricas parecidas, la que está más a la izquierda (después de la descripción) suele ser P. " +
    "UNITARIO, y la de más a la derecha suele ser $ TOTALES. \"incluye_iva\" es true si el documento " +
    "indica que los precios incluyen IVA (19% en Chile), false si son netos (por ejemplo si hay un " +
    "recuadro aparte de \"NETO\" + \"19% IVA\" + \"TOTAL\" al pie, los precios de la tabla son netos), " +
    "y tu mejor estimación si no está explícito. \"categoria_sugerida\" es tu mejor clasificación del " +
    "producto entre esas 6 opciones exactas, según el nombre. Si un dato no se lee con claridad, usa " +
    "tu mejor lectura igual — el usuario revisa cada fila antes de guardar nada. Si no hay ningún " +
    "producto legible, responde con [].";

  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 2000,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: imagenB64 } },
            { type: "text", text: prompt }
          ]
        }]
      })
    });
  } catch (e) {
    throw new Error("No se pudo conectar con Claude: " + e.message);
  }
  if (!res.ok) {
    const errTxt = await res.text().catch(() => "");
    throw new Error("Claude no pudo procesar la imagen (" + res.status + "): " + errTxt.slice(0, 200));
  }
  const data = await res.json();
  const textBlock = (data.content || []).find(b => b.type === "text");
  if (!textBlock) throw new Error("Claude no devolvió texto con los productos");
  const raw = textBlock.text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/```\s*$/, "").trim();
  let items;
  try { items = JSON.parse(raw); } catch (e) { throw new Error("No se pudo interpretar la respuesta de Claude como lista de productos"); }
  if (!Array.isArray(items)) throw new Error("Formato inesperado en la respuesta de Claude");

  items = items.map(it => ({
    producto: String(it.producto || it.nombre || "").trim(),
    cantidad: Number(it.cantidad) || 0,
    costo_unitario: Number(it.costo_unitario) || 0,
    incluye_iva: !!it.incluye_iva,
    categoria_sugerida: String(it.categoria_sugerida || "otro").toLowerCase().trim()
  })).filter(it => it.producto);

  await logMsg(env, "📷 Factura procesada: " + items.length + " producto(s) detectados");
  return { ok: true, items };
}

// Busca fotos de empaque/producto candidatas para un nombre, usando Searlo (motor de
// búsqueda tipo Google, SIN inteligencia artificial de por medio) — reemplaza la búsqueda
// con Claude. Requiere el secreto SEARLO_API_KEY (cuenta gratis en searlo.tech, 3.000
// búsquedas/mes sin costo, wrangler secret put SEARLO_API_KEY).
async function accionBuscarImagenProducto(env, payload) {
  const nombre = payload && payload.nombre;
  if (!nombre) throw new Error("Falta el nombre del producto");
  if (!env.SEARLO_API_KEY) throw new Error("Falta configurar el secreto SEARLO_API_KEY en Cloudflare (wrangler secret put SEARLO_API_KEY — cuenta gratis en searlo.tech)");

  const query = nombre + " producto empaque";
  let res;
  try {
    res = await fetch("https://api.searlo.tech/api/v1/search/images?q=" + encodeURIComponent(query), {
      headers: { "x-api-key": env.SEARLO_API_KEY }
    });
  } catch (e) {
    throw new Error("No se pudo conectar con Searlo: " + e.message);
  }
  if (!res.ok) {
    const errTxt = await res.text().catch(() => "");
    throw new Error("Searlo no pudo buscar la imagen (" + res.status + "): " + errTxt.slice(0, 200));
  }
  const data = await res.json();
  // AVISO: la documentación de Searlo muestra DOS formas distintas de respuesta según la
  // página — a veces "images"/"results" (lista plana) y a veces "items" con cada elemento
  // anidado como {type:"image", image:{src, thumbnail, ...}}. Se prueban las dos formas a la
  // vez; si ninguna calza, queda registrado en los logs para ajustar con el dato real.
  const planos = data.results || data.images || [];
  const anidados = (data.items || []).map(it => ({
    url: (it.image && (it.image.src || it.image.url)) || it.link || "",
    fuente: it.source || it.domain || it.title || ""
  }));
  const items = planos.length ? planos : anidados;
  let candidatos = items.map(it => ({
    url: it.url || it.imageUrl || it.image_url || it.link || it.thumbnailUrl || "",
    fuente: it.source || it.domain || it.title || ""
  })).filter(c => c.url && /^https?:\/\//.test(c.url)).slice(0, 4);

  if (candidatos.length) {
    await logMsg(env, "🔍 Searlo OK: \"" + nombre + "\" → " + candidatos.length + " candidato(s)");
  } else {
    await logMsg(env, "🔍 Searlo sin resultados usables para \"" + nombre + "\" — respuesta cruda: " + JSON.stringify(data).slice(0, 400));
  }
  return { ok: true, candidatos };
}

// Sube al producto en Loyverse la imagen que el usuario eligió — el Worker la descarga él
// mismo cuando viene de una URL (servidor a servidor, sin el bloqueo CORS que tendría el
// celular al intentar leer una imagen de otro sitio con canvas), o usa directo los bytes si
// ya viene de la galería del celular.
async function accionSubirImagenProducto(env, payload) {
  const sku = payload && payload.sku;
  const imageUrl = payload && payload.image_url;
  const imageBase64Directo = payload && payload.image_base64;
  if (!sku) throw new Error("Falta el sku del producto");
  if (!imageUrl && !imageBase64Directo) throw new Error("Falta la imagen elegida");
  const producto = await getProducto(env, sku);
  if (!producto || !producto.id_loyverse) throw new Error("Producto sin id de Loyverse — sincroniza el catálogo (♻️) primero");

  let imageBytes, contentType;
  if (imageBase64Directo) {
    // Ya viene comprimida desde el celular (foto de galería) como JPEG — se decodifica a bytes.
    const binaryStr = atob(imageBase64Directo);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
    imageBytes = bytes.buffer;
    contentType = "image/jpeg";
  } else {
    let imgRes;
    try { imgRes = await fetch(imageUrl); } catch (e) { throw new Error("No se pudo descargar la imagen: " + e.message); }
    if (!imgRes.ok) throw new Error("No se pudo descargar la imagen (código " + imgRes.status + ") — prueba con otra");
    imageBytes = await imgRes.arrayBuffer();
    if (imageBytes.byteLength > 5 * 1024 * 1024) throw new Error("La imagen pesa más de 5MB — elige otra de las sugeridas");
    contentType = imgRes.headers.get("content-type") || (/\.png(\?|$)/i.test(imageUrl) ? "image/png" : "image/jpeg");
  }

  // Endpoint oficial confirmado en la colección Postman de Loyverse (developer.loyverse.com):
  // POST /items/{id}/image con el binario CRUDO de la imagen como cuerpo — es un endpoint
  // aparte, no un campo dentro del JSON del producto. Por eso nunca se confirmaba antes.
  let uploadRes;
  try {
    uploadRes = await fetch(LOYVERSE_API + "/items/" + producto.id_loyverse + "/image", {
      method: "POST",
      headers: { "Authorization": "Bearer " + env.LOYVERSE_TOKEN, "Content-Type": contentType },
      body: imageBytes
    });
  } catch (e) { throw new Error("No se pudo conectar con Loyverse: " + e.message); }
  if (!uploadRes.ok) {
    const errTxt = await uploadRes.text().catch(() => "");
    await logMsg(env, "❌ Loyverse rechazó la imagen (sku " + sku + ", " + uploadRes.status + "): " + errTxt.slice(0, 200));
    throw new Error("Loyverse rechazó la imagen (" + uploadRes.status + "): " + errTxt.slice(0, 200));
  }

  await new Promise(r => setTimeout(r, 900));
  const verificado = await loyverseGet(env, "/items/" + producto.id_loyverse, {});
  const imagenNueva = verificado && verificado.image_url;
  if (!imagenNueva) {
    await logMsg(env, "⚠️ Imagen subida (endpoint dedicado) pero no se confirmó todavía (sku " + sku + ") — puede tardar unos segundos.");
    throw new Error("Loyverse aceptó la imagen pero todavía no se confirma — puede tardar unos segundos. Revisa el producto directo en Loyverse en un momento.");
  }
  await run(env, "UPDATE productos SET imagen_url=? WHERE sku=?", imagenNueva, sku);
  await logMsg(env, "🖼️ Imagen subida a Loyverse OK (endpoint dedicado): " + sku);
  return { ok: true, imagen_url: imagenNueva };
}

// Guarda en D1 los cálculos de precio ya revisados/confirmados por el usuario. Tabla propia
// (facturas_calculos) — no toca vencimientos/mermas/productos ni ninguna tabla existente.
// Todas las filas de una misma foto comparten factura_id, así queda historial por factura.
async function accionGuardarCalculoPrecio(env, payload) {
  const items = Array.isArray(payload && payload.items) ? payload.items : [];
  if (!items.length) throw new Error("No hay productos para guardar");
  const facturaIdProvista = payload && payload.factura_id;
  const facturaId = facturaIdProvista || ("FC-" + Date.now());
  const fecha = fechaHoraDDMMAAAA();
  const responsable = (payload && payload.responsable) || "";
  // Si viene un factura_id existente (edición desde el historial), se reemplazan sus filas
  // en vez de insertar unas nuevas al lado — evita que "editar y guardar" duplique el registro.
  if (facturaIdProvista) {
    await run(env, "DELETE FROM facturas_calculos WHERE factura_id = ?", facturaIdProvista);
  }
  const stmts = items.map(it => env.DB.prepare(
    `INSERT INTO facturas_calculos (factura_id, fecha, producto, costo_unitario, margen, precio_venta, precio_psicologico, categoria, responsable)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(
    facturaId, fecha, String(it.producto || "").trim(),
    Number(it.costo_unitario) || 0, Number(it.margen) || 0,
    Number(it.precio_venta) || 0, Number(it.precio_psicologico) || 0,
    String(it.categoria || ""), responsable
  ));
  await batchRun(env, stmts);
  await logMsg(env, (facturaIdProvista ? "💾 Cálculo de precios actualizado: factura " : "💾 Cálculo de precios guardado: factura ") + facturaId + " · " + items.length + " producto(s)");
  return { ok: true, factura_id: facturaId, guardados: items.length };
}

// Lee el historial completo agrupado por factura_id — es lo que le faltaba a este módulo
// para sincronizar de verdad entre dispositivos: hasta ahora se guardaba en D1 pero nunca
// se volvía a consultar, así que cada celular solo veía su propio localStorage.
async function accionListarCalculosFactura(env) {
  const rows = await q(env, "SELECT * FROM facturas_calculos ORDER BY id DESC");
  const porFactura = {};
  const orden = [];
  rows.forEach(r => {
    if (!porFactura[r.factura_id]) {
      porFactura[r.factura_id] = { facturaId: r.factura_id, fecha: r.fecha, items: [] };
      orden.push(r.factura_id);
    }
    porFactura[r.factura_id].items.push({
      producto: r.producto,
      costo_unitario: r.costo_unitario,
      margen: r.margen,
      precio_venta: r.precio_venta,
      precio_psicologico: r.precio_psicologico,
      categoria: r.categoria
    });
  });
  return { ok: true, historial: orden.map(id => porFactura[id]) };
}

// Elimina todas las filas de una factura — hasta ahora "Eliminar" en el historial solo
// borraba en el navegador; en D1 la fila seguía viva y volvía a aparecer al sincronizar.
async function accionEliminarCalculoFactura(env, payload) {
  const facturaId = payload && payload.factura_id;
  if (!facturaId) throw new Error("Falta factura_id");
  await run(env, "DELETE FROM facturas_calculos WHERE factura_id = ?", facturaId);
  await logMsg(env, "🗑️ Cálculo de precios eliminado: factura " + facturaId);
  return { ok: true, factura_id: facturaId };
}

// FASE 5 — Crear categoría (chequea duplicados por nombre antes de crear una nueva en Loyverse).
async function accionCrearCategoria(env, payload) {
  const nombre = String(payload.nombre || "").trim();
  if (!nombre) throw new Error("Falta el nombre de la categoría");
  const existentes = await loyverseGetAll(env, "/categories", "categories");
  const dup = existentes.find(c => normTxtServer(c.name) === normTxtServer(nombre));
  if (dup) return { ok: true, categoria: { id: dup.id, name: dup.name }, yaExistia: true };
  const creada = await loyversePost(env, "/categories", { name: nombre });
  if (!creada || !creada.id) throw new Error("Loyverse no devolvió la categoría creada");
  await logMsg(env, "📁 Categoría creada: " + nombre);
  return { ok: true, categoria: { id: creada.id, name: creada.name } };
}

// ---------- Proveedor / Sector (clasificación de productos, ver diseño en el doc) ----------
const SECTORES_VALIDOS = ['ABARROTES', 'LACTEOS', 'FRUTAS', 'VERDURAS', 'PANADERIA', 'CARNICERIA',
  'BEBIDAS', 'CONFITES', 'CONGELADOS', 'LIMPIEZA', 'CUIDADO PERSONAL', 'MASCOTAS', 'OTROS'];

// Sectores personalizados que Edwin/Rossy crean desde la app, además de los 12 base. Sin CHECK
// (ya aprendimos con FRUTAS/VERDURAS que un CHECK en D1 obliga a reconstruir la tabla cada vez
// que la lista cambia) — la validación de qué sector es válido se hace en el código, contra la
// suma de base + personalizados.
let _sectoresPersonalizadosOk = false;
async function asegurarTablaSectoresPersonalizados(env) {
  if (_sectoresPersonalizadosOk) return;
  await run(env, "CREATE TABLE IF NOT EXISTS sectores_personalizados (nombre TEXT PRIMARY KEY)");
  _sectoresPersonalizadosOk = true;
}
async function obtenerSectoresCombinados(env) {
  await asegurarTablaSectoresPersonalizados(env);
  const extra = await q(env, "SELECT nombre FROM sectores_personalizados ORDER BY nombre");
  const combinado = [...SECTORES_VALIDOS, ...extra.map(r => r.nombre)];
  return [...new Set(combinado)].sort((a, b) => a.localeCompare(b, "es"));
}
async function sectorEsValido(env, sector) {
  if (!sector) return false;
  const combinados = await obtenerSectoresCombinados(env);
  return combinados.includes(String(sector).toUpperCase());
}
// Crea un sector nuevo — mismo patrón anti-duplicados que accionCrearProveedor (normalizado,
// sin tildes/mayúsculas, para no repetir el problema de nombres casi-iguales).
async function accionCrearSector(env, payload) {
  const nombre = String((payload && payload.nombre) || "").trim().toUpperCase();
  if (!nombre) throw new Error("Falta el nombre del sector");
  const combinados = await obtenerSectoresCombinados(env);
  const yaExiste = combinados.find(s => normTxtServer(s) === normTxtServer(nombre));
  if (yaExiste) return { ok: true, sector: yaExiste, yaExistia: true };
  await run(env, "INSERT INTO sectores_personalizados (nombre) VALUES (?)", nombre);
  await logMsg(env, "🏷️ Sector creado: " + nombre);
  return { ok: true, sector: nombre };
}

// Auto-migración defensiva: si las columnas proveedor_id/sector no existen todavía en
// `productos` (por ejemplo porque el ALTER TABLE del setup manual no llegó a ejecutarse),
// se agregan solas la primera vez que se necesitan — sin tocar filas existentes (quedan en
// NULL, compatibles con productos antiguos). _psColumnasOk cachea el resultado por instancia
// del Worker para no repetir el PRAGMA en cada request de una instancia ya caliente.
let _psColumnasOk = false;
async function asegurarColumnasProveedorSector(env) {
  if (_psColumnasOk) return;
  const cols = await q(env, "PRAGMA table_info(productos)");
  const nombres = cols.map(c => c.name);
  if (!nombres.includes("proveedor_id")) {
    await run(env, "ALTER TABLE productos ADD COLUMN proveedor_id INTEGER REFERENCES proveedores(id)");
    await logMsg(env, "🛠️ Columna proveedor_id agregada a productos (auto-migración)");
  }
  if (!nombres.includes("sector")) {
    await run(env, "ALTER TABLE productos ADD COLUMN sector TEXT CHECK (sector IN (" +
      SECTORES_VALIDOS.map(s => "'" + s + "'").join(",") + "))");
    await logMsg(env, "🛠️ Columna sector agregada a productos (auto-migración)");
  }
  _psColumnasOk = true;
  await asegurarSectorSinCheck(env);
}
// La columna `sector` se creó con un CHECK fijo (lista de SECTORES_VALIDOS al momento del
// ALTER TABLE) — cada vez que se agrega un sector nuevo al array, el CHECK queda desactualizado
// y cualquier INSERT/UPDATE con el sector nuevo revienta con "CHECK constraint failed", aunque
// sectorEsValido() lo considere válido. Es el mismo problema ya resuelto para
// sectores_personalizados (sin CHECK, validación 100% en código) — esta migración quita el
// CHECK de la columna real una sola vez, reconstruyendo la tabla a partir de su propio SQL
// (sqlite_master), sin adivinar el esquema, y recreando sus índices.
let _sectorCheckQuitadoOk = false;
async function asegurarSectorSinCheck(env) {
  if (_sectorCheckQuitadoOk) return;
  const tabla = await qOne(env, "SELECT sql FROM sqlite_master WHERE type='table' AND name='productos'");
  if (!tabla || !tabla.sql || !/sector\s+TEXT\s+CHECK\s*\(/i.test(tabla.sql)) {
    _sectorCheckQuitadoOk = true; return;   // ya no tiene CHECK (migrado antes), o no matchea el patrón esperado
  }
  try {
    const indices = await q(env, "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='productos' AND sql IS NOT NULL");
    const nuevoSql = tabla.sql
      .replace(/sector\s+TEXT\s+CHECK\s*\(\s*sector\s+IN\s*\([^)]*\)\s*\)/i, "sector TEXT")
      .replace(/CREATE TABLE\s+productos\b/i, "CREATE TABLE productos_migr_sector_tmp");
    if (nuevoSql === tabla.sql || /CHECK/i.test(nuevoSql)) throw new Error("no se pudo reescribir el CHECK de forma segura, se aborta sin tocar la tabla");
    await run(env, nuevoSql);
    await run(env, "INSERT INTO productos_migr_sector_tmp SELECT * FROM productos");
    await run(env, "DROP TABLE productos");
    await run(env, "ALTER TABLE productos_migr_sector_tmp RENAME TO productos");
    for (const idx of indices) {
      try { await run(env, idx.sql); } catch (e) { await logMsg(env, "⚠️ No se pudo recrear un índice de productos tras quitar el CHECK de sector: " + e.message); }
    }
    await logMsg(env, "🛠️ Migración: se quitó el CHECK fijo de productos.sector (ahora se valida solo con sectorEsValido(), como sectores_personalizados)");
  } catch (e) {
    await logMsg(env, "⚠️ No se pudo migrar el CHECK de sector automáticamente: " + e.message + " — seguirá fallando con sectores nuevos hasta arreglarlo a mano.");
  }
  _sectorCheckQuitadoOk = true;
}

// ---- Capa determinista (sin IA), a partir de la idea de Edwin: hoy `categoria` (Loyverse) ya
// ES el proveedor para buena parte del catálogo (viene arrastrado de cuando no existía el
// campo dedicado). Se usa como fuente directa, gratis e instantánea, antes de pensar en IA.
function normalizarComparacion(s) {
  return normTxtServer(s).replace(/[.\-_,()]/g, " ").replace(/\s+/g, " ").trim();
}
function matchProveedorPorCategoria(categoria, proveedoresRows) {
  const catNorm = normalizarComparacion(categoria || "");
  if (!catNorm) return null;
  return proveedoresRows.find(p => normalizarComparacion(p.nombre) === catNorm) || null;
}

// Palabras clave por sector (sin tildes, se comparan ya normalizadas). Si el nombre/categoría
// del producto matchea con más de un sector, se considera ambiguo y NO se adivina.
const PALABRAS_SECTOR = {
  LACTEOS: ["leche", "yogur", "yoghurt", "queso", "mantequilla", "margarina", "lacteo"],
  FRUTAS: ["palta", "platano", "manzana", "naranja", "limon", "uva", "pera", "sandia", "melon",
    "frutilla", "kiwi", "durazno", "ciruela", "mandarina", "pina", "fruta"],
  VERDURAS: ["tomate", "lechuga", "cebolla", "zanahoria", "papa", "zapallo", "pimenton", "pepino",
    "apio", "brocoli", "espinaca", "verdura", "choclo", "ajo", "betarraga"],
  PANADERIA: ["marraqueta", "hallulla", "factura", "queque", "hojaldre", "empanada", "pan amasado",
    "pan de molde", "panaderia"],
  CARNICERIA: ["vacuno", "pollo", "carne", "cerdo", "longaniza", "chorizo", "jamon", "cecina",
    "salchicha", "pavo", "carniceria"],
  BEBIDAS: ["bebida", "gaseosa", "jugo", "nectar", "agua mineral", "energetica", "cerveza", "vino",
    "pisco", "licor", "isotonica"],
  CONFITES: ["confite", "chocolate", "caramelo", "dulce", "galleta", "gomita", "chicle"],
  CONGELADOS: ["congelado", "helado", "nugget"],
  LIMPIEZA: ["detergente", "cloro", "lavaloza", "limpiador", "desinfectante", "esponja", "lejia"],
  "CUIDADO PERSONAL": ["shampoo", "champu", "jabon", "pasta de diente", "desodorante", "panal",
    "toalla higienica", "papel higienico"],
  MASCOTAS: ["perro", "gato", "mascota"],
  ABARROTES: ["arroz", "fideo", "tallarin", "aceite", "azucar", "harina", "lenteja", "poroto",
    "conserva", "atun", "cafe", "te "]
};
function inferirSectorPorPalabras(nombre, categoria) {
  const texto = normTxtServer((nombre || "") + " " + (categoria || ""));
  const encontrados = Object.keys(PALABRAS_SECTOR)
    .filter(sector => PALABRAS_SECTOR[sector].some(palabra => texto.includes(palabra)));
  return encontrados.length === 1 ? encontrados[0] : null; // más de un sector posible = ambiguo, no se adivina
}
// Detecta nombres tipo "1+1 zucaritas", "2x1 ...", "combo ...": suelen mezclar productos de
// marcas/proveedores distintos bajo una misma categoría de promoción en Loyverse (el caso real
// que encontró Edwin: "1+1 zucaritas" categorizado como "SOPROLE" sin ser un producto Soprole).
// Para estos, el match de proveedor por categoría NO es confiable — nunca se aplica solo.
function pareceriaPromoCombinada(nombre) {
  const t = normTxtServer(nombre || "");
  return /^\s*\d+\s*\+\s*\d+\b/.test(t) || /\b\d+\s*x\s*\d+\b/.test(t) || /\bcombo\b/.test(t) || /\bpromo(cion)?\b/.test(t);
}

// Tabla de productos que la clasificación masiva no pudo asignar con certeza (ver
// accionClasificarLote) — sin CHECK ni relación rígida más que la referencia por sku, así que
// una futura migración de sectores no la vuelve a romper como pasó con el CHECK de `sector`.
let _tablaPendientesOk = false;
async function asegurarTablaPendientes(env) {
  if (_tablaPendientesOk) return;
  await run(env,
    "CREATE TABLE IF NOT EXISTS clasificacion_pendiente (" +
    "sku TEXT PRIMARY KEY REFERENCES productos(sku), motivo TEXT NOT NULL, fecha TEXT DEFAULT (datetime('now')))");
  _tablaPendientesOk = true;
}

// Tabla de "pedidos pendientes" — evita pedir dos veces el mismo producto a proveedores
// distintos. sku es la clave (un producto = una fila), pero también se guarda barcode:
// si el mismo artículo físico existe bajo dos sku distintos (dos proveedores lo venden),
// el barcode permite avisar igual. Se limpia sola al recibir la mercadería en Recepción
// (ver accionLoteNuevo), no hace falta borrarla a mano.
let _tablaPedidosPendientesOk = false;
async function asegurarTablaPedidosPendientes(env) {
  if (_tablaPedidosPendientesOk) return;
  await run(env,
    "CREATE TABLE IF NOT EXISTS pedidos_pendientes (" +
    "sku TEXT PRIMARY KEY REFERENCES productos(sku), barcode TEXT, nombre TEXT, " +
    "proveedor TEXT, cantidad INTEGER, canal TEXT, fecha TEXT DEFAULT (datetime('now')))");
  await run(env, "CREATE INDEX IF NOT EXISTS idx_pedidos_pendientes_barcode ON pedidos_pendientes(barcode)");
  _tablaPedidosPendientesOk = true;
}

// Marca cada producto del carrito enviado (por WhatsApp o presencial) como "pedido realizado".
// Un solo viaje a D1 con batch() — nunca un INSERT por producto en loop (regla de rendimiento
// del proyecto). Upsert por sku: si el mismo producto se vuelve a marcar (ej. se copia el
// pedido dos veces), simplemente actualiza fecha/cantidad en vez de duplicar filas.
async function accionMarcarPedidoRealizado(env, payload) {
  payload = payload || {};
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (!items.length) throw new Error("No hay productos en el pedido a marcar");
  const canal = payload.canal === "presencial" ? "presencial" : "whatsapp";
  await asegurarTablaPedidosPendientes(env);
  const fechaHora = fechaHoraDDMMAAAA();
  const stmts = items
    .filter(it => it && it.sku)
    .map(it => env.DB.prepare(
      "INSERT INTO pedidos_pendientes (sku, barcode, nombre, proveedor, cantidad, canal, fecha) " +
      "VALUES (?,?,?,?,?,?,?) " +
      "ON CONFLICT(sku) DO UPDATE SET barcode=excluded.barcode, nombre=excluded.nombre, " +
      "proveedor=excluded.proveedor, cantidad=excluded.cantidad, canal=excluded.canal, fecha=excluded.fecha"
    ).bind(String(it.sku), it.barcode || "", it.nombre || "", it.proveedor || "", Number(it.cantidad) || 0, canal, fechaHora));
  if (!stmts.length) throw new Error("Ningún producto del pedido tenía sku válido");
  const changes = await batchRun(env, stmts);
  await logMsg(env, "🕓 Pedido marcado como realizado (" + canal + ") · " + stmts.length + " producto(s)");
  return { ok: true, marcados: stmts.length, changes };
}

function normalizarNombreProveedor(s) {
  return String(s || "").trim().replace(/\s+/g, " ");
}

// Crea un proveedor nuevo, siempre desde un flujo explícito del usuario (nunca texto libre en
// el campo del producto — ver doc). Compara normalizado (sin tildes/mayúsculas) contra los
// existentes antes de insertar, para no repetir el problema de "CCU"/"ccu"/"C.C.U.".
async function accionCrearProveedor(env, payload) {
  const nombre = normalizarNombreProveedor(payload && payload.nombre);
  if (!nombre) throw new Error("Falta el nombre del proveedor");
  const existentes = await q(env, "SELECT id, nombre FROM proveedores");
  const parecido = existentes.find(p => normTxtServer(p.nombre) === normTxtServer(nombre));
  if (parecido) return { ok: true, proveedor: parecido, yaExistia: true };
  await run(env, "INSERT INTO proveedores (nombre) VALUES (?)", nombre);
  const creado = await qOne(env, "SELECT id, nombre FROM proveedores WHERE nombre = ?", nombre);
  await logMsg(env, "🏷️ Proveedor creado: " + nombre);
  return { ok: true, proveedor: creado };
}

// Elimina un proveedor. Si hay productos que lo usan, exige un modo explícito ('reasignar' o
// 'null') — nunca borra en silencio dejando proveedor_id huérfano (ver doc, sección "eliminar").
async function accionEliminarProveedor(env, payload) {
  const id = Number(payload && payload.id);
  if (!id) throw new Error("Falta el id del proveedor");
  const prov = await qOne(env, "SELECT id, nombre FROM proveedores WHERE id = ?", id);
  if (!prov) throw new Error("Ese proveedor no existe");

  const { n } = await qOne(env, "SELECT COUNT(*) as n FROM productos WHERE proveedor_id = ?", id);
  if (n > 0) {
    const modo = payload && payload.modo;
    if (modo === "reasignar") {
      const nuevoId = Number(payload.nuevo_proveedor_id);
      if (!nuevoId) throw new Error("Falta el proveedor de reemplazo");
      const nuevo = await qOne(env, "SELECT id FROM proveedores WHERE id = ?", nuevoId);
      if (!nuevo) throw new Error("El proveedor de reemplazo no existe");
      await run(env, "UPDATE productos SET proveedor_id = ? WHERE proveedor_id = ?", nuevoId, id);
    } else if (modo === "null") {
      await run(env, "UPDATE productos SET proveedor_id = NULL WHERE proveedor_id = ?", id);
    } else {
      // Sin modo indicado: no se borra nada, se informa cuántos productos quedarían afectados
      // para que el frontend le pregunte al usuario qué hacer.
      return { ok: false, requiereModo: true, productosAfectados: n };
    }
  }

  await run(env, "DELETE FROM producto_clasificacion_aprendida WHERE proveedor_id = ?", id);
  await run(env, "DELETE FROM proveedores WHERE id = ?", id);
  await run(env,
    `INSERT INTO auditoria (fecha, accion, sku, producto, categoria, id_loyverse, stock, motivo, responsable)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    fechaHoraDDMMAAAA(), "eliminar_proveedor", "", prov.nombre, "", null, null,
    "Proveedor eliminado · productos afectados: " + n + " · modo: " + (payload.modo || "sin productos"),
    payload.responsable || "");
  await logMsg(env, "🗑️ Proveedor eliminado: " + prov.nombre + " (afectaba " + n + " producto(s))");
  return { ok: true, eliminado: prov.nombre, productosAfectados: n };
}

// Clasifica un producto en proveedor + sector. Primero busca un patrón ya aprendido (rápido y
// gratis); solo si no existe, llama a Claude en texto plano (mucho más barato que Vision).
async function accionClasificarProducto(env, payload) {
  const nombreProducto = String((payload && payload.nombre) || "").trim();
  const categoriaLoyverse = String((payload && payload.categoria) || "").trim();
  if (!nombreProducto) throw new Error("Falta el nombre del producto");

  const patronProducto = nombreProducto.toUpperCase();
  const patronCategoria = categoriaLoyverse.toUpperCase();

  let aprendido = await qOne(env,
    "SELECT proveedor_id, sector FROM producto_clasificacion_aprendida WHERE patron = ?", patronProducto);
  if (!aprendido && patronCategoria) {
    aprendido = await qOne(env,
      "SELECT proveedor_id, sector FROM producto_clasificacion_aprendida WHERE patron = ?", patronCategoria);
  }
  if (aprendido) {
    const prov = aprendido.proveedor_id
      ? await qOne(env, "SELECT id, nombre FROM proveedores WHERE id = ?", aprendido.proveedor_id)
      : null;
    return { ok: true, proveedor: prov ? prov.nombre : null, proveedor_id: prov ? prov.id : null,
      sector: aprendido.sector, confianza: "alta", origen: "aprendido" };
  }

  if (!env.ANTHROPIC_API_KEY) throw new Error("Falta configurar el secreto ANTHROPIC_API_KEY en Cloudflare");
  const proveedoresRows = await q(env, "SELECT nombre FROM proveedores ORDER BY nombre");
  const listaProveedores = proveedoresRows.map(p => p.nombre).join(", ");
  const sectoresCombinados = await obtenerSectoresCombinados(env);

  const prompt = `Eres un clasificador de productos de un minimarket chileno.
Producto: "${nombreProducto}"
Categoría actual en Loyverse: "${categoriaLoyverse || "(sin categoría)"}"

Proveedores conocidos: ${listaProveedores}
Sectores válidos: ${sectoresCombinados.join(", ")}

Responde SOLO JSON, sin texto adicional:
{"proveedor":"nombre exacto de la lista, o null si no se puede determinar","sector":"uno de los sectores válidos","confianza":"alta"|"baja"}
Si el producto no calza claramente con ningún proveedor conocido, usa null y confianza "baja".
No inventes un proveedor que no esté en la lista.`;

  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }]
      })
    });
  } catch (e) {
    throw new Error("No se pudo conectar con Claude: " + e.message);
  }
  if (!res.ok) {
    const errTxt = await res.text().catch(() => "");
    throw new Error("Claude no pudo clasificar (" + res.status + "): " + errTxt.slice(0, 200));
  }
  const data = await res.json();
  const textBlock = (data.content || []).find(b => b.type === "text");
  if (!textBlock) throw new Error("Claude no devolvió una clasificación");
  const raw = textBlock.text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/```\s*$/, "").trim();
  let out;
  try { out = JSON.parse(raw); } catch (e) { throw new Error("No se pudo interpretar la respuesta de Claude"); }

  const sectorSugerido = sectoresCombinados.includes(String(out.sector || "").toUpperCase())
    ? String(out.sector).toUpperCase() : "OTROS";
  let proveedorSugerido = null, proveedorId = null;
  if (out.proveedor) {
    const match = proveedoresRows.find(p => normTxtServer(p.nombre) === normTxtServer(out.proveedor));
    if (match) {
      const provRow = await qOne(env, "SELECT id FROM proveedores WHERE nombre = ?", match.nombre);
      proveedorSugerido = match.nombre;
      proveedorId = provRow ? provRow.id : null;
    }
  }
  const confianza = (out.confianza === "alta" && proveedorSugerido) ? "alta" : "baja";

  return { ok: true, proveedor: proveedorSugerido, proveedor_id: proveedorId, sector: sectorSugerido,
    confianza, origen: "ia" };
}

// Guarda la confirmación o corrección del usuario como patrón aprendido, para no volver a
// llamar a Claude la próxima vez que aparezca este mismo producto o categoría.
async function accionGuardarClasificacion(env, payload) {
  const patron = String((payload && payload.patron) || "").trim().toUpperCase();
  if (!patron) throw new Error("Falta el patrón (nombre de producto o categoría) a guardar");
  const sector = String((payload && payload.sector) || "").trim().toUpperCase();
  if (!(await sectorEsValido(env, sector))) throw new Error("Sector no válido: " + sector);
  const proveedorId = payload.proveedor_id != null && payload.proveedor_id !== "" ? Number(payload.proveedor_id) : null;
  if (proveedorId != null) {
    const existe = await qOne(env, "SELECT id FROM proveedores WHERE id = ?", proveedorId);
    if (!existe) throw new Error("El proveedor indicado no existe");
  }
  await run(env,
    "INSERT INTO producto_clasificacion_aprendida (patron, proveedor_id, sector) VALUES (?,?,?) " +
    "ON CONFLICT(patron) DO UPDATE SET proveedor_id = excluded.proveedor_id, sector = excluded.sector",
    patron, proveedorId, sector);
  return { ok: true };
}

// Clasifica un lote (hasta 40 SKU) del catálogo completo: proveedor + sector, sin tocar ningún
// otro campo del producto. Nunca reclasifica un producto que ya tiene proveedor o sector.
// Orden de resolución (de más barato/seguro a más costoso), sugerido por Edwin:
//   1. Patrón ya aprendido (gratis).
//   2. Proveedor: match EXACTO de la categoría de Loyverse contra un proveedor conocido —
//      determinista, sin IA (la categoría hoy ES el proveedor para buena parte del catálogo).
//   3. Sector: reglas de palabras clave sobre nombre+categoría — determinista, sin IA. Si
//      matchea más de un sector, se considera ambiguo y no se adivina.
//   4. Solo si el sector sigue sin determinarse, se manda a Claude en UN lote (nunca se le
//      pregunta el proveedor — ese siempre sale de la categoría o queda vacío).
// Solo se guarda automáticamente lo que quedó con certeza; el resto va a
// `clasificacion_pendiente` con el motivo, sin adivinar.
// Los pendientes por error técnico (conexión, cuota D1 agotada, etc. — motivo empieza con
// "Error") no son ambigüedad real: se marcan así solo porque el lote no se pudo procesar. Los
// libera para que "Clasificar catálogo" los vuelva a intentar. Los pendientes por ambigüedad
// real (proveedor incierto, sector ambiguo, promoción combinada) NO se tocan — esos sí
// necesitan revisión humana y seguirían siendo dudosos aunque se reintenten mil veces.
// Aplica proveedor y/o sector a TODOS los productos de una categoría de Loyverse — el flujo que
// pidió Edwin: él marca qué categorías son en realidad proveedores (y qué sector les cabe), y
// esto lo propaga de una sola vez. Nunca pisa un proveedor/sector que un producto ya tenga
// (manual o de otra corrida) — solo rellena lo que le falte. También queda guardado como patrón
// aprendido por categoría, así que clasificaciones futuras (individuales o masivas) lo reusan.
async function accionMapearCategoria(env, payload) {
  await asegurarColumnasProveedorSector(env);
  await asegurarTablaPendientes(env);
  const categoria = String((payload && payload.categoria) || "").trim();
  if (!categoria) throw new Error("Falta la categoría");
  const proveedorId = payload.proveedor_id != null && payload.proveedor_id !== "" ? Number(payload.proveedor_id) : null;
  const sector = payload.sector ? String(payload.sector).trim().toUpperCase() : null;
  if (proveedorId == null && !sector) throw new Error("Indica al menos un proveedor o un sector para esta categoría");
  if (proveedorId != null) {
    const existe = await qOne(env, "SELECT id FROM proveedores WHERE id = ?", proveedorId);
    if (!existe) throw new Error("El proveedor indicado no existe");
  }
  if (sector && !(await sectorEsValido(env, sector))) throw new Error("Sector no válido: " + sector);

  const patron = categoria.toUpperCase();
  await run(env,
    "INSERT INTO producto_clasificacion_aprendida (patron, proveedor_id, sector) VALUES (?,?,?) " +
    "ON CONFLICT(patron) DO UPDATE SET " +
    "proveedor_id = COALESCE(excluded.proveedor_id, producto_clasificacion_aprendida.proveedor_id), " +
    "sector = COALESCE(excluded.sector, producto_clasificacion_aprendida.sector)",
    patron, proveedorId, sector);

  let actualizadosProveedor = 0, actualizadosSector = 0;
  if (proveedorId != null) {
    const r = await run(env, "UPDATE productos SET proveedor_id = ? WHERE categoria = ? AND proveedor_id IS NULL", proveedorId, categoria);
    actualizadosProveedor = (r && r.meta && r.meta.changes) || 0;
  }
  if (sector) {
    const r2 = await run(env, "UPDATE productos SET sector = ? WHERE categoria = ? AND sector IS NULL", sector, categoria);
    actualizadosSector = (r2 && r2.meta && r2.meta.changes) || 0;
  }
  await run(env,
    "DELETE FROM clasificacion_pendiente WHERE sku IN (" +
    "SELECT sku FROM productos WHERE categoria = ? AND proveedor_id IS NOT NULL AND sector IS NOT NULL)",
    categoria).catch(() => {});

  return { ok: true, actualizadosProveedor, actualizadosSector };
}

async function accionReintentarPendientesPorError(env) {
  await asegurarTablaPendientes(env);
  const { n } = await qOne(env, "SELECT COUNT(*) as n FROM clasificacion_pendiente WHERE motivo LIKE 'Error%'");
  await run(env, "DELETE FROM clasificacion_pendiente WHERE motivo LIKE 'Error%'");
  return { ok: true, liberados: n };
}

async function accionClasificarLote(env, payload) {
  await asegurarColumnasProveedorSector(env);
  await asegurarTablaPendientes(env);
  const skus = Array.isArray(payload && payload.skus) ? payload.skus.slice(0, 40) : [];
  if (!skus.length) throw new Error("Falta la lista de SKU a clasificar");

  const placeholders = skus.map(() => "?").join(",");
  const productosRaw = await q(env,
    `SELECT sku, nombre, categoria, proveedor_id, sector FROM productos WHERE sku IN (${placeholders})`, ...skus);

  const asignados = [];
  const pendientes = [];
  const porSectorIA = []; // { sku, nombre, categoria, proveedorId, proveedorNombre }
  const proveedoresRows = await q(env, "SELECT id, nombre FROM proveedores ORDER BY nombre");

  const guardar = async (sku, proveedorId, sector, patronNombre, origen) => {
    await run(env, "UPDATE productos SET proveedor_id = ?, sector = ? WHERE sku = ?", proveedorId, sector, sku);
    await run(env, "DELETE FROM clasificacion_pendiente WHERE sku = ?", sku).catch(() => {});
    if (sector) {
      await run(env,
        "INSERT INTO producto_clasificacion_aprendida (patron, proveedor_id, sector) VALUES (?,?,?) " +
        "ON CONFLICT(patron) DO UPDATE SET proveedor_id = excluded.proveedor_id, sector = excluded.sector",
        patronNombre, proveedorId, sector);
    }
  };

  for (const p of productosRaw) {
    if (p.proveedor_id != null && p.sector != null) continue; // ya completo — no se toca

    const patronProducto = p.nombre.toUpperCase();
    const patronCategoria = (p.categoria || "").toUpperCase();

    // Se parte de lo que el producto YA tiene (si algo) y solo se rellenan los huecos —
    // nunca se pisa un proveedor o sector ya asignado, sea manual o de una corrida anterior.
    let proveedorIdFinal = p.proveedor_id;
    let sectorFinal = p.sector;
    let origen = "categoria+reglas";

    if (proveedorIdFinal == null || sectorFinal == null) {
      let aprendido = await qOne(env,
        "SELECT proveedor_id, sector FROM producto_clasificacion_aprendida WHERE patron = ?", patronProducto);
      if (!aprendido && patronCategoria) {
        aprendido = await qOne(env,
          "SELECT proveedor_id, sector FROM producto_clasificacion_aprendida WHERE patron = ?", patronCategoria);
      }
      if (aprendido) {
        if (proveedorIdFinal == null && aprendido.proveedor_id != null) { proveedorIdFinal = aprendido.proveedor_id; origen = "aprendido"; }
        if (sectorFinal == null && aprendido.sector != null) { sectorFinal = aprendido.sector; origen = "aprendido"; }
      }
    }

    // Nombres tipo "1+1 ...", "2x1 ...", "combo ..." → la categoría de Loyverse ahí suele ser
    // la promoción, no el proveedor real. Si todavía falta el proveedor, no se adivina por
    // categoría: se manda a revisión manual (el sector, si ya se resolvió, se conserva igual).
    if (proveedorIdFinal == null && pareceriaPromoCombinada(p.nombre)) {
      if (sectorFinal !== p.sector) {
        await run(env, "UPDATE productos SET sector = ? WHERE sku = ?", sectorFinal, p.sku);
      }
      const motivo = "Parece una promoción combinada (ej. \"1+1\", \"2x1\") — la categoría de Loyverse puede no reflejar el proveedor real, revisar a mano";
      await run(env,
        "INSERT INTO clasificacion_pendiente (sku, motivo) VALUES (?,?) " +
        "ON CONFLICT(sku) DO UPDATE SET motivo = excluded.motivo, fecha = datetime('now')",
        p.sku, motivo);
      pendientes.push({ sku: p.sku, nombre: p.nombre, motivo });
      continue;
    }

    // Proveedor: si todavía falta, solo por match exacto de categoría — nunca se le pide esto a la IA.
    if (proveedorIdFinal == null) {
      const provPorCategoria = matchProveedorPorCategoria(p.categoria, proveedoresRows);
      if (provPorCategoria) proveedorIdFinal = provPorCategoria.id;
    }
    // Sector: si todavía falta, reglas de palabras clave, determinista.
    if (sectorFinal == null) {
      sectorFinal = inferirSectorPorPalabras(p.nombre, p.categoria);
    }

    if (sectorFinal != null) {
      // Sector resuelto con certeza (con o sin proveedor) → queda listo, sin gastar IA.
      if (proveedorIdFinal !== p.proveedor_id || sectorFinal !== p.sector) {
        await guardar(p.sku, proveedorIdFinal, sectorFinal, patronProducto, origen);
        const provNom = proveedorIdFinal ? (proveedoresRows.find(x => x.id === proveedorIdFinal) || {}).nombre : null;
        asignados.push({ sku: p.sku, nombre: p.nombre, proveedor: provNom || null, sector: sectorFinal, origen });
      }
    } else {
      // El sector no se pudo determinar con reglas → se manda a la IA solo para el sector.
      // Si ya se identificó proveedor (existente o por categoría), se aplica de una vez.
      if (proveedorIdFinal !== p.proveedor_id) {
        await run(env, "UPDATE productos SET proveedor_id = ? WHERE sku = ?", proveedorIdFinal, p.sku);
      }
      const provNom = proveedorIdFinal ? (proveedoresRows.find(x => x.id === proveedorIdFinal) || {}).nombre : null;
      porSectorIA.push({
        sku: p.sku, nombre: p.nombre, categoria: p.categoria,
        proveedorId: proveedorIdFinal, proveedorNombre: provNom || null
      });
    }
  }

  if (porSectorIA.length) {
    if (!env.ANTHROPIC_API_KEY) throw new Error("Falta configurar el secreto ANTHROPIC_API_KEY en Cloudflare");
    const sectoresCombinados = await obtenerSectoresCombinados(env);
    const listaItems = porSectorIA.map((p, i) => {
      let linea = (i + 1) + '. Producto: "' + p.nombre + '" | Categoría Loyverse: "' + (p.categoria || "(sin categoría)") + '"';
      if (p.proveedorNombre) linea += ' | (ya se sabe que el proveedor es "' + p.proveedorNombre + '", solo falta el sector)';
      return linea;
    }).join("\n");

    const prompt = `Eres un clasificador de productos de un minimarket chileno.
El proveedor ya se resolvió por otra vía — SOLO necesito el SECTOR de cada uno de estos ${porSectorIA.length} productos.

${listaItems}

Sectores válidos: ${sectoresCombinados.join(", ")}

Responde SOLO un array JSON, sin texto adicional, con exactamente ${porSectorIA.length} objetos en el MISMO ORDEN que la lista numerada:
[{"sector":"uno de los sectores válidos","confianza":"alta"|"baja"}]
Usa "baja" cuando el producto sea ambiguo o pueda pertenecer a varios sectores. No agregues texto antes ni después del array.`;

    let res;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 3000, messages: [{ role: "user", content: prompt }] })
      });
    } catch (e) {
      throw new Error("No se pudo conectar con Claude: " + e.message);
    }
    if (!res.ok) {
      const errTxt = await res.text().catch(() => "");
      throw new Error("Claude no pudo clasificar el lote (" + res.status + "): " + errTxt.slice(0, 200));
    }
    const data = await res.json();
    const textBlock = (data.content || []).find(b => b.type === "text");
    if (!textBlock) throw new Error("Claude no devolvió clasificación para el lote");
    const raw = textBlock.text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/```\s*$/, "").trim();
    let out;
    try { out = JSON.parse(raw); } catch (e) { throw new Error("No se pudo interpretar la respuesta de Claude para el lote"); }
    if (!Array.isArray(out) || out.length !== porSectorIA.length) {
      throw new Error("Claude devolvió " + (Array.isArray(out) ? out.length : "0") + " resultados, se esperaban " + porSectorIA.length);
    }

    for (let i = 0; i < porSectorIA.length; i++) {
      const p = porSectorIA[i];
      const r = out[i] || {};
      const sectorSugerido = sectoresCombinados.includes(String(r.sector || "").toUpperCase())
        ? String(r.sector).toUpperCase() : null;
      const confianza = (r.confianza === "alta" && sectorSugerido) ? "alta" : "baja";
      const patronProducto = p.nombre.toUpperCase();

      if (confianza === "alta") {
        await guardar(p.sku, p.proveedorId, sectorSugerido, patronProducto, "ia");
        asignados.push({ sku: p.sku, nombre: p.nombre, proveedor: p.proveedorNombre, sector: sectorSugerido, origen: "ia" });
      } else {
        // El proveedor (si se conocía por categoría) ya quedó aplicado antes de llamar a la IA —
        // solo el sector queda pendiente.
        const motivo = p.proveedorNombre
          ? "Proveedor ya asignado (" + p.proveedorNombre + ") — falta confirmar el sector, es ambiguo"
          : "No se identificó proveedor ni sector con certeza — revisar manualmente";
        await run(env,
          "INSERT INTO clasificacion_pendiente (sku, motivo) VALUES (?,?) " +
          "ON CONFLICT(sku) DO UPDATE SET motivo = excluded.motivo, fecha = datetime('now')",
          p.sku, motivo);
        pendientes.push({ sku: p.sku, nombre: p.nombre, motivo });
      }
    }
  }

  return { ok: true, asignados, pendientes, procesados: skus.length };
}

// FASE 5 — Consumo interno: técnicamente es una merma con motivo fijo, para varios productos a
// la vez. Reutiliza accionMerma() tal cual — no duplica su lógica de descuento de stock.
async function accionConsumoInterno(env, payload) {
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (!items.length) throw new Error("No hay productos para registrar");
  let total = 0, n = 0, avisoStock = "";
  for (const it of items) {
    const r = await accionMerma(env, {
      sku: it.sku, cantidad: it.cantidad, costoManual: it.costoManual,
      motivo: "consumo_interno", origen: "manual", responsable: payload.responsable
    });
    total += r.costoTotal || 0;
    n++;
    if (r.avisoStock) avisoStock = r.avisoStock;
  }
  return { ok: true, resumen: { n, total, avisoStock } };
}

// FASE 5 — Eliminar productos de Loyverse (PERMANENTE). Antes de cada borrado, guarda una copia
// del producto en auditoría — así queda un rastro de qué era, por si alguien se equivoca.
async function accionEliminarProductos(env, payload) {
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (!items.length) throw new Error("No hay productos para eliminar");
  const resultados = [];
  let eliminados = 0;
  for (const it of items) {
    let statusCode = null;
    try {
      if (!it.id) throw new Error("Sin id de Loyverse — usa ♻️ Catálogo antes");

      // Respaldo en auditoría — si esto falla, NO debe impedir el borrado real en Loyverse.
      try {
        await run(env,
          `INSERT INTO auditoria (fecha, accion, sku, producto, categoria, id_loyverse, stock, motivo, responsable)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          fechaHoraDDMMAAAA(), "eliminar_producto", it.sku || "", it.nombre || "", it.categoria || "", it.id, it.stock,
          "Producto eliminado de Loyverse (permanente) — respaldo antes de borrar", payload.responsable || "");
      } catch (auditErr) {
        await logMsg(env, "⚠️ No se pudo respaldar en auditoría (" + (it.sku || it.nombre) + "): " + auditErr.message);
      }

      const res = await fetch(LOYVERSE_API + "/items/" + it.id, {
        method: "DELETE", headers: { "Authorization": "Bearer " + env.LOYVERSE_TOKEN }
      });
      statusCode = res.status;
      let bodyTxt = "";
      try { bodyTxt = await res.text(); } catch (_) {}
      await logMsg(env, "🗑️ DELETE /items/" + it.id + " → HTTP " + res.status + " (" + (it.sku || "") + " " + (it.nombre || "") + ")" + (bodyTxt ? " · " + bodyTxt.slice(0, 150) : ""));

      // Loyverse es la fuente de verdad: HTTP 2xx (borrado ahora) o 404 (ya no existía) = éxito.
      if (!res.ok && res.status !== 404) throw new Error("Loyverse devolvió HTTP " + res.status + (bodyTxt ? ": " + bodyTxt.slice(0, 150) : ""));

      // Limpieza local — si falla (por ejemplo, una referencia en variant_map bloqueando el
      // borrado en D1), NO debe hacer que se reporte error: Loyverse ya confirmó el borrado real.
      try {
        if (it.sku) {
          await run(env, "DELETE FROM variant_map WHERE sku = ?", it.sku);
          await run(env, "DELETE FROM productos WHERE sku = ?", it.sku);
        }
      } catch (dbErr) {
        await logMsg(env, "⚠️ Eliminado en Loyverse pero falló la limpieza local de " + it.sku + ": " + dbErr.message);
      }

      resultados.push({ ok: true, sku: it.sku, httpStatus: statusCode });
      eliminados++;
    } catch (e) {
      await logMsg(env, "❌ Error eliminando " + (it.sku || it.nombre) + ": " + e.message);
      resultados.push({ ok: false, sku: it.sku, error: e.message, httpStatus: statusCode });
    }
  }
  await logMsg(env, "🗑️ Productos eliminados: " + eliminados + "/" + items.length);
  return { ok: true, eliminados, resultados };
}

// FASE 5 — Crear producto nuevo en Loyverse. La más delicada de las 6: escribe un objeto
// completo nuevo (no es "leer→cambiar un campo→escribir" como el resto). Incluye la
// particularidad ya documentada de Loyverse: pricing_type="FIXED" debe ir tanto en la
// variante como en el nivel de tienda, o el precio no queda fijo.
async function accionCrearProducto(env, payload) {
  const nombre = String(payload.nombre || "").trim();
  if (!nombre) throw new Error("Falta el nombre del producto");
  const categoryId = String(payload.categoryId || "");
  if (!categoryId) throw new Error("Falta la categoría");

  // SKU numérico de 5 dígitos, siguiendo la misma secuencia que ya usa el catálogo (ej. 10008,
  // 12987...). Importante: solo mira SKUs que YA son de 5 dígitos exactos — si se considerara
  // cualquier SKU numérico, un código de barras usado por error como SKU en algún producto
  // antiguo (13+ dígitos) dispararía el cálculo a un número absurdo.
  const maxRow = await qOne(env,
    "SELECT MAX(CAST(sku AS INTEGER)) as maxsku FROM productos WHERE LENGTH(sku) = 5 AND sku GLOB '[0-9][0-9][0-9][0-9][0-9]'");
  let candidato = (maxRow && maxRow.maxsku ? maxRow.maxsku : 9999) + 1;
  if (candidato > 99999) throw new Error("Se alcanzó el máximo de SKUs de 5 dígitos (99999) — asigna uno manualmente en Loyverse");
  while (await qOne(env, "SELECT 1 FROM productos WHERE sku = ?", String(candidato))) {
    candidato++;
    if (candidato > 99999) throw new Error("Se alcanzó el máximo de SKUs de 5 dígitos (99999) — asigna uno manualmente en Loyverse");
  }
  let sku = String(candidato);
  const barcode = String(payload.barcode || "").trim();
  if (barcode) {
    const dup = await qOne(env, "SELECT sku, nombre FROM productos WHERE barcode = ?", barcode);
    if (dup) throw new Error("Ese código de barras ya está en uso por '" + dup.nombre + "' (SKU " + dup.sku + ")");
  }

  const precio = payload.precio != null ? Number(payload.precio) : null;
  const costo = Number(payload.coste) || 0;
  const trackStock = !!payload.trackStock;
  const soldByWeight = !!payload.soldByWeight;

  const stockMinimo = payload.stockMinimo != null && payload.stockMinimo !== "" ? Number(payload.stockMinimo) : null;
  const storeVariant = { store_id: STORE_ID, price: precio, pricing_type: "FIXED", available_for_sale: payload.activo !== false };
  // "Inventario bajo" de Loyverse vive a nivel de tienda dentro de la variante — solo se
  // envía si el producto sigue inventario y Edwin/Rossy pusieron un valor.
  if (trackStock && stockMinimo != null && !isNaN(stockMinimo) && stockMinimo >= 0) {
    storeVariant.low_stock = stockMinimo;
  }
  const nuevoItem = {
    item_name: nombre, category_id: categoryId, track_stock: trackStock, sold_by_weight: soldByWeight,
    is_composite: false, tax_ids: Array.isArray(payload.taxIds) ? payload.taxIds : [],
    variants: [{
      sku: sku, barcode: barcode, cost: costo, default_price: precio, default_pricing_type: "FIXED",
      stores: [storeVariant]
    }]
  };

  // Si un intento anterior creó el producto en Loyverse pero falló al guardarlo en D1 (huérfano),
  // el candidato de SKU calculado arriba (basado en el máximo local) puede chocar con ese
  // huérfano. En vez de fallar directo, reintenta con el siguiente SKU unas cuantas veces.
  let creado = null;
  let intentosSku = 0;
  while (!creado) {
    nuevoItem.variants[0].sku = sku;
    try {
      creado = await loyversePost(env, "/items", nuevoItem);
    } catch (e) {
      const esDuplicado = /duplicate variant sku/i.test(e.message || "");
      if (!esDuplicado || intentosSku >= 20) throw e;
      intentosSku++;
      candidato++;
      if (candidato > 99999) throw new Error("Se alcanzó el máximo de SKUs de 5 dígitos (99999) — asigna uno manualmente en Loyverse");
      const skuAnterior = sku;
      sku = String(candidato);
      await logMsg(env, "⚠️ SKU " + skuAnterior + " ya existía en Loyverse (probable huérfano de un intento anterior) — reintentando con " + sku);
    }
  }
  const v = creado && creado.variants && creado.variants[0];
  if (!v || !v.variant_id) throw new Error("Loyverse no devolvió la variante creada — no se pudo confirmar");

  // Confirmación: vuelve a leer el ítem para asegurarnos de que Loyverse lo guardó de verdad
  let confirmado = true, enEstaTienda = true;
  try {
    const verif = await loyverseGet(env, "/items/" + creado.id, {});
    confirmado = !!(verif && verif.id === creado.id);
    const vv = verif && verif.variants && verif.variants.find(x => x.variant_id === v.variant_id);
    enEstaTienda = !!(vv && vv.stores && vv.stores.some(s => s.store_id === STORE_ID));
  } catch (e) { confirmado = false; }

  // El producto se guarda en D1 con stock=0 PRIMERO, para que — si hay fecha de vencimiento —
  // "registrar lote" (que SUMA sobre el stock que ya tiene en caché) parta de una base de 0 y
  // no duplique el stock inicial que se está por asignar.
  // Proveedor/Sector son opcionales al crear (el usuario puede clasificarlo después desde
  // la Ficha) — se validan igual que en accionEditarProducto si vienen incluidos.
  if (payload.proveedor_id != null || payload.sector) {
    await asegurarColumnasProveedorSector(env);
  }
  let proveedorIdInicial = null;
  if (payload.proveedor_id != null && payload.proveedor_id !== "") {
    proveedorIdInicial = Number(payload.proveedor_id);
    const provOk = await qOne(env, "SELECT id FROM proveedores WHERE id = ?", proveedorIdInicial);
    if (!provOk) throw new Error("El proveedor indicado no existe");
  }
  let sectorInicial = null;
  if (payload.sector) {
    sectorInicial = String(payload.sector).trim().toUpperCase();
    if (!(await sectorEsValido(env, sectorInicial))) throw new Error("Sector no válido: " + sectorInicial);
  }

  try {
    await run(env,
      `INSERT INTO productos (sku, id_loyverse, variant_id, nombre, categoria, costo, precio, stock, track_stock, barcode, sold_by_weight, proveedor_id, sector, fecha_creacion, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, date('now'), datetime('now'))`,
      sku, creado.id, v.variant_id, nombre, payload.categoriaNombre || "SIN CATEGORÍA",
      costo, precio || 0, trackStock ? 0 : null, trackStock ? 1 : 0, barcode, soldByWeight ? 1 : 0,
      proveedorIdInicial, sectorInicial);
  } catch (e) {
    throw new Error("El producto SÍ se creó en Loyverse (id " + creado.id + ", SKU " + sku +
      ") pero falló al guardarlo en la base local — no lo vuelvas a crear, hay que arreglarlo a mano. Detalle: INSERT productos → " + e.message);
  }
  try {
    await run(env, `INSERT INTO variant_map (variant_id, sku) VALUES (?,?)`, v.variant_id, sku);
  } catch (e) {
    throw new Error("El producto quedó creado en Loyverse y en la tabla productos (SKU " + sku +
      ") pero falló al mapear la variante — puede que quede sin sincronizar ventas. Detalle: INSERT variant_map → " + e.message);
  }

  // Fija el stock inicial — por UN SOLO camino, nunca los dos:
  // - Si hay fecha de vencimiento: pasa por accionLoteNuevo (crea el lote Y suma el stock a la vez).
  // - Si no: se fija directo, sin pasar por ningún camino que también sume.
  const stockInicialNum = Number(payload.stockInicial) || 0;
  let stockFinal = trackStock ? 0 : null;
  if (trackStock && stockInicialNum > 0) {
    if (payload.fechaVencimiento) {
      try {
        await accionLoteNuevo(env, { sku, cantidad: stockInicialNum, fechaVencimiento: payload.fechaVencimiento });
        stockFinal = stockInicialNum;
      } catch (e) {
        // Si falla el lote (ej. fecha de vencimiento con conflicto de datos), el producto ya
        // quedó creado — igual aseguramos que el stock quede correcto, y dejamos rastro en los
        // logs para poder diagnosticar la causa real del fallo del lote sin adivinar.
        await logMsg(env, "⚠️ No se pudo registrar el lote de vencimiento al crear " + nombre + " (" + sku + "): " + e.message);
        try {
          await loyversePost(env, "/inventory", {
            inventory_levels: [{ variant_id: v.variant_id, store_id: STORE_ID, stock_after: stockInicialNum }]
          });
          await run(env, "UPDATE productos SET stock = ? WHERE sku = ?", stockInicialNum, sku);
          stockFinal = stockInicialNum;
        } catch (e2) {
          await logMsg(env, "⚠️ Tampoco se pudo fijar el stock inicial de " + nombre + " (" + sku + ") tras fallar el lote: " + e2.message);
        }
      }
    } else {
      await loyversePost(env, "/inventory", {
        inventory_levels: [{ variant_id: v.variant_id, store_id: STORE_ID, stock_after: stockInicialNum }]
      });
      await run(env, "UPDATE productos SET stock = ? WHERE sku = ?", stockInicialNum, sku);
      stockFinal = stockInicialNum;
    }
  }

  try {
    await run(env,
      `INSERT INTO auditoria (fecha, accion, sku, producto, categoria, id_loyverse, stock, motivo, responsable)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      fechaHoraDDMMAAAA(), "crear_producto", sku, nombre, payload.categoriaNombre || "", creado.id, stockFinal,
      "Producto creado", payload.responsable || "");
  } catch (e) {
    // La auditoría es un registro secundario — si falla no debe tirar abajo la creación del
    // producto, que a esta altura ya está guardada correctamente.
    await logMsg(env, "⚠️ No se pudo registrar en auditoría la creación de " + nombre + " (" + sku + "): " + e.message);
  }
  await logMsg(env, "🆕 Producto creado: " + nombre + " (" + sku + ")");

  return {
    ok: true,
    producto: {
      ref: sku, nombre, prov: payload.categoriaNombre || "SIN CATEGORÍA", id: creado.id, vid: v.variant_id,
      stock: stockFinal, precio: precio, costo: costo, track: trackStock, barcode, peso: soldByWeight,
      confirmado, enEstaTienda
    }
  };
}

async function accionAsignarLlegada(env, payload) {
  const fi = Number(payload.filaIndex);
  const row = await qOne(env, "SELECT * FROM llegadas WHERE id = ?", fi);
  if (!row) throw new Error("Llegada no encontrada");
  const cantidad = Number(row.aumento);
  const lote = await accionLoteNuevo(env, { sku: row.sku, cantidad, fechaVencimiento: payload.fechaVencimiento });
  await run(env, "UPDATE llegadas SET estado='asignado', fecha_vencimiento_asignada=?, fecha_resolucion=? WHERE id=?",
    payload.fechaVencimiento, fechaDDMMAAAA(), fi);
  await logMsg(env, "🔔 Llegada resuelta: " + row.producto + " · vence " + payload.fechaVencimiento);
  return lote;
}

async function accionIgnorarLlegada(env, payload) {
  const fi = Number(payload.filaIndex);
  const row = await qOne(env, "SELECT * FROM llegadas WHERE id = ?", fi);
  if (!row) throw new Error("Llegada no encontrada");
  await run(env, "UPDATE llegadas SET estado='ignorado', fecha_resolucion=? WHERE id=?", fechaDDMMAAAA(), fi);
  return { sku: row.sku, nombre: row.producto };
}

// ============================================================
//  ABC + PRECIFICACIÓN (clasificación 80/95/100 + margen sobre venta)
// ============================================================
async function asegurarTablaABC(env) {
  await run(env,
    `CREATE TABLE IF NOT EXISTS clasificacion_abc (
       sku TEXT PRIMARY KEY,
       venta_total REAL,
       pct_participacion REAL,
       pct_acumulado REAL,
       clase TEXT,
       periodo_dias INTEGER,
       calculado_en TEXT
     )`);
}

// Redondeo psicológico: sube al .90 o .50 más cercano por arriba,
// preservando la unidad de mil (nunca baja el precio calculado).
function redondearPsicologico(precio) {
  if (!precio || precio <= 0) return 0;
  const base = Math.floor(precio / 100) * 100; // piso a la centena
  const candidatos = [base - 100 + 90, base - 100 + 50, base + 90, base + 50, base + 100 + 90];
  const elegido = candidatos.find(c => c >= precio) ?? (Math.ceil(precio / 10) * 10 + 90);
  return elegido;
}

// Calcula ABC sobre todo el catálogo con venta > 0 en el período dado.
async function calcularABC(env, periodoDias) {
  await asegurarTablaABC(env);
  const dias = Number(periodoDias) || 30;
  const hoy = chileTodayISODate();

  const rows = await q(env,
    `SELECT sku, SUM(venta) AS venta_total
     FROM ventas_diarias
     WHERE fecha >= date(?, '-' || ? || ' day')
     GROUP BY sku
     HAVING venta_total > 0
     ORDER BY venta_total DESC`,
    hoy, dias);

  const totalGeneral = rows.reduce((s, r) => s + r.venta_total, 0);
  if (totalGeneral <= 0) return { ok: true, clasificados: 0 };

  // Cortes ABC estándar (80/95/100).
  const CORTE_A = 0.80, CORTE_B = 0.95;

  let acumulado = 0;
  const registros = rows.map(r => {
    acumulado += r.venta_total;
    const pctAcum = acumulado / totalGeneral;
    const clase = pctAcum <= CORTE_A ? 'A' : (pctAcum <= CORTE_B ? 'B' : 'C');
    return {
      sku: r.sku,
      venta_total: r.venta_total,
      pct_participacion: r.venta_total / totalGeneral,
      pct_acumulado: pctAcum,
      clase
    };
  });

  const nowStr = fechaHoraDDMMAAAA();
  await run(env, "DELETE FROM clasificacion_abc");
  const stmts = registros.map(r => env.DB.prepare(
    `INSERT INTO clasificacion_abc
     (sku, venta_total, pct_participacion, pct_acumulado, clase, periodo_dias, calculado_en)
     VALUES (?,?,?,?,?,?,?)`
  ).bind(r.sku, r.venta_total, r.pct_participacion, r.pct_acumulado, r.clase, dias, nowStr));
  await batchRun(env, stmts);

  await logMsg(env, "📊 ABC recalculado: " + registros.length + " SKU · período " + dias + "d");
  return { ok: true, clasificados: registros.length, periodo_dias: dias };
}

async function repABC(env) {
  await asegurarTablaABC(env);
  return q(env, "SELECT * FROM clasificacion_abc ORDER BY pct_acumulado ASC");
}

// Margen sugerido según clase — retail minimarket, margen sobre venta.
const MARGEN_SUGERIDO_ABC = {
  A: { min: 0.25, max: 0.35 },
  B: { min: 0.30, max: 0.40 },
  C: { min: 0.40, max: 0.50 }
};

// Calcula precio sugerido para un SKU según su clase ABC + margen deseado.
// No escribe nada — el frontend siempre confirma antes de aplicar.
async function accionSugerirPrecioABC(env, payload) {
  const sku = String((payload && payload.sku) || "");
  if (!sku) throw new Error("Falta el SKU");
  const it = await getProducto(env, sku);
  if (!it) throw new Error("SKU no encontrado: " + sku);

  await asegurarTablaABC(env);
  const clasif = await qOne(env, "SELECT * FROM clasificacion_abc WHERE sku = ?", sku);
  const clase = clasif ? clasif.clase : null;
  const rango = clase ? MARGEN_SUGERIDO_ABC[clase] : null;

  const margen = payload.margen != null && payload.margen !== ""
    ? Number(payload.margen)
    : (rango ? (rango.min + rango.max) / 2 : 0.30);
  if (isNaN(margen) || margen <= 0 || margen >= 1) throw new Error("Margen inválido (debe ser 0-1, ej. 0.30)");

  const costo = Number(it.costo || 0);
  const precioCalculado = costo > 0 ? costo / (1 - margen) : 0;
  const precioPsicologico = redondearPsicologico(precioCalculado);

  return {
    ok: true, sku, nombre: it.nombre, costo, clase,
    pct_participacion: clasif ? clasif.pct_participacion : null,
    margen_usado: margen,
    margen_rango_sugerido: rango,
    precio_calculado: Math.round(precioCalculado),
    precio_psicologico: precioPsicologico,
    precio_actual: it.precio
  };
}

// Aplica el precio: reutiliza accionEditarPrecio (misma auditoría +
// historial + sync a Loyverse), no duplica lógica de escritura.
async function accionAplicarPrecioABC(env, payload) {
  const sugerencia = await accionSugerirPrecioABC(env, payload);
  const precioFinal = payload.usar_psicologico === false
    ? sugerencia.precio_calculado
    : sugerencia.precio_psicologico;

  return accionEditarPrecio(env, {
    sku: sugerencia.sku,
    precio: precioFinal,
    responsable: payload.responsable || "ABC"
  });
}

// ============================================================
//  ROUTER
// ============================================================
export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

    const url = new URL(request.url);
    const action = url.searchParams.get("action") || "";

    try {
      // ---------- GET: reportes de solo lectura ----------
      if (request.method === "GET") {
        if (action === "sincosto") return json({ ok: true, reporte: await repSinCosto(env) });
        if (action === "vencimientos") return json({ ok: true, lotes: await repVencimientosActivos(env) });
        if (action === "historial_mermas") return json({ ok: true, historial: await repHistorialMermas(env, 50) });
        if (action === "config_categorias") return json({ ok: true, categoriasCambio: await repCategoriasCambio(env) });
        if (action === "llegadas") return json({ ok: true, llegadas: await repLlegadasPendientes(env) });
        if (action === "consumo_categoria") return json({ ok: true, resumen: await repConsumoCategoria(env, 30) });
        if (action === "ficha_producto") {
          const sku = url.searchParams.get("sku");
          if (!sku) return json({ ok: false, error: "Falta el parámetro sku" }, 400);
          return json({ ok: true, ficha: await repFichaProducto(env, sku) });
        }
        if (action === "catalogo_crear") {
          const r = await repCatalogoCrear(env);
          return json({ ok: true, categorias: r.categorias, impuestos: r.impuestos });
        }
        if (action === "ver_logs") {
          const n = Math.min(Number(url.searchParams.get("n")) || 30, 200);
          const logs = await q(env, "SELECT * FROM logs ORDER BY id DESC LIMIT ?", n);
          return json({ ok: true, logs });
        }
        if (action === "proveedores") {
          const proveedores = await q(env,
            "SELECT p.id, p.nombre, COUNT(pr.sku) AS productos FROM proveedores p " +
            "LEFT JOIN productos pr ON pr.proveedor_id = p.id GROUP BY p.id, p.nombre ORDER BY p.nombre");
          return json({ ok: true, proveedores, sectores: await obtenerSectoresCombinados(env) });
        }
        if (action === "productos_sin_clasificar") {
          await asegurarColumnasProveedorSector(env);
          await asegurarTablaPendientes(env);
          const productos = await q(env,
            "SELECT sku, nombre, categoria FROM productos " +
            "WHERE (proveedor_id IS NULL OR sector IS NULL) " +
            "AND sku NOT IN (SELECT sku FROM clasificacion_pendiente) ORDER BY sku");
          return json({ ok: true, productos, total: productos.length });
        }
        if (action === "pendientes_clasificacion") {
          await asegurarTablaPendientes(env);
          const pendientes = await q(env,
            "SELECT cp.sku, cp.motivo, cp.fecha, p.nombre FROM clasificacion_pendiente cp " +
            "JOIN productos p ON p.sku = cp.sku ORDER BY cp.fecha DESC");
          return json({ ok: true, pendientes });
        }
        if (action === "productos_por_revisar") {
          // A diferencia de productos_sin_clasificar (ambos campos vacíos, para la clasificación
          // masiva), esta lista es para revisión manual: cualquier producto al que le falte
          // proveedor Y/O sector — no toca ni incluye los que ya tienen ambos campos correctos.
          await asegurarColumnasProveedorSector(env);
          await asegurarTablaPendientes(env);
          const productos = await q(env,
            "SELECT p.sku, p.nombre, p.categoria, p.proveedor_id, pr.nombre AS proveedor_nombre, " +
            "p.sector, cp.motivo AS pendiente_motivo FROM productos p " +
            "LEFT JOIN proveedores pr ON pr.id = p.proveedor_id " +
            "LEFT JOIN clasificacion_pendiente cp ON cp.sku = p.sku " +
            "WHERE p.proveedor_id IS NULL OR p.sector IS NULL ORDER BY p.nombre LIMIT 3000");
          return json({ ok: true, productos, total: productos.length });
        }
        if (action === "categorias_resumen") {
          await asegurarColumnasProveedorSector(env);
          const categorias = await q(env,
            "SELECT categoria, COUNT(*) AS total, " +
            "SUM(CASE WHEN proveedor_id IS NULL THEN 1 ELSE 0 END) AS sin_proveedor, " +
            "SUM(CASE WHEN sector IS NULL THEN 1 ELSE 0 END) AS sin_sector, " +
            "MAX(nombre) AS ejemplo FROM productos " +
            "WHERE categoria IS NOT NULL AND TRIM(categoria) != '' " +
            "GROUP BY categoria ORDER BY total DESC");
          // Desglose general — incluye los productos sin categoría de Loyverse, que la lista de
          // arriba no puede mostrar (no hay bajo qué categoría agruparlos).
          const desgloseRow = await qOne(env,
            "SELECT " +
            "SUM(CASE WHEN categoria IS NULL OR TRIM(categoria)='' THEN 1 ELSE 0 END) AS sin_categoria, " +
            "SUM(CASE WHEN sector IS NULL THEN 1 ELSE 0 END) AS sin_sector, " +
            "SUM(CASE WHEN proveedor_id IS NULL THEN 1 ELSE 0 END) AS sin_proveedor, " +
            "COUNT(*) AS total FROM productos");
          return json({ ok: true, categorias, total: categorias.length, desglose: desgloseRow });
        }
        if (action === "recalcular_vencimientos") {
          const n = await recalcularVencimientosD1(env);
          return json({ ok: true, recalculados: n });
        }
        if (action === "abc") return json({ ok: true, abc: await repABC(env) });
        if (action === "abc_calcular") {
          const periodo = Number(url.searchParams.get("periodo")) || 30;
          return json(await calcularABC(env, periodo));
        }
        // sync / full / recargar_historial / (vacío) → payload del dashboard.
        let synced = false, syncMsg = "";
        if (action === "sync") {
          try {
            const nStock = await refreshInventoryStock(env);
            const nVentas = await syncVentasHoy(env);
            await logMsg(env, "⚡ Sync rápido OK · stock actualizado:" + nStock + " · ventas hoy:" + nVentas);
            synced = true;
          } catch (err) { syncMsg = err.message; await logMsg(env, "⚠️ Sync rápido falló: " + err.message); }
        } else if (action === "full") {
          try {
            const nCat = await refreshFullCatalog(env);
            const nVentas = await syncVentasHoy(env);
            await logMsg(env, "🔄 Sync completo OK · productos:" + nCat + " · ventas hoy:" + nVentas);
            synced = true;
          } catch (err) { syncMsg = err.message; await logMsg(env, "⚠️ Sync completo falló: " + err.message); }
        } else if (action === "recargar_historial") {
          try {
            const r = await recargarHistorial(env);
            syncMsg = "Historial recargado: " + r.dias + " días";
            synced = true;
          } catch (err) { syncMsg = err.message; await logMsg(env, "⚠️ Recarga de historial falló: " + err.message); }
        }
        return json(await payloadDashboard(env, synced, syncMsg));
      }

      // ---------- POST: escritura ----------
      if (request.method === "POST") {
        const body = await request.json();
        let result;
        switch (body.action) {
          case "merma":
            result = { ok: true, fila: await accionMerma(env, body.payload) }; break;
          case "lote_nuevo":
            result = { ok: true, fila: await accionLoteNuevo(env, body.payload) }; break;
          case "revisar_lote":
            result = { ok: true, fila: await accionRevisarLote(env, body.payload) }; break;
          case "eliminar_lote":
            result = { ok: true, fila: await accionEliminarLote(env, body.payload) }; break;
          case "marcar_cambiado":
            result = { ok: true, fila: await accionMarcarCambiado(env, body.payload) }; break;
          case "marcar_descuento_factura":
            result = { ok: true, fila: await accionMarcarDescuentoFactura(env, body.payload) }; break;
          case "editar_fecha_venc":
            result = await accionEditarFecha(env, body.payload); break;
          case "corregir_motivo_merma":
            result = await accionCorregirMotivoMerma(env, body.payload); break;
          case "eliminar_merma":
            result = await accionEliminarMerma(env, body.payload); break;
          case "ajustar_stock":
            result = await accionAjustarStock(env, body.payload); break;
          case "habilitar_track_stock":
            result = await accionHabilitarTrackStock(env, body.payload); break;
          case "editar_producto":
            result = await accionEditarProducto(env, body.payload); break;
          case "editar_codigo_barras":
            result = await accionEditarCodigoBarras(env, body.payload); break;
          case "editar_precio":
            result = await accionEditarPrecio(env, body.payload); break;
          case "sugerir_precio_abc":
            result = await accionSugerirPrecioABC(env, body.payload); break;
          case "aplicar_precio_abc":
            result = await accionAplicarPrecioABC(env, body.payload); break;
          case "crear_categoria":
            result = await accionCrearCategoria(env, body.payload); break;
          case "crear_proveedor":
            result = await accionCrearProveedor(env, body.payload); break;
          case "crear_sector":
            result = await accionCrearSector(env, body.payload); break;
          case "eliminar_proveedor":
            result = await accionEliminarProveedor(env, body.payload); break;
          case "clasificar_producto":
            result = await accionClasificarProducto(env, body.payload); break;
          case "guardar_clasificacion":
            result = await accionGuardarClasificacion(env, body.payload); break;
          case "clasificar_lote":
            result = await accionClasificarLote(env, body.payload); break;
          case "reintentar_pendientes_error":
            result = await accionReintentarPendientesPorError(env); break;
          case "mapear_categoria":
            result = await accionMapearCategoria(env, body.payload); break;
          case "crear_producto":
            result = await accionCrearProducto(env, body.payload); break;
          case "eliminar_productos":
            result = await accionEliminarProductos(env, body.payload); break;
          case "consumo_interno":
            result = await accionConsumoInterno(env, body.payload); break;
          case "asignar_llegada":
            result = { ok: true, fila: await accionAsignarLlegada(env, body.payload) }; break;
          case "ignorar_llegada":
            result = { ok: true, item: await accionIgnorarLlegada(env, body.payload) }; break;
          case "procesar_factura":
            result = await accionProcesarFactura(env, body.payload); break;
          case "buscar_imagen_producto":
            result = await accionBuscarImagenProducto(env, body.payload); break;
          case "subir_imagen_producto":
            result = await accionSubirImagenProducto(env, body.payload); break;
          case "guardar_calculo_precio":
            result = await accionGuardarCalculoPrecio(env, body.payload); break;
          case "listar_calculos_factura":
            result = await accionListarCalculosFactura(env); break;
          case "eliminar_calculo_factura":
            result = await accionEliminarCalculoFactura(env, body.payload); break;
          case "marcar_pedido_realizado":
            result = await accionMarcarPedidoRealizado(env, body.payload); break;
          case "agregar_proveedor_extra":
            result = await accionAgregarProveedorExtra(env, body.payload); break;
          case "quitar_proveedor_extra":
            result = await accionQuitarProveedorExtra(env, body.payload); break;
          default:
            result = { ok: false, error: "Acción no disponible todavía en el sistema nuevo: " + body.action + " (sigue usando Apps Script para esto por ahora)" };
        }
        return json(result);
      }

      return json({ ok: false, error: "Método no soportado" }, 405);
    } catch (err) {
      await logMsg(env, "❌ Error Worker: " + err.message);
      return json({ ok: false, error: err.message }, 500);
    }
  },

  // ============================================================
  //  CRON DIARIO — equivalente a syncDiario() de Codigo.gs
  //  Corre solo, de madrugada (configurado en wrangler.toml).
  //  1) Refresca el catálogo completo (precios/costos/stock reales)
  //  2) Trae las ventas de AYER y las guarda en ventas_diarias
  //  3) Recalcula estado/prioridad de todos los lotes de vencimiento activos
  // ============================================================
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      await logMsg(env, "🌙 Refresco diario iniciado");
      try {
        const nCat = await refreshFullCatalog(env);

        const hoy0iso = chileMidnightUtcISO();
        const ayer0 = new Date(new Date(hoy0iso).getTime() - 86400000);
        const ventasAyer = await descargarVentas(env, ayer0.toISOString(), hoy0iso);
        await guardarVentasEnD1(env, ventasAyer);

        const nHoy = await syncVentasHoy(env);
        const nVenc = await recalcularVencimientosD1(env);

        await logMsg(env, "✅ Refresco diario OK · productos:" + nCat +
          " · ventas ayer:" + ventasAyer.length + " líneas · ventas hoy:" + nHoy +
          " · lotes recalculados:" + nVenc);
      } catch (err) {
        await logMsg(env, "❌ Error refresco diario: " + err.message);
      }
    })());
  }
};
