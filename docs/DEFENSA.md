# Checklist de defensa — TCGstore (Evaluación 2, conservando la Evaluación 1)

Antes de empezar: **Start Lab**, credenciales del lab en `~/.aws/credentials`, región **us-east-1** en la consola, app abierta en Vercel y SQL Editor de Supabase abierto.
Marca cada punto cuando tengas la evidencia guardada (📸 = captura).

## A. Evaluación 1 (debe seguir funcionando)

| # | Demostración | Requisito que acredita | Evidencia |
|---|---|---|---|
| A1 | Consola Cognito → User pool `tcgstore-users` → grupos Admin / Colaborador / Cliente con un usuario cada uno | IDaaS, usuarios de prueba y roles | 📸 grupos y usuarios |
| A2 | En Vercel: "Entrar con Cognito" → Hosted UI → vuelve logueado; la barra muestra email y rol | Flujo OAuth 2.0 Authorization Code con Cognito (`react-oidc-context`) | 📸 pantalla de login y pantalla ya logueado |
| A3 | Con cada rol, el menú cambia (Admin ve Administración; Colaborador, Inventario; Cliente, Carrito) | Protección de rutas y lectura de claims (`cognito:groups`) | 📸 menú por rol |
| A4 | F12 → Network: `GET /api/cards` con `Authorization: Bearer …` → **200** y cabeceras `access-control-allow-origin` | Peticiones autenticadas con JWT + CORS | 📸 request y response headers |
| A5 | Consola API Gateway → `tcgstore-api`: ruta `ANY /api/{proxy+}`, authorizer JWT (issuer de Cognito), integración a la EC2 con `X-Secret-Gateway`, CORS | API Gateway desplegado, enrutamiento al backend, CORS | 📸 Routes, Authorization, Integrations, CORS |
| A6 | `curl` a la API sin token → **401** `{"message":"Unauthorized"}` | Validación JWT en API Gateway (401) | 📸 terminal |
| A7 | Token de Colaborador: `DELETE /api/cards/x` → **403**; `GET /api/cards` → **200** | Control de acceso por rol en el backend (403/200) | 📸 terminal |
| A8 | `curl http://<IP_EC2>/api/health` sin cabecera secreta → **403** | El backend solo acepta tráfico que viene del API Gateway | 📸 terminal |
| A9 | Crear / editar una carta en Inventario y verla en Supabase → tabla `cards` | Flujo React → API Gateway → BFF → base de datos cloud | 📸 app + Table Editor |
| A10 | GitHub → Actions → último "Deploy TCGstore…" en verde; EC2 `tcgstore-bff` en running | Despliegue (Docker en EC2, CI/CD) | 📸 Actions y consola EC2 |

## B. Evaluación 2 (informes asíncronos)

| # | Demostración | Requisito que acredita | Evidencia |
|---|---|---|---|
| B1 | Mostrar el diagrama del profesor y explicar: BFF → SNS `report-events` → 2 SQS (filtro por `type`) → 2 Lambdas → Supabase / servicio de avisos | Arquitectura y reemplazo de exchange/colas RabbitMQ por SNS + SQS | diagrama |
| B2 | Código BFF `module/informes`: `InformeController` (Admin, 202) → `InformeService` (arma el mensaje con el email del JWT) → `InformeClient` (único que publica en SNS) | BFF independiente con `module.informes`, Controller/Service/Client | 📸 código |
| B3 | Admin pulsa **Generar informe** → aviso verde; F12 → `POST /api/informes/generar` → **202** con `informeId` | Solicitud autenticada del front al BFF | 📸 app + Network |
| B4 | Log del BFF: `ssh … "docker logs tcgstore 2>&1 \| grep 'Publicado report.requested'"` con el mismo `requestId` | El BFF publica el mensaje | 📸 terminal |
| B5 | Consola SNS → `report-events` → 2 suscripciones con su *filter policy* (scope MessageBody) | Mensajería y enrutamiento por tipo de mensaje | 📸 suscripciones |
| B6 | Consola SQS → 2 colas + 2 DLQ; en cada cola: Redrive policy (3 intentos) y Access policy limitada al topic | Colas, reintentos y manejo de errores | 📸 colas y políticas |
| B7 | Consola Lambda → ambas funciones: runtime `nodejs22.x`, trigger SQS (Enabled, *Report batch item failures*), variables de entorno **sin mostrar valores** | Funciones Lambda y configuración segura | 📸 Configuration → Triggers |
| B8 | CloudWatch → `/aws/lambda/report-request-recorder`: `Solicitud registrada: <requestId>` | Lambda 1 procesa la cola de solicitudes | 📸 log |
| B9 | Supabase SQL: `SELECT * FROM report_requests ORDER BY requested_at DESC LIMIT 5;` → fila con el `requestId`, tu email y la fecha | Persistencia de la solicitud (email y fecha) en Supabase | 📸 resultado |
| B10 | CloudWatch → `/aws/lambda/report-generator`: `Aviso publicado (HTTP 201)` + `Informe generado: <requestId> con N cartas` | Lambda 2 genera el informe con datos de Supabase | 📸 log |
| B11 | Página de avisos del profesor con el informe (top cartas por precio) | Entrega del resultado | 📸 aviso |
| B12 | `.\scripts\04-test.ps1 -Type report.regenerate` → aviso generado y **0** filas nuevas | Función de la segunda cola (re-envío sin duplicar) | 📸 terminal |
| B13 | DLQ con 0 mensajes; explicar `ON CONFLICT DO NOTHING` y `batchItemFailures` | Mensajes duplicados y reintentos | 📸 consola SQS |
| B15 | Admin pulsa **Generar informe** → llegan **dos** avisos: el informe (top 10 por precio) y la **alerta de stock bajo**. CloudWatch `/aws/lambda/report-stock-alert`: `Alerta de stock generada: <requestId> con N cartas`. Con `report.regenerate` la alerta **no** se repite | Extensibilidad del fan-out: un tercer consumidor agregado sin tocar el BFF ni el front | 📸 los 2 avisos + log + suscripción con filtro |
| B14 | Mostrar que no hay secretos en git: `.gitignore`, claves solo en GitHub Secrets / variables de Lambda; la clave de avisos se pide oculta en `02-deploy-lambdas.ps1` | Protección de credenciales | 📸 `.gitignore` y GitHub Secrets (sin valores) |

## Preguntas probables y respuesta corta

- **¿Por qué SNS + SQS y no RabbitMQ?** Es el mecanismo indicado en la guía del curso para AWS: SNS hace de *exchange* (fan-out) y las suscripciones con filtro por `type` hacen de *bindings*; SQS da persistencia, reintentos y DLQ; Lambda consume sin servidores propios.
- **¿Por qué una tercera Lambda y cómo se agregó?** Para alertar de reposición con cada informe. Se creó su cola, su DLQ y una suscripción al mismo topic con filtro `report.requested`: el BFF no cambió (el emisor no sabe cuántos consumidores hay), que es la ventaja del fan-out con SNS.
- **¿Para qué sirven las dos colas?** `report-requests` → guardar la solicitud; `report-generation` → generar y publicar el informe, también para `report.regenerate`, que no crea una fila nueva.
- **¿Qué pasa si falla el servicio de avisos?** La Lambda devuelve ese mensaje como fallido; SQS lo reintenta hasta 3 veces y luego lo deja en la DLQ por 14 días. Los demás mensajes del lote no se repiten.
- **¿Y si SQS entrega dos veces el mismo mensaje?** `report_requests.id` es el `requestId` (clave primaria) e `INSERT … ON CONFLICT DO NOTHING`: no se duplica.
- **¿Quién decide el email del solicitante?** El BFF, desde el JWT de Cognito; el cuerpo de la petición no puede suplantar a otro usuario.
- **¿Por qué el BFF no tiene claves de AWS?** Usa el rol de la instancia (`LabInstanceProfile`) mediante el endpoint de metadatos de EC2.
- **Diferencias con la guía:** tabla `cards` en vez de `products` (caso tienda de cartas), `LabRole` (Learner Lab no permite crear roles), región `us-east-1`, scripts PowerShell con los mismos comandos, respuesta parcial de lote.
