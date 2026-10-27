# Configuracion comun. NO se ejecuta solo: los demas scripts lo cargan con ". .\scripts\00-config.ps1".
# Destino: AWS real (Learner Lab) por defecto. Para LocalStack: $env:AWS_PROFILE = "localstack" antes de ejecutar.

$ErrorActionPreference = "Stop"
# En PowerShell 7.3+ un comando nativo (aws) con error detiene el script igual que un cmdlet.
$PSNativeCommandUseErrorActionPreference = $true

if (-not $env:AWS_REGION) { $env:AWS_REGION = "us-east-1" }
$REGION = $env:AWS_REGION

# Nombres de recursos (iguales a la guia del curso)
$TOPIC_NAME     = "report-events"
$Q_REQUESTS     = "report-requests"
$Q_GENERATION   = "report-generation"
$Q_STOCK        = "report-stock-alerts"
$FN_RECORDER    = "report-request-recorder"
$FN_GENERATOR   = "report-generator"
$FN_STOCK       = "report-stock-alert"

# Quien soy: evita crear recursos en la cuenta equivocada
$ACCOUNT_ID = aws sts get-caller-identity --query Account --output text
if (-not $ACCOUNT_ID) { throw "No hay credenciales de AWS validas (en Learner Lab: copia de nuevo 'AWS Details' a ~/.aws/credentials)" }

$IS_LOCALSTACK = ($ACCOUNT_ID -eq "000000000000")
if ($IS_LOCALSTACK) {
    $RUNTIME  = "nodejs20.x"
    $ROLE_ARN = "arn:aws:iam::000000000000:role/lambda-role"   # LocalStack no valida el rol
} else {
    $RUNTIME  = "nodejs22.x"
    # Learner Lab no permite crear roles (iam:CreateRole): se usa el rol que trae el laboratorio.
    $ROLE_ARN = "arn:aws:iam::${ACCOUNT_ID}:role/LabRole"
}

$ROOT = Split-Path -Parent $PSScriptRoot
$DIST = Join-Path $ROOT "dist"

# Escribe JSON sin BOM (el AWS CLI falla con la marca BOM que agrega PowerShell 5.1)
function Write-JsonFile($Path, $Text) {
    [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false))
}

$target = if ($IS_LOCALSTACK) { "LocalStack" } else { "AWS REAL" }
Write-Host "Destino: $target | cuenta $ACCOUNT_ID | region $REGION | runtime $RUNTIME" -ForegroundColor Cyan
