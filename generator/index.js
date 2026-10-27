// Lambda 2 - report-generator
// Trigger: cola SQS "report-generation" (suscrita al topic SNS "report-events" con filtro
// type = report.requested o report.regenerate).
// Responsabilidad: leer de Supabase las 10 cartas mas caras (tabla cards), armar el informe
// y publicarlo en el servicio de avisos del profesor (POST /api/saas/notices).
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
  max: 1,
  connectionTimeoutMillis: 5000,
});

// Esta Lambda atiende la solicitud original (report.requested) y los re-envios (report.regenerate).
const TYPES = ["report.requested", "report.regenerate"];
const MAX_TEXT = 2000; // la API de avisos acepta hasta 2000 caracteres

// Mismo formato que usa el front (AdminPage): es-CL con USD.
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

// Medallas para el podio y numeros con emoji para el resto (hasta 10).
const RANK = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

function parse(record) {
  const envelope = JSON.parse(record.body);
  return JSON.parse(envelope.Message);
}

// La tabla cards es la que crea el BFF (entidad Card, JPA): id, name, game, set_name, rarity,
// condition, price, stock, image_url.
async function topCards() {
  const { rows } = await pool.query(
    `SELECT name, game, set_name, price, stock
       FROM cards
      WHERE price IS NOT NULL
      ORDER BY price DESC
      LIMIT 10`,
  );
  return rows;
}

function buildText(request, cards) {
  const header = [
    `🃏 INFORME TCG STORE · Top ${cards.length} cartas de mayor precio`,
    `👤 ${request.requester ?? "desconocido"} · 📅 ${formatDate(request.requestedAt)} · 🆔 ${String(request.requestId ?? "").slice(0, 8)}`,
    "━━━━━━━━━━━━━━━━━━━━",
  ];
  if (cards.length === 0) {
    return fit([...header, "📭 No hay cartas con precio registrado en el inventario."].join("\n"));
  }
  const lines = cards.map((c, i) => {
    const edition = c.set_name ? ` · ${c.set_name}` : "";
    const stock = Number(c.stock ?? 0) === 0 ? "❌ agotada" : `📦 ${c.stock}`;
    return `${RANK[i] ?? `${i + 1}.`} ${c.name} (${c.game}${edition}) — 💵 ${currency.format(Number(c.price))} · ${stock}`;
  });
  const totalValue = cards.reduce((sum, c) => sum + Number(c.price) * Number(c.stock ?? 0), 0);
  const units = cards.reduce((sum, c) => sum + Number(c.stock ?? 0), 0);
  return fit([
    ...header,
    ...lines,
    "━━━━━━━━━━━━━━━━━━━━",
    `💰 Valor en stock del top: ${currency.format(totalValue)} (${units} unidades)`,
  ].join("\n"));
}

async function publish(text) {
  const url = process.env.NOTICE_URL;
  const key = process.env.NOTICE_API_KEY;
  if (!url || !key) throw new Error("Faltan NOTICE_URL y/o NOTICE_API_KEY");

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `ApiKey ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    redirect: "manual", // un redirect convertiria el POST en GET y el aviso no se crearia
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    // La clave nunca se registra; solo el codigo HTTP.
    throw new Error(`La API de avisos respondio HTTP ${res.status}`);
  }
  console.log(`Aviso publicado (HTTP ${res.status})`);
}

exports.handler = async (event) => {
  // Respuesta parcial de lote: si un mensaje falla, solo ese se reintenta. Asi un fallo no
  // vuelve a publicar los avisos de los mensajes que si salieron bien (evita duplicados).
  const batchItemFailures = [];

  for (const record of event.Records) {
    try {
      const { type, body } = parse(record);
      if (!TYPES.includes(type)) {
        throw new Error(`Tipo de mensaje no soportado: ${type}`);
      }
      const cards = await topCards();
      await publish(buildText(body, cards));
      console.log("Informe generado:", body.requestId, "con", cards.length, "cartas");
    } catch (err) {
      console.error("Error procesando mensaje", record.messageId, "-", err.message);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};

// Exportado solo para pruebas locales.
exports._buildText = buildText;
