# Prueba de punta a punta SIN el BFF: publica en SNS el mismo mensaje que publica el BFF y revisa los logs
# de las dos Lambdas. Uso: .\scripts\04-test.ps1                (report.requested: guarda + genera)
#                          .\scripts\04-test.ps1 -Type report.regenerate   (solo genera, no guarda)
param([string]$Type = "report.requested")

. "$PSScriptRoot\00-config.ps1"

$TOPIC_ARN = aws sns list-topics --query "Topics[?ends_with(TopicArn,':$TOPIC_NAME')].TopicArn | [0]" --output text
if (-not $TOPIC_ARN -or $TOPIC_ARN -eq "None") { throw "No existe el topic ${TOPIC_NAME}: ejecuta 03-messaging.ps1" }

$MARK = "cli-" + [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$now  = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$msg  = @{ type = $Type; body = @{
    requestId = $MARK; requester = "prueba-cli@tcgstore.cl"; requesterId = "cli"
    reportType = "top-products"; params = @{}; requestedAt = $now } } | ConvertTo-Json -Compress -Depth 5
$F_MSG = Join-Path ([IO.Path]::GetTempPath()) "msg.json"
Write-JsonFile $F_MSG $msg
$startMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - 5000
aws sns publish --topic-arn $TOPIC_ARN --message "file://$F_MSG" --query MessageId --output text
Remove-Item $F_MSG
Write-Host "Publicado $Type con requestId $MARK. Esperando a las Lambdas..." -ForegroundColor Cyan

function Get-Logs($Function) {
    # El grupo de logs no existe hasta la primera invocacion: ese error se ignora
    try {
        $events = aws logs filter-log-events --log-group-name "/aws/lambda/$Function" --start-time $startMs `
            --query "events[].message" --output text 2>$null
    } catch { return @() }
    if ($LASTEXITCODE -ne 0 -or -not $events) { return @() }
    return ($events -split "`t") | Where-Object { $_ -match $MARK -or $_ -match "Error|errorMessage|Aviso publicado" }
}

$okGen = $false
for ($i = 0; $i -lt 12 -and -not $okGen; $i++) {
    Start-Sleep 5
    $okGen = [bool](Get-Logs $FN_GENERATOR | Select-String "Informe generado: $MARK")
}
Write-Host "--- $FN_GENERATOR" -ForegroundColor Yellow; Get-Logs $FN_GENERATOR
Write-Host "--- $FN_RECORDER"  -ForegroundColor Yellow; Get-Logs $FN_RECORDER

foreach ($q in $Q_REQUESTS, $Q_GENERATION) {
    $u = aws sqs get-queue-url --queue-name "$q-dlq" --query QueueUrl --output text
    $n = aws sqs get-queue-attributes --queue-url $u --attribute-names ApproximateNumberOfMessages --query Attributes.ApproximateNumberOfMessages --output text
    Write-Host "Mensajes en $q-dlq (debe ser 0): $n"
}
Write-Host ""
Write-Host "Verifica en Supabase (SQL Editor):  SELECT * FROM report_requests WHERE id = '$MARK';" -ForegroundColor Cyan
if ($Type -eq "report.regenerate") { Write-Host "(con report.regenerate debe devolver 0 filas)" }
