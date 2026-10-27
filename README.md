# TCG Store — Lambdas de informes (Evaluación 2)

Procesamiento asíncrono de los informes de TCG Store, siguiendo la guía del curso
"Construir el sistema a mano en LocalStack y llevarlo a AWS real", adaptada a una tienda de cartas.

```
React (Vercel) ── POST /api/informes/generar ──► API Gateway ──► BFF Spring Boot (EC2)
                                                                   │ publica (sns:Publish)
                                                                   ▼
                                       SNS topic "report-events"  (filtro por el campo "type")
           ┌─────────────────────────────┼───────────────────────────────┐
  type = report.requested    type = requested | regenerate        type = report.requested
           ▼                             ▼                               ▼
 SQS report-requests (+DLQ)   SQS report-generation (+DLQ)   SQS report-stock-alerts (+DLQ)
           ▼                             ▼                               ▼
 Lambda report-request-recorder  Lambda report-generator      Lambda report-stock-alert
 INSERT report_requests          top 10 cartas por precio     cartas con stock <= 2 (cards)
                                 POST aviso (informe)         POST aviso (alerta de reposicion)
```

Los avisos se publican en `https://app.claudioviajando.com/api/saas/notices`.

| Pieza | Responsabilidad | Runtime / handler | Variables de entorno |
|---|---|---|---|
| `recorder/` → `report-request-recorder` | Guarda la solicitud (email, sub, tipo, fecha) en `report_requests` | `nodejs22.x` / `index.handler` | `DATABASE_URL` |
| `generator/` → `report-generator` | Lee las 10 cartas más caras de `cards`, arma el informe y lo publica en el servicio de avisos | `nodejs22.x` / `index.handler` | `DATABASE_URL`, `NOTICE_URL`, `NOTICE_API_KEY` |
| `stock-alert/` → `report-stock-alert` | Con cada solicitud nueva, busca en `cards` las cartas con stock `<= LOW_STOCK_THRESHOLD` (agotadas primero) y publica una alerta de reposición. Si no hay ninguna, no publica nada | `nodejs22.x` / `index.handler` | `DATABASE_URL`, `NOTICE_URL`, `NOTICE_API_KEY`, `LOW_STOCK_THRESHOLD` (por defecto `2`) |

Única dependencia: `pg` 8.23.1 (cliente de Postgres), empaquetada dentro del zip.

**Errores, reintentos y duplicados**
- Las Lambdas devuelven `batchItemFailures` (trigger con `ReportBatchItemFailures`): si falla un mensaje del lote, solo ese se reintenta; los que salieron bien no se vuelven a procesar (no se duplican avisos).
- Cada mensaje se reintenta hasta 3 veces (`maxReceiveCount`) y luego va a su DLQ, donde se conserva 14 días.
- `report_requests.id` = `requestId` del BFF + `INSERT … ON CONFLICT DO NOTHING`: una entrega repetida de SQS no duplica la fila.
- Respuesta no 2xx del servicio de avisos (401, 404, 500, redirect) = error = reintento. La clave nunca se escribe en los logs.

---

## Requisitos (Windows)

Ejecuta en **PowerShell** (de preferencia PowerShell 7: `winget install Microsoft.PowerShell`; también funciona en Windows PowerShell 5.1):

```powershell
aws --version     # AWS CLI v2, 2.13 o superior
node -v           # 20 o superior
tar --version     # viene con Windows 10/11 (bsdtar)
```

Si PowerShell bloquea los scripts (`running scripts is disabled`), permítelos solo en esta terminal:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

## Paso 0 — Credenciales del Learner Lab (AWS real)

1. En AWS Academy: **Start Lab** y espera el punto verde. Luego **AWS Details → AWS CLI → Show**.
2. Copia ese bloque completo (incluye `aws_session_token`) en `%USERPROFILE%\.aws\credentials`, reemplazando la sección `[default]`:

```powershell
notepad $HOME\.aws\credentials
```

3. Comprueba en qué cuenta estás **antes de crear nada**:

```powershell
Remove-Item Env:AWS_PROFILE -ErrorAction SilentlyContinue   # que no quede apuntando a LocalStack
$env:AWS_REGION = "us-east-1"
aws sts get-caller-identity
```

Esperado: un `Account` de 12 dígitos (no `000000000000`) y un `Arn` que contiene `voclabs`.
Las credenciales del laboratorio **caducan al terminar la sesión** (unas 4 h): si un comando responde `ExpiredToken`, repite el paso 0.

## Paso 1 — Supabase

1. **Cadena de conexión.** Supabase → tu proyecto → botón **Connect** → pestaña **Session pooler** → copia la URI:
   `postgresql://postgres.<ref>:[YOUR-PASSWORD]@aws-0-<region>.pooler.supabase.com:5432/postgres`
   - Usa el **session pooler**, no la "Direct connection": la directa es solo IPv6 y una Lambda sin VPC no tiene salida IPv6.
   - Reemplaza `[YOUR-PASSWORD]` por la contraseña de la base. Si tiene caracteres como `@ : / # ?`, escríbelos codificados (`@` → `%40`).
   - Si no recuerdas la contraseña: Project Settings → Database → **Reset database password**. Si la cambias, actualiza también el secret `SUPABASE_DB_PASSWORD` de GitHub (lo usa el BFF).
2. **Tabla de solicitudes.** SQL Editor → New query → pega el contenido de [`sql/supabase.sql`](sql/supabase.sql) → **Run**.
   Esperado: "Success" y, al final, la lista de tus cartas más caras (si sale vacía, la Lambda 2 igual funciona e informa "No hay cartas…").

## Paso 2 — Empaquetar (local, sin costo)

Desde la raíz de este repo:

```powershell
.\scripts\01-package.ps1
```

Esperado: `recorder.zip`, `generator.zip` y `stock-alert.zip` en `dist\` (unos 150 KB cada uno).

## Paso 3 — Crear las Lambdas (AWS real)

```powershell
.\scripts\02-deploy-lambdas.ps1
```

- Te pide `DATABASE_URL` (paso 1) y `NOTICE_API_KEY` (la clave que entregó el profesor). Se escriben ocultas y solo se guardan como variables de entorno de cada Lambda (cifradas por AWS). Los JSON temporales se borran al terminar.
- Usa el rol `LabRole` (Learner Lab no deja crear roles; ya tiene permisos para leer SQS y escribir logs).
- Si las funciones ya existen, actualiza código y configuración. Puedes ejecutarlo de nuevo cuando cambies el código.

Esperado: una tabla con las tres funciones en estado `Active`.
Para cambiar el umbral de stock bajo: `$env:LOW_STOCK_THRESHOLD = "3"` antes de ejecutar el script.

**Prueba aislada** (antes de conectar colas): invoca la Lambda 2 con un evento falso que imita SQS → SNS.

```powershell
$log = aws lambda invoke --function-name report-generator `
  --cli-binary-format raw-in-base64-out --payload file://events/sqs-report-requested.json `
  --log-type Tail --query LogResult --output text out.json
[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($log))
Get-Content out.json
```

Esperado en el log: `Aviso publicado (HTTP 201)` e `Informe generado: manual-1 con N cartas`; `out.json` = `{"batchItemFailures":[]}`.
Si aparece `La API de avisos respondio HTTP 401`, la clave es incorrecta; si es `timeout` o `ENOTFOUND` hacia `pooler.supabase.com`, revisa `DATABASE_URL`.

## Paso 4 — SNS, colas, DLQ, suscripciones y triggers (AWS real)

```powershell
.\scripts\03-messaging.ps1
```

Crea (o reutiliza, si ya existen): el topic `report-events`; las colas `report-requests`, `report-generation` y `report-stock-alerts`, cada una con su DLQ (`-dlq`), `VisibilityTimeout` de 90 s y máximo 3 intentos; la política que deja escribir **solo a este topic**; las suscripciones con `FilterPolicy` sobre el campo `type` del cuerpo del mensaje; y los triggers cola → Lambda (lote de 5, `ReportBatchItemFailures`).

Esperado: los tres triggers en `Enabled`, las tres suscripciones y, al final, el **ARN del topic**. Guárdalo: es la variable `SNS_TOPIC_ARN` del BFF (GitHub → Settings → Secrets and variables → Actions → Variables).

## Paso 5 — Probar el flujo (sin el BFF todavía)

```powershell
.\scripts\04-test.ps1                            # report.requested: debe guardar Y generar
.\scripts\04-test.ps1 -Type report.regenerate    # solo genera; NO debe crear fila
```

Publica en SNS exactamente el mensaje que publica el BFF y muestra los logs de ambas Lambdas.
Esperado: `Solicitud registrada: cli-…`, `Aviso publicado (HTTP 201)`, `Informe generado: cli-…`, `Alerta publicada (HTTP 201)` / `Alerta de stock generada: cli-…` (o `Sin cartas con stock bajo`) y `0` mensajes en las DLQ.
Después, en Supabase: `SELECT * FROM report_requests ORDER BY requested_at DESC;`

## Logs y diagnóstico

```powershell
# Últimos mensajes de una Lambda
(aws logs filter-log-events --log-group-name /aws/lambda/report-generator --query 'events[].message' --output text) -split "`t" |
  Select-String "Aviso publicado|Informe generado|Error" | Select-Object -Last 10

# Mensajes que fallaron 3 veces (DLQ)
$u = aws sqs get-queue-url --queue-name report-generation-dlq --query QueueUrl --output text
aws sqs receive-message --queue-url $u --max-number-of-messages 5 --query 'Messages[].Body' --output text
```

| Síntoma | Causa probable | Solución |
|---|---|---|
| `ExpiredToken` / `InvalidClientTokenId` | Credenciales del lab caducadas | Repite el paso 0 |
| `AccessDenied` al crear la función | Rol distinto de `LabRole` o región no permitida | Usa `us-east-1`; no cambies `$ROLE_ARN` |
| Log: `connect ETIMEDOUT` / `ENETUNREACH` hacia Supabase | Se usó la conexión directa (IPv6) | Usa la URI del **session pooler** |
| Log: `password authentication failed` | Contraseña o usuario (`postgres.<ref>`) incorrectos | Copia de nuevo la URI y ejecuta `02-deploy-lambdas.ps1` |
| Log: `relation "report_requests" does not exist` | No se ejecutó `sql/supabase.sql` | Paso 1 |
| Log: `respondio HTTP 401` | `NOTICE_API_KEY` incorrecta | Ejecuta de nuevo `02-deploy-lambdas.ps1` |
| Publicas y no llega nada, sin errores | El `type` no coincide con ningún filtro | Debe ser `report.requested` o `report.regenerate` |
| Mensaje en una DLQ | Falló 3 veces | Mira el log de la Lambda (`Error procesando mensaje …`) |

## Costos

Lambda, SNS y SQS en este volumen cuestan prácticamente 0 (capa gratuita / centavos) y se descuentan del crédito del Learner Lab. Lo que sí consume crédito de forma continua es la **EC2** del BFF: detén el laboratorio (**End Lab**) cuando no estés trabajando.

## Opcional — LocalStack

Los mismos scripts sirven contra LocalStack (guía del curso, secciones 2 y 3): levanta LocalStack con el `docker-compose.yml` de la guía y activa su perfil antes de ejecutarlos:

```powershell
$env:AWS_PROFILE = "localstack"; $env:AWS_REGION = "us-east-1"
aws sts get-caller-identity   # debe mostrar 000000000000
```

`00-config.ps1` detecta la cuenta `000000000000` y usa `nodejs20.x` y un rol ficticio. Las Lambdas en LocalStack pueden conectarse a tu Supabase real. Para no publicar avisos reales, define antes `$env:NOTICE_URL = "http://host.docker.internal:8082/api/saas/notices"` y levanta el servicio de avisos local de la guía (sección 4).
