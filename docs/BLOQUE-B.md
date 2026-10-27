# Bloque B — Reconstruir la Evaluación 1 en AWS real y conectar todo

Orden obligatorio (cada paso usa valores del anterior):
**5 Cognito → 6 EC2 → 7 GitHub + despliegue BFF → 8 API Gateway → 9 Vercel → 10 Prueba completa**

Reglas:
- Todo en **PowerShell 7** (`pwsh`), contra **AWS real**, en **una sola terminal** (las variables `$POOL_ID`, `$EC2_IP`, etc. viven en esa terminal). Si la cierras, usa la sección "Recuperar valores" al final.
- Anota los valores NO secretos en `$HOME\tcgstore-valores.txt` (fuera de los repos).
- Si un comando responde `ExpiredToken`: el lab caducó → copia de nuevo "AWS Details" a `$HOME\.aws\credentials`.

```powershell
$env:AWS_REGION = "us-east-1"
Remove-Item Env:AWS_PROFILE -ErrorAction SilentlyContinue
aws sts get-caller-identity          # Account de 12 digitos y Arn con "voclabs"
$VERCEL_URL = "https://<tu-app>.vercel.app"   # tu URL real de Vercel, sin "/" al final
```

---

## Paso 5 — Cognito (sin costo)

**5.1 User Pool** (login con email):

```powershell
$POOL_ID = aws cognito-idp create-user-pool --pool-name tcgstore-users `
  --username-attributes email --auto-verified-attributes email `
  --query UserPool.Id --output text
$POOL_ID          # esperado: us-east-1_XXXXXXXXX
$ISSUER = "https://cognito-idp.us-east-1.amazonaws.com/$POOL_ID"
```

**5.2 Dominio del login (Hosted UI).** Debe ser único en todo AWS; si dice que ya existe, cambia el prefijo:

```powershell
$DOMAIN = "tcgstore-vpalacios"
aws cognito-idp create-user-pool-domain --domain $DOMAIN --user-pool-id $POOL_ID
```

**5.3 App client de la SPA** (sin secreto, flujo `code`). Las callback URLs deben coincidir EXACTO con `window.location.origin` del front (sin `/` final):

```powershell
$CLIENT_ID = aws cognito-idp create-user-pool-client --user-pool-id $POOL_ID `
  --client-name tcgstore-spa --no-generate-secret `
  --allowed-o-auth-flows code --allowed-o-auth-flows-user-pool-client `
  --allowed-o-auth-scopes openid email phone `
  --supported-identity-providers COGNITO `
  --callback-urls "http://localhost:5173" $VERCEL_URL `
  --explicit-auth-flows ALLOW_USER_SRP_AUTH ALLOW_REFRESH_TOKEN_AUTH `
  --query UserPoolClient.ClientId --output text
$CLIENT_ID
```

**5.4 Grupos (roles) y usuarios de prueba.** Para Admin usa tu correo real (el informe sale a su nombre). `SUPPRESS` = Cognito no envía correos. Contraseña: mínimo 8, con mayúscula, minúscula, número y símbolo.

```powershell
foreach ($g in "Admin", "Colaborador", "Cliente") {
  aws cognito-idp create-group --user-pool-id $POOL_ID --group-name $g --query Group.GroupName --output text
}

function New-TestUser($Email, $Group) {
  $pass = Read-Host "Contrasena para $Email"
  aws cognito-idp admin-create-user --user-pool-id $POOL_ID --username $Email `
    --user-attributes Name=email,Value=$Email Name=email_verified,Value=true `
    --message-action SUPPRESS --query User.Username --output text
  aws cognito-idp admin-set-user-password --user-pool-id $POOL_ID --username $Email --password $pass --permanent
  aws cognito-idp admin-add-user-to-group --user-pool-id $POOL_ID --username $Email --group-name $Group
}
New-TestUser "<tu-correo>@duocuc.cl"   "Admin"
New-TestUser "colaborador@tcgstore.cl" "Colaborador"
New-TestUser "cliente@tcgstore.cl"     "Cliente"

aws cognito-idp list-users --user-pool-id $POOL_ID --query "Users[].[Username,UserStatus]" --output table
```

✅ Esperado: 3 usuarios en estado `CONFIRMED`. 📸 Evidencia: captura de la consola de Cognito con los grupos y usuarios.

---

## Paso 6 — EC2 (⚠️ consume crédito mientras está encendida)

**6.1 Llave SSH** (la usará GitHub Actions; se guarda fuera de los repos):

```powershell
New-Item -ItemType Directory -Force $HOME\.ssh | Out-Null
aws ec2 create-key-pair --key-name tcgstore-key --key-type rsa --key-format pem `
  --query KeyMaterial --output text | Out-File -Encoding ascii $HOME\.ssh\tcgstore-key.pem
```

**6.2 Security Group.** 22 abierto porque los runners de GitHub cambian de IP; 80 abierto porque API Gateway entra por ahí. Quien llame directo a la IP sin `X-Secret-Gateway` recibe 403 del BFF.

```powershell
$VPC_ID = aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query "Vpcs[0].VpcId" --output text
$SG_ID = aws ec2 create-security-group --group-name tcgstore-bff-sg `
  --description "BFF TCGstore HTTP y SSH" --vpc-id $VPC_ID --query GroupId --output text
aws ec2 authorize-security-group-ingress --group-id $SG_ID --protocol tcp --port 22 --cidr 0.0.0.0/0 --query Return
aws ec2 authorize-security-group-ingress --group-id $SG_ID --protocol tcp --port 80 --cidr 0.0.0.0/0 --query Return
```

**6.3 Instancia.**
- Amazon Linux 2023: el `deploy.yml` usa `dnf` y `ec2-user`.
- `LabInstanceProfile`: da al BFF el permiso `sns:Publish` sin claves.
- `HttpPutResponseHopLimit=2`: sin esto, el contenedor Docker no obtiene las credenciales del rol y publicar en SNS falla.

```powershell
$INSTANCE_ID = aws ec2 run-instances `
  --image-id resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-x86_64 `
  --instance-type t3.small --key-name tcgstore-key --security-group-ids $SG_ID `
  --iam-instance-profile Name=LabInstanceProfile `
  --metadata-options "HttpTokens=required,HttpPutResponseHopLimit=2,HttpEndpoint=enabled" `
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=tcgstore-bff}]" `
  --query "Instances[0].InstanceId" --output text
aws ec2 wait instance-running --instance-ids $INSTANCE_ID
```

Si el lab rechaza `t3.small`, usa `t3.micro` (el workflow ya crea 2 GB de swap).

**6.4 IP fija (Elastic IP).** El Learner Lab detiene la EC2 al cerrar la sesión y al encenderla cambia la IP pública: eso rompería GitHub y API Gateway. La Elastic IP no cambia (centavos por hora, del crédito).

```powershell
$ALLOC_ID = aws ec2 allocate-address --domain vpc --query AllocationId --output text
aws ec2 associate-address --instance-id $INSTANCE_ID --allocation-id $ALLOC_ID --query AssociationId --output text
$EC2_IP = aws ec2 describe-addresses --allocation-ids $ALLOC_ID --query "Addresses[0].PublicIp" --output text
$EC2_IP
```

---

## Paso 7 — GitHub y despliegue del BFF

En la carpeta del **repo del BFF**. Si no tienes `gh`: `winget install GitHub.cli` y luego `gh auth login`.

**7.1 Secreto nuevo del Gateway** (lo usa el paso 8; no lo compartas):

```powershell
$GW_SECRET = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

**7.2 Variables y secrets.** `SNS_TOPIC_ARN` = el ARN que imprimió `03-messaging.ps1`:

```powershell
$TOPIC_ARN = aws sns list-topics --query "Topics[?ends_with(TopicArn,':report-events')].TopicArn | [0]" --output text
gh variable set TARGET_HOST_IP     --body $EC2_IP
gh variable set COGNITO_ISSUER_URI --body $ISSUER
gh variable set COGNITO_CLIENT_ID  --body $CLIENT_ID
gh variable set SNS_TOPIC_ARN      --body $TOPIC_ARN
Get-Content $HOME\.ssh\tcgstore-key.pem -Raw | gh secret set EC2_SSH_KEY
gh secret set API_GATEWAY_SECRET --body $GW_SECRET
gh variable list; gh secret list
```

En `gh secret list` deben estar también `SUPABASE_DB_USER`, `SUPABASE_DB_PASSWORD` y `GH_CR_PAT`.
- Si en el bloque A reseteaste la contraseña de Supabase: `gh secret set SUPABASE_DB_PASSWORD` (la pide oculta).
- Si `GH_CR_PAT` venció: GitHub → Settings → Developer settings → Tokens (classic), scope `read:packages`, y `gh secret set GH_CR_PAT`.

**7.3 Host de Supabase en `deploy.yml`.** Tiene fijo `DB_URL='jdbc:postgresql://aws-0-us-east-1.pooler.supabase.com:5432/postgres'`. Debe ser el **mismo host** de la URI que usaste en el bloque A (algunos proyectos usan `aws-1-…`). Si difiere, corrígelo en `develop`.

**7.4 Desplegar.** En GitHub: Pull Request `develop → main` → Merge. Pestaña **Actions**: el workflow debe terminar en verde. Luego:

```powershell
curl.exe -s -o NUL -w "sin secreto -> %{http_code}`n" "http://$EC2_IP/api/health"
curl.exe -s -o NUL -w "con secreto  -> %{http_code}`n" -H "X-Secret-Gateway: $GW_SECRET" "http://$EC2_IP/api/health"
```

✅ Esperado: **403** (filtro del secreto) y **401** (la app está arriba con Cognito y Supabase; solo falta el JWT).
`000` = el contenedor no arrancó: revisa el log del paso "Deploy to EC2" en Actions, o entra por SSH:

```powershell
ssh -i $HOME\.ssh\tcgstore-key.pem ec2-user@$EC2_IP "docker logs --tail 80 tcgstore"
```

(Si `ssh` reclama permisos de la llave: `icacls $HOME\.ssh\tcgstore-key.pem /inheritance:r /grant:r "$($env:USERNAME):R"`.)

---

## Paso 8 — API Gateway (HTTP API, sin costo en este volumen)

Qué se crea:
- **Authorizer JWT** de Cognito: sin token o con token inválido, API Gateway responde **401** sin llegar al BFF.
- **Integración** `ANY /api/{proxy+}` → `http://<EC2_IP>/api/{proxy}`, que **agrega la cabecera `X-Secret-Gateway`** (el navegador nunca la ve).
- **CORS** para `localhost:5173` y tu URL de Vercel (API Gateway responde solo los preflight `OPTIONS`).

```powershell
$TMP = [IO.Path]::GetTempPath()
function Write-Json($Path, $Obj) {
  [IO.File]::WriteAllText($Path, ($Obj | ConvertTo-Json -Compress -Depth 5), (New-Object Text.UTF8Encoding $false))
}

Write-Json "$TMP\cors.json" @{
  AllowOrigins = @("http://localhost:5173", $VERCEL_URL)
  AllowHeaders = @("authorization", "content-type")
  AllowMethods = @("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS")
  MaxAge = 300 }
$API_ID = aws apigatewayv2 create-api --name tcgstore-api --protocol-type HTTP `
  --cors-configuration "file://$TMP\cors.json" --query ApiId --output text

Write-Json "$TMP\jwt.json" @{ Issuer = $ISSUER; Audience = @($CLIENT_ID) }
$AUTH_ID = aws apigatewayv2 create-authorizer --api-id $API_ID --name cognito-jwt `
  --authorizer-type JWT --identity-source '$request.header.Authorization' `
  --jwt-configuration "file://$TMP\jwt.json" --query AuthorizerId --output text

Write-Json "$TMP\params.json" @{ "overwrite:header.X-Secret-Gateway" = $GW_SECRET }
$INTEG_ID = aws apigatewayv2 create-integration --api-id $API_ID `
  --integration-type HTTP_PROXY --integration-method ANY `
  --integration-uri "http://$EC2_IP/api/{proxy}" --payload-format-version 1.0 `
  --request-parameters "file://$TMP\params.json" --query IntegrationId --output text
Remove-Item "$TMP\cors.json", "$TMP\jwt.json", "$TMP\params.json"   # params.json tenia el secreto

aws apigatewayv2 create-route --api-id $API_ID --route-key 'ANY /api/{proxy+}' `
  --target "integrations/$INTEG_ID" --authorization-type JWT --authorizer-id $AUTH_ID --query RouteKey --output text
aws apigatewayv2 create-stage --api-id $API_ID --stage-name '$default' --auto-deploy --query StageName --output text

$API_URL = "https://$API_ID.execute-api.us-east-1.amazonaws.com"
$API_URL
```

Prueba sin token (debe cortar API Gateway):

```powershell
curl.exe -s -w "`n-> HTTP %{http_code}`n" "$API_URL/api/cards"
```

✅ Esperado: `{"message":"Unauthorized"}` y **401**. 📸 Evidencia.

---

## Paso 9 — Frontend (local y Vercel)

**9.1 Local.** En la carpeta del **repo del front**, crea `.env.local` (está en `.gitignore`):

```powershell
@"
VITE_COGNITO_AUTHORITY=$ISSUER
VITE_COGNITO_CLIENT_ID=$CLIENT_ID
VITE_API_BASE_URL=$API_URL
"@ | Set-Content -Encoding ascii .env.local
npm install
npm run dev
```

Abre `http://localhost:5173` → **Entrar con Cognito** → entra con el usuario Admin.
✅ Esperado: ves el catálogo (GET `/api/cards` → 200 por API Gateway → BFF → Supabase).

**9.2 Vercel.** Proyecto → Settings → Environment Variables: actualiza `VITE_COGNITO_AUTHORITY`, `VITE_COGNITO_CLIENT_ID` y `VITE_API_BASE_URL` con los mismos valores. Luego Deployments → **Redeploy** (las `VITE_*` se leen al compilar: sin redeploy no cambian).
Si Vercel publica desde `main`, haz también el PR `develop → main` del front.

---

## Paso 10 — Prueba completa (desde el botón)

1. En la app (local o Vercel), entra como **Admin** → **Administración** → **Generar informe**.
   ✅ Aviso verde "Informe solicitado (xxxxxxxx…)". En F12 → Network: `POST /api/informes/generar` → **202**.
2. BFF publicó en SNS:
   ```powershell
   ssh -i $HOME\.ssh\tcgstore-key.pem ec2-user@$EC2_IP "docker logs tcgstore 2>&1 | grep 'Publicado report.requested' | tail -3"
   ```
3. Lambdas (desde el repo de Lambdas):
   ```powershell
   foreach ($fn in "report-request-recorder", "report-generator") {
     "--- $fn"
     (aws logs filter-log-events --log-group-name /aws/lambda/$fn --start-time ([DateTimeOffset]::UtcNow.AddMinutes(-10).ToUnixTimeMilliseconds()) --query 'events[].message' --output text) -split "`t" |
       Select-String "Solicitud registrada|Aviso publicado|Informe generado|Error"
   }
   ```
4. Supabase (SQL Editor): `SELECT * FROM report_requests ORDER BY requested_at DESC LIMIT 5;` → fila con **tu correo**.
5. Roles (Evaluación 1): con **Colaborador** el botón no aparece; un `DELETE` de carta con Colaborador → **403**; sin token → **401**; Admin → **200**.

📸 Guarda captura de cada punto: son las evidencias de la defensa.

---

## Recuperar valores (si cerraste la terminal)

```powershell
$env:AWS_REGION = "us-east-1"
$POOL_ID   = aws cognito-idp list-user-pools --max-results 20 --query "UserPools[?Name=='tcgstore-users'].Id | [0]" --output text
$ISSUER    = "https://cognito-idp.us-east-1.amazonaws.com/$POOL_ID"
$CLIENT_ID = aws cognito-idp list-user-pool-clients --user-pool-id $POOL_ID --query "UserPoolClients[?ClientName=='tcgstore-spa'].ClientId | [0]" --output text
$INSTANCE_ID = aws ec2 describe-instances --filters "Name=tag:Name,Values=tcgstore-bff" "Name=instance-state-name,Values=running,stopped" --query "Reservations[0].Instances[0].InstanceId" --output text
$EC2_IP    = aws ec2 describe-addresses --filters "Name=instance-id,Values=$INSTANCE_ID" --query "Addresses[0].PublicIp" --output text
$API_ID    = aws apigatewayv2 get-apis --query "Items[?Name=='tcgstore-api'].ApiId | [0]" --output text
$API_URL   = "https://$API_ID.execute-api.us-east-1.amazonaws.com"
$POOL_ID; $CLIENT_ID; $EC2_IP; $API_URL
```

`$GW_SECRET` no se puede recuperar de GitHub: si lo pierdes antes del paso 8, genera uno nuevo (7.1) y vuelve a guardarlo con `gh secret set API_GATEWAY_SECRET` y un nuevo merge/redeploy.
