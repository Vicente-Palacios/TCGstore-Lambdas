// Lambda 3 - report-stock-alert
// Trigger: cola SQS "report-stock-alerts" (suscrita al topic SNS "report-events" con filtro
// type = report.requested).
// Responsabilidad: cada vez que se solicita un informe, revisar en Supabase las cartas con stock bajo
// (tabla cards, stock <= LOW_STOCK_THRESHOLD) y publicar un aviso de reposicion en el servicio de avisos.
// Si no hay cartas con stock bajo, no publica nada (solo lo registra en el log).
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
  max: 1,
  connectionTimeoutMillis: 5000,
});

const SUPPORTED_TYPE = "report.requested";
const MAX_TEXT = 2000; // la API de avisos acepta hasta 2000 caracteres

// Mismo criterio que el panel de Admin del front ("Cartas con stock bajo (<= 2)"), configurable.
function threshold() {
  const n = Number.parseInt(process.env.LOW_STOCK_THRESHOLD ?? "2", 10);
  return Number.isFinite(n) && n >= 0 ? n : 2;
}

const currency = new Intl.NumberFormat("es-CL", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

// Fecha legible en hora de Chile (el BFF envia ISO en UTC). Si no se puede leer, se muestra tal cual.
const TZ = process.env.REPORT_TIMEZONE || "America/Santiago";
const dateFmt = new Intl.DateTimeFormat("es-CL", {
  timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
});
function formatDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? (iso ?? "sin fecha") : dateFmt.format(d).replace(",", "");
}

// Corta respetando emojis (un emoji ocupa 2 unidades de texto en JavaScript: .slice podria partirlo).
function fit(text) {
  const chars = Array.from(text);
  return chars.length > MAX_TEXT ? chars.slice(0, MAX_TEXT - 1).join("") + "…" : text;
}

function parse(record) {
  const envelope = JSON.parse(record.body);
  return JSON.parse(envelope.Message);
}

// Primero las agotadas (stock 0), luego de menor a mayor stock; a igual stock, la mas cara primero
// (es la que mas venta se pierde si no se repone).
async function lowStockCards(max) {
  const { rows } = await pool.query(
    `SELECT name, game, set_name, price, COALESCE(stock, 0) AS stock
       FROM cards
      WHERE COALESCE(stock, 0) <= $1
      ORDER BY COALESCE(stock, 0) ASC, price DESC NULLS LAST, name ASC
      LIMIT 50`,
    [max],
  );
  return rows;
}

function buildText(request, cards, max) {
  const agotadas = cards.filter((c) => Number(c.stock) === 0).length;
  const resumen = `${cards.length} ${cards.length === 1 ? "carta" : "cartas"} con stock ≤ ${max}` +
    (agotadas > 0 ? ` · ${agotadas} agotada${agotadas === 1 ? "" : "s"}` : "");
  const header = [
    `🚨 ALERTA DE STOCK · TCG STORE`,
    `📉 ${resumen}`,
    `👤 ${request.requester ?? "desconocido"} · 📅 ${formatDate(request.requestedAt)} · 🆔 ${String(request.requestId ?? "").slice(0, 8)}`,
    "━━━━━━━━━━━━━━━━━━━━",
  ];
  const lines = cards.map((c) => {
    const edition = c.set_name ? ` · ${c.set_name}` : "";
    const estado = Number(c.stock) === 0 ? "❌ AGOTADA" : `⚠️ quedan ${c.stock}`;
    const precio = c.price == null ? "sin precio" : currency.format(Number(c.price));
    return `${estado} — ${c.name} (${c.game}${edition}) · 💵 ${precio}`;
  });
  return fit([...header, ...lines, "━━━━━━━━━━━━━━━━━━━━", "🛒 Recomendación: reponer estas cartas."].join("\n"));
}

async function publish(text) {
  const url = process.env.NOTICE_URL;
  const key = process.env.NOTICE_API_KEY;
  if (!url || !key) throw new Error("Faltan NOTICE_URL y/o NOTICE_API_KEY");

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `ApiKey ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    redirect: "manual",
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    throw new Error(`La API de avisos respondio HTTP ${res.status}`);
  }
  console.log(`Alerta publicada (HTTP ${res.status})`);
}

exports.handler = async (event) => {
  // Respuesta parcial de lote: si un mensaje falla, solo ese se reintenta (3 intentos y luego DLQ).
  const batchItemFailures = [];
  const max = threshold();

  for (const record of event.Records) {
    try {
      const { type, body } = parse(record);
      if (type !== SUPPORTED_TYPE) {
        throw new Error(`Tipo de mensaje no soportado: ${type}`);
      }
      const cards = await lowStockCards(max);
      if (cards.length === 0) {
        console.log("Sin cartas con stock bajo:", body.requestId, `(umbral ${max})`);
        continue;
      }
      await publish(buildText(body, cards, max));
      console.log("Alerta de stock generada:", body.requestId, "con", cards.length, "cartas");
    } catch (err) {
      console.error("Error procesando mensaje", record.messageId, "-", err.message);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};
