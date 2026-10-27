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
    `Informe TCG Store: las ${cards.length} cartas de mayor precio`,
    `Solicitud ${request.requestId} de ${request.requester ?? "desconocido"} (${request.requestedAt ?? "sin fecha"})`,
  ];
  if (cards.length === 0) {
    return [...header, "No hay cartas con precio registrado en el inventario."].join("\n");
  }
  const lines = cards.map((c, i) => {
    const edition = c.set_name ? `, ${c.set_name}` : "";
    return `${i + 1}. ${c.name} (${c.game}${edition}) - ${currency.format(Number(c.price))} - stock ${c.stock ?? 0}`;
  });
  const totalValue = cards.reduce((sum, c) => sum + Number(c.price) * Number(c.stock ?? 0), 0);
  const text = [...header, ...lines, `Valor en stock de estas cartas: ${currency.format(totalValue)}`].join("\n");
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT - 1) + "…" : text;
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
