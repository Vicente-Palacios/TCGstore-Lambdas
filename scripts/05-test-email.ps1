# Prueba directa de la API de correos (sin Lambdas): confirma que tu usuario esta habilitado para enviar.
# Toma la API key de la Lambda report-generator (no se muestra en pantalla) y te manda un correo de prueba.
# Uso: .\scripts\05-test-email.ps1 -To tu-correo@duocuc.cl
param([Parameter(Mandatory = $true)][string]$To)

. "$PSScriptRoot\00-config.ps1"

$key = aws lambda get-function-configuration --function-name $FN_GENERATOR --query "Environment.Variables.NOTICE_API_KEY" --output text
if (-not $key -or $key -eq "None") { throw "No se encontro NOTICE_API_KEY en $FN_GENERATOR (ejecuta 02-deploy-lambdas.ps1)" }

$url  = if ($env:EMAIL_URL) { $env:EMAIL_URL } else { "https://app.claudioviajando.com/api/saas/send-email" }
$body = @{ to = $To; subject = "Prueba TCG Store"; text = "Hola, este es un correo de prueba de TCG Store." } | ConvertTo-Json -Compress
try {
    $r = Invoke-RestMethod -Method Post -Uri $url -ContentType "application/json; charset=utf-8" `
        -Headers @{ Authorization = "ApiKey $key" } -Body ([Text.Encoding]::UTF8.GetBytes($body))
    Write-Host "OK: correo enviado a $($r.item.to -join ', '). Cuota restante hoy: $($r.item.remaining)" -ForegroundColor Green
} catch {
    $status = $_.Exception.Response.StatusCode.value__
    $detail = $_.ErrorDetails.Message
    Write-Host "Fallo HTTP $status : $detail" -ForegroundColor Red
    if ($detail -match "email_not_enabled") { Write-Host "Tu usuario aun no esta habilitado para enviar correos: pidele al profesor que lo active." -ForegroundColor Yellow }
} finally {
    $key = $null
}
