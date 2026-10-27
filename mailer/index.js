// Lambda 4 - report-mailer
// Trigger: cola SQS "report-emails" (suscrita al topic SNS "report-events" con filtro type = report.requested).
// Responsabilidad: con cada solicitud de informe, leer de Supabase las cartas de rareza destacada
// (por defecto "Secreta") y enviarlas por correo, en HTML con miniaturas, a quien pidio el informe,
// usando la API de correos del profesor (POST /api/saas/send-email).
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
  max: 1,
  connectionTimeoutMillis: 5000,
});

const SUPPORTED_TYPE = "report.requested";
const RARITY = process.env.FEATURED_RARITY || "Secreta";
const MAX_CARDS = 20;
const APP_URL = process.env.APP_URL || "https://tc-gstore-front.vercel.app";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Paleta de la app (front/src/theme.ts): fieltro verde, cartulina, foil dorado y el degradado holografico
// que el front usa para la rareza Secreta.
const C = {
  mat: "#1E3A34", matDeep: "#142B26", matLine: "#2E4E46",
  card: "#F8F4E9", cardBorder: "#DED0A6", ink: "#221E14", inkMuted: "#746A54",
  onMat: "#F4F1E4", onMatMuted: "#AABDB5", gold: "#C79A3D", ruby: "#A23B4B",
  holo: "linear-gradient(135deg, #C79A3D 0%, #C9447A 50%, #3E6FB0 100%)",
};

const currency = new Intl.NumberFormat("es-CL", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
const dateFmt = new Intl.DateTimeFormat("es-CL", {
  timeZone: process.env.REPORT_TIMEZONE || "America/Santiago",
  day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
});
function formatDate(iso) {
  const d = new Date(iso ?? Date.now());
  return Number.isNaN(d.getTime()) ? String(iso) : dateFmt.format(d).replace(",", "");
}

// Los datos vienen de la base (los escribe cualquier Admin/Colaborador): se escapan siempre antes de
// meterlos en el HTML, para que un nombre de carta no pueda inyectar etiquetas en el correo.
function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function safeImageUrl(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

function parse(record) {
  const envelope = JSON.parse(record.body);
  return JSON.parse(envelope.Message);
}

async function featuredCards() {
  const { rows } = await pool.query(
    `SELECT name, game, set_name, condition, price, COALESCE(stock, 0) AS stock, image_url
       FROM cards
      WHERE lower(trim(rarity)) = lower(trim($1))
      ORDER BY price DESC NULLS LAST, name ASC
      LIMIT $2`,
    [RARITY, MAX_CARDS],
  );
  return rows;
}

function cardCell(c) {
  const img = safeImageUrl(c.image_url);
  const agotada = Number(c.stock) === 0;
  const picture = img
    ? `<img src="${esc(img)}" alt="${esc(c.name)}" width="200" style="display:block;width:200px;max-width:100%;height:auto;max-height:280px;margin:0 auto;border-radius:10px;border:0;">`
    : `<div style="width:200px;height:200px;margin:0 auto;border-radius:10px;background:${C.mat};color:${C.gold};font-size:56px;line-height:200px;text-align:center;">🃏</div>`;
  const stock = agotada
    ? `<span style="color:${C.ruby};font-weight:700;">❌ Agotada</span>`
    : `<span style="color:${C.inkMuted};">📦 ${esc(c.stock)} disponible${Number(c.stock) === 1 ? "" : "s"}</span>`;
  const edition = c.set_name ? ` · ${esc(c.set_name)}` : "";
  return `
    <td width="50%" valign="top" style="padding:8px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.card};border:1px solid ${C.cardBorder};border-radius:14px;">
        <tr><td style="height:6px;background:${C.gold};background-image:${C.holo};border-radius:14px 14px 0 0;font-size:0;line-height:0;">&nbsp;</td></tr>
        <tr><td style="padding:14px 14px 6px;text-align:center;">${picture}</td></tr>
        <tr><td style="padding:4px 14px 0;text-align:center;">
          <span style="display:inline-block;padding:3px 10px;border-radius:999px;background:${C.gold};background-image:${C.holo};color:#ffffff;font-size:11px;font-weight:700;letter-spacing:1px;">✨ ${esc(RARITY.toUpperCase())}</span>
        </td></tr>
        <tr><td style="padding:8px 14px 0;text-align:center;font-family:Georgia,'Times New Roman',serif;font-size:18px;font-weight:700;color:${C.ink};">${esc(c.name)}</td></tr>
        <tr><td style="padding:2px 14px 0;text-align:center;font-size:12px;color:${C.inkMuted};">${esc(c.game)}${edition}${c.condition ? ` · ${esc(c.condition)}` : ""}</td></tr>
        <tr><td style="padding:10px 14px 0;text-align:center;font-size:20px;font-weight:700;color:${C.gold};">${c.price == null ? "Precio a consultar" : esc(currency.format(Number(c.price)))}</td></tr>
        <tr><td style="padding:4px 14px 16px;text-align:center;font-size:13px;">${stock}</td></tr>
      </table>
    </td>`;
}

function buildEmail(request, cards) {
  // "vi.palaciosp@duocuc.cl" -> "Vi Palaciosp"
  const nombre = String(request.requester ?? "").split("@")[0].split(/[._-]+/).filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ") || "coleccionista";
  const fecha = formatDate(request.requestedAt);
  const total = cards.length;
  const subject = `🤫 ${total} ${total === 1 ? "carta Secreta" : "cartas Secretas"} que todos conocen en TCG Store`;

  const rows = [];
  for (let i = 0; i < cards.length; i += 2) {
    const right = cards[i + 1] ? cardCell(cards[i + 1]) : `<td width="50%" style="padding:8px;">&nbsp;</td>`;
    rows.push(`<tr>${cardCell(cards[i])}${right}</tr>`);
  }

  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:${C.matDeep};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.matDeep};">
<tr><td align="center" style="padding:24px 12px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:${C.mat};border-radius:18px;font-family:'Segoe UI',Arial,sans-serif;">
    <tr><td style="height:8px;background:${C.gold};background-image:${C.holo};border-radius:18px 18px 0 0;font-size:0;line-height:0;">&nbsp;</td></tr>
    <tr><td style="padding:28px 32px 8px;text-align:center;">
      <div style="font-size:13px;letter-spacing:3px;color:${C.gold};font-weight:700;">♠ TCG STORE ♠</div>
      <h1 style="margin:14px 0 6px;font-family:Georgia,'Times New Roman',serif;font-size:30px;line-height:1.2;color:${C.onMat};">🤫 Las cartas Secretas</h1>
      <p style="margin:0;font-size:16px;color:${C.onMatMuted};font-style:italic;">Son secretas… pero en TCG Store todos las conocen.</p>
    </td></tr>
    <tr><td style="padding:18px 32px 6px;font-size:15px;line-height:1.6;color:${C.onMat};">
      Hola <strong>${esc(nombre)}</strong> 👋<br>
      Pediste un informe del inventario y te traemos lo más codiciado de la vitrina:
      ${total === 1 ? "la carta" : `las <strong style="color:${C.gold};">${total} cartas</strong>`} de rareza <strong style="color:${C.gold};">${esc(RARITY)}</strong>, de la más valiosa a la menos.
    </td></tr>
    <tr><td style="padding:10px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows.join("")}</table>
    </td></tr>
    <tr><td align="center" style="padding:14px 32px 26px;">
      <a href="${esc(APP_URL)}" style="display:inline-block;padding:14px 28px;border-radius:10px;background:${C.gold};color:${C.ink};font-weight:700;font-size:15px;text-decoration:none;">🃏 Ver el catálogo completo</a>
    </td></tr>
    <tr><td style="padding:16px 32px 24px;border-top:1px solid ${C.matLine};font-size:12px;line-height:1.6;color:${C.onMatMuted};text-align:center;">
      Informe solicitado el ${esc(fecha)} · ID ${esc(String(request.requestId ?? "").slice(0, 8))}<br>
      Correo generado automáticamente por TCG Store (AWS SNS → SQS → Lambda).
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;

  // Version en texto plano: la muestran los clientes que no leen HTML (y sirve de respaldo).
  const text = [
    "🤫 LAS CARTAS SECRETAS DE TCG STORE",
    "Son secretas… pero en TCG Store todos las conocen.",
    "",
    `Hola ${nombre}, estas son las ${total} cartas de rareza ${RARITY}:`,
    ...cards.map((c, i) => `${i + 1}. ${c.name} (${c.game}${c.set_name ? ` · ${c.set_name}` : ""}) - ${c.price == null ? "precio a consultar" : currency.format(Number(c.price))} - ${Number(c.stock) === 0 ? "AGOTADA" : `${c.stock} disponible${Number(c.stock) === 1 ? "" : "s"}`}`),
    "",
    `Ver el catálogo: ${APP_URL}`,
    `Informe solicitado el ${fecha} · ID ${String(request.requestId ?? "").slice(0, 8)}`,
  ].join("\n");

  return { subject: subject.slice(0, 200), html, text };
}

async function sendEmail(to, email) {
  const url = process.env.EMAIL_URL || "https://app.claudioviajando.com/api/saas/send-email";
  const key = process.env.NOTICE_API_KEY; // misma identidad (ApiKey) que el servicio de avisos
  if (!key) throw new Error("Falta NOTICE_API_KEY");

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `ApiKey ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ to, subject: email.subject, text: email.text, html: email.html }),
    redirect: "manual",
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    // La API responde {error: "codigo", hint?}: se registra el codigo (nunca la clave) y se reintenta.
    let detail = "";
    try {
      const body = await res.json();
      detail = [body.error, body.hint].filter(Boolean).join(" - ");
    } catch { /* cuerpo no JSON */ }
    throw new Error(`La API de correos respondio HTTP ${res.status}${detail ? ` (${detail})` : ""}`);
  }
  const body = await res.json().catch(() => ({}));
  console.log(`Correo enviado (HTTP ${res.status}) a ${to}; cuota restante hoy: ${body?.item?.remaining ?? "?"}`);
}

exports.handler = async (event) => {
  const batchItemFailures = [];

  for (const record of event.Records) {
    try {
      const { type, body } = parse(record);
      if (type !== SUPPORTED_TYPE) {
        throw new Error(`Tipo de mensaje no soportado: ${type}`);
      }
      const to = String(body.requester ?? "").trim().toLowerCase();
      if (!EMAIL_RE.test(to)) {
        // Sin email valido no hay a quien escribir: se registra y no se reintenta.
        console.log("Solicitud sin email valido, no se envia correo:", body.requestId);
        continue;
      }
      const cards = await featuredCards();
      if (cards.length === 0) {
        console.log(`Sin cartas de rareza ${RARITY}, no se envia correo:`, body.requestId);
        continue;
      }
      await sendEmail(to, buildEmail(body, cards));
      console.log("Correo de cartas", RARITY, "generado:", body.requestId, "con", cards.length, "cartas");
    } catch (err) {
      console.error("Error procesando mensaje", record.messageId, "-", err.message);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};

// Exportado para pruebas y para generar la vista previa.
exports._buildEmail = buildEmail;
