# Crea el topic SNS, las 3 colas SQS (cada una con su DLQ), sus politicas, las suscripciones con filtro
# por "type" y los triggers hacia las Lambdas. Es idempotente: si algo ya existe, lo reutiliza.
# Ejecutar desde la raiz del repo, despues de 02-deploy-lambdas.ps1: .\scripts\03-messaging.ps1

. "$PSScriptRoot\00-config.ps1"
$TMP = [IO.Path]::GetTempPath()
$F_ATTRS  = Join-Path $TMP "attrs.json"
$F_POLICY = Join-Path $TMP "policy.json"
$F_SUB    = Join-Path $TMP "sub-attrs.json"

# 1) Topic (create-topic devuelve el mismo ARN si ya existe)
$TOPIC_ARN = aws sns create-topic --name $TOPIC_NAME --query TopicArn --output text
Write-Host "TOPIC_ARN = $TOPIC_ARN" -ForegroundColor Green

function New-Queue($Name, $Filter) {
    # DLQ: guarda 14 dias los mensajes que fallaron 3 veces
    $dlqUrl = aws sqs create-queue --queue-name "$Name-dlq" --attributes MessageRetentionPeriod=1209600 --query QueueUrl --output text
    $dlqArn = aws sqs get-queue-attributes --queue-url $dlqUrl --attribute-names QueueArn --query Attributes.QueueArn --output text

    # Cola principal: VisibilityTimeout (90 s) > timeout de la Lambda (15 s); 3 intentos y luego DLQ
    $redrive = @{ deadLetterTargetArn = $dlqArn; maxReceiveCount = "3" } | ConvertTo-Json -Compress
    Write-JsonFile $F_ATTRS (@{ VisibilityTimeout = "90"; RedrivePolicy = $redrive } | ConvertTo-Json -Compress)
    $qUrl = aws sqs create-queue --queue-name $Name --attributes "file://$F_ATTRS" --query QueueUrl --output text
    # create-queue no cambia atributos de una cola existente: se aplican explicitamente
    aws sqs set-queue-attributes --queue-url $qUrl --attributes "file://$F_ATTRS"
    $qArn = aws sqs get-queue-attributes --queue-url $qUrl --attribute-names QueueArn --query Attributes.QueueArn --output text

    # Politica: solo ESTE topic SNS puede escribir en la cola (obligatoria en AWS real)
    $policy = @{
        Version   = "2012-10-17"
        Statement = @(@{
            Effect    = "Allow"
            Principal = @{ Service = "sns.amazonaws.com" }
            Action    = "sqs:SendMessage"
            Resource  = $qArn
            Condition = @{ ArnEquals = @{ "aws:SourceArn" = $TOPIC_ARN } }
        })
    } | ConvertTo-Json -Compress -Depth 10
    Write-JsonFile $F_POLICY (@{ Policy = $policy } | ConvertTo-Json -Compress)
    aws sqs set-queue-attributes --queue-url $qUrl --attributes "file://$F_POLICY"

    # Suscripcion con filtro sobre el cuerpo del mensaje (campo "type"). subscribe es idempotente:
    # si ya existe con los mismos atributos, devuelve la misma.
    Write-JsonFile $F_SUB (@{
        FilterPolicy       = $Filter
        FilterPolicyScope  = "MessageBody"
        RawMessageDelivery = "false"
    } | ConvertTo-Json -Compress)
    $subArn = aws sns subscribe --topic-arn $TOPIC_ARN --protocol sqs --notification-endpoint $qArn `
        --attributes "file://$F_SUB" --return-subscription-arn --query SubscriptionArn --output text
    Write-Host "Suscripcion: $subArn"

    Remove-Item $F_ATTRS, $F_POLICY, $F_SUB -ErrorAction SilentlyContinue
    Write-Host "Cola $Name lista ($qArn)" -ForegroundColor Green
    return $qArn
}

$REQUESTS_ARN   = New-Queue $Q_REQUESTS   '{"type":["report.requested"]}'
$GENERATION_ARN = New-Queue $Q_GENERATION '{"type":["report.requested","report.regenerate"]}'
# Lambda 3: solo solicitudes nuevas (un re-envio no repite la alerta de stock)
$STOCK_ARN      = New-Queue $Q_STOCK      '{"type":["report.requested"]}'

# 2) Triggers cola -> Lambda. ReportBatchItemFailures: solo se reintentan los mensajes que fallaron.
function New-Trigger($Function, $QueueArn) {
    $existing = aws lambda list-event-source-mappings --function-name $Function --event-source-arn $QueueArn `
        --query "EventSourceMappings[0].UUID" --output text
    if ($existing -and $existing -ne "None") {
        aws lambda update-event-source-mapping --uuid $existing --batch-size 5 `
            --function-response-types ReportBatchItemFailures --query State --output text
    } else {
        aws lambda create-event-source-mapping --function-name $Function --event-source-arn $QueueArn `
            --batch-size 5 --function-response-types ReportBatchItemFailures --query State --output text
    }
}
New-Trigger $FN_RECORDER  $REQUESTS_ARN
New-Trigger $FN_GENERATOR $GENERATION_ARN
New-Trigger $FN_STOCK     $STOCK_ARN

Start-Sleep 5
aws lambda list-event-source-mappings --query "EventSourceMappings[].[FunctionArn,EventSourceArn,State]" --output table
aws sns list-subscriptions-by-topic --topic-arn $TOPIC_ARN --query "Subscriptions[].[Endpoint,Protocol]" --output table

Write-Host ""
Write-Host "Guarda este valor: va en GitHub > Settings > Variables > SNS_TOPIC_ARN" -ForegroundColor Yellow
Write-Host $TOPIC_ARN
