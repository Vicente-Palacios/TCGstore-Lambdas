-- Ejecutar UNA vez en Supabase: Dashboard > SQL Editor > New query > pegar > Run.
-- Es idempotente: se puede ejecutar de nuevo sin romper nada.

-- Solicitudes de informe: las guarda la Lambda 1 (report-request-recorder).
-- id = requestId que genera el BFF. Es la clave primaria: si SQS entrega el mismo mensaje
-- dos veces, el INSERT ... ON CONFLICT DO NOTHING no duplica la fila.
CREATE TABLE IF NOT EXISTS report_requests (
  id           varchar(255) PRIMARY KEY,
  requester    varchar(255),          -- email del usuario (sale del JWT de Cognito, no del cuerpo)
  requester_id varchar(255),          -- "sub" de Cognito
  type         varchar(255),          -- tipo de informe, p. ej. top-products
  params       jsonb,
  requested_at timestamptz            -- fecha de la solicitud (la pone el BFF)
);

CREATE INDEX IF NOT EXISTS report_requests_requested_at_idx ON report_requests (requested_at DESC);

-- RLS activado y sin politicas: la API publica de Supabase (anon / authenticated) no puede leer
-- ni escribir esta tabla. Las Lambdas y el BFF se conectan como el usuario "postgres" (dueno de la
-- tabla), que no se ve afectado.
ALTER TABLE report_requests ENABLE ROW LEVEL SECURITY;

-- La tabla cards ya existe: la crea el BFF (JPA, ddl-auto=update). La Lambda 2 lee de ella.
-- Comprobacion: debe devolver las cartas mas caras.
SELECT name, game, price, stock FROM cards WHERE price IS NOT NULL ORDER BY price DESC LIMIT 10;
