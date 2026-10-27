// Lambda 1 - report-request-recorder
// Trigger: cola SQS "report-requests" (suscrita al topic SNS "report-events" con filtro type = report.requested).
// Responsabilidad: guardar cada solicitud de informe en Supabase (tabla report_requests).
const { Pool } = require("pg");

// El Pool se crea fuera del handler: se reutiliza entre invocaciones de una misma Lambda "caliente".
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Supabase exige SSL; en local (Postgres sin SSL) se apaga con DATABASE_SSL=false.
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
  max: 1,
  connectionTimeoutMillis: 5000,
});

const SUPPORTED_TYPE = "report.requested";

// SNS entrega a SQS un sobre {"Type":"Notification","Message":"<JSON como texto>",...}.
// SQS lo pone en record.body. El mensaje real es {"type": "...", "body": {...}}.
function parse(record) {
  const envelope = JSON.parse(record.body);
  return JSON.parse(envelope.Message);
}

async function save(body) {
  if (!body || !body.requestId) {
    throw new Error("Mensaje sin requestId");
  }
  // ON CONFLICT DO NOTHING: SQS entrega "al menos una vez"; un reintento no duplica la fila.
  const result = await pool.query(
    `INSERT INTO report_requests (id, requester, requester_id, type, params, requested_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     ON CONFLICT (id) DO NOTHING`,
    [
      body.requestId,
      body.requester,
      body.requesterId,
      body.reportType,
      JSON.stringify(body.params ?? {}),
      body.requestedAt ?? new Date().toISOString(),
    ],
  );
  return result.rowCount === 1;
}

exports.handler = async (event) => {
  // Respuesta parcial de lote (ReportBatchItemFailures): solo se reintentan los mensajes que fallaron,
  // no el lote completo. Requiere --function-response-types ReportBatchItemFailures en el trigger.
  const batchItemFailures = [];

  for (const record of event.Records) {
    try {
      const { type, body } = parse(record);
      if (type !== SUPPORTED_TYPE) {
        throw new Error(`Tipo de mensaje no soportado: ${type}`);
      }
      const inserted = await save(body);
      console.log(inserted ? "Solicitud registrada:" : "Solicitud duplicada (ya existia):", body.requestId);
    } catch (err) {
      // Se registra el error (sin datos sensibles) y el mensaje vuelve a la cola; tras 3 intentos va a la DLQ.
      console.error("Error procesando mensaje", record.messageId, "-", err.message);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};
