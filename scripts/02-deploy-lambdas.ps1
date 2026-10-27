# Crea (o actualiza, si ya existen) las dos Lambdas con sus variables de entorno.
# Pide por consola la cadena de Supabase y la clave del servicio de avisos: no quedan en ningun archivo del repo.
# Ejecutar desde la raiz del repo, despues de 01-package.ps1: .\scripts\02-deploy-lambdas.ps1

. "$PSScriptRoot\00-config.ps1"

function Read-Secret($Prompt) {
    $secure = Read-Host -Prompt $Prompt -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

# Cadena del SESSION POOLER de Supabase (IPv4). Ejemplo de forma:
# postgresql://postgres.<ref>:<password>@aws-0-us-east-1.pooler.supabase.com:5432/postgres
$DATABASE_URL = Read-Secret "DATABASE_URL (Supabase, session pooler)"
if ($DATABASE_URL -notlike "postgresql://*") { throw "DATABASE_URL debe empezar por postgresql://" }

if (-not $env:NOTICE_URL) { $env:NOTICE_URL = "https://app.claudioviajando.com/api/saas/notices" }
$NOTICE_API_KEY = Read-Secret "NOTICE_API_KEY (clave del servicio de avisos)"
if (-not $NOTICE_API_KEY) { throw "NOTICE_API_KEY vacia" }

$envRecorder  = Join-Path ([IO.Path]::GetTempPath()) "env-recorder.json"
$envGenerator = Join-Path ([IO.Path]::GetTempPath()) "env-generator.json"
$envStock     = Join-Path ([IO.Path]::GetTempPath()) "env-stock.json"
# Umbral de "stock bajo" para la Lambda 3 (mismo criterio del panel de Admin: <= 2)
if (-not $env:LOW_STOCK_THRESHOLD) { $env:LOW_STOCK_THRESHOLD = "2" }
try {
    # ConvertTo-Json escapa correctamente comillas o barras que pudiera tener la contrasena
    Write-JsonFile $envRecorder  (@{ Variables = @{ DATABASE_URL = $DATABASE_URL } } | ConvertTo-Json -Compress)
    Write-JsonFile $envGenerator (@{ Variables = @{
        DATABASE_URL   = $DATABASE_URL
        NOTICE_URL     = $env:NOTICE_URL
        NOTICE_API_KEY = $NOTICE_API_KEY } } | ConvertTo-Json -Compress)
    Write-JsonFile $envStock (@{ Variables = @{
        DATABASE_URL        = $DATABASE_URL
        NOTICE_URL          = $env:NOTICE_URL
        NOTICE_API_KEY      = $NOTICE_API_KEY
        LOW_STOCK_THRESHOLD = $env:LOW_STOCK_THRESHOLD } } | ConvertTo-Json -Compress)

    $functions = @(
        @{ Name = $FN_RECORDER;  Zip = (Join-Path $DIST "recorder.zip");  Env = $envRecorder },
        @{ Name = $FN_GENERATOR; Zip = (Join-Path $DIST "generator.zip"); Env = $envGenerator },
        @{ Name = $FN_STOCK;     Zip = (Join-Path $DIST "stock-alert.zip"); Env = $envStock }
    )
    foreach ($f in $functions) {
        if (-not (Test-Path $f.Zip)) { throw "No existe $($f.Zip): ejecuta antes .\scripts\01-package.ps1" }
        $exists = $true
        try { aws lambda get-function --function-name $f.Name --query Configuration.FunctionName --output text 2>$null | Out-Null }
        catch { $exists = $false }
        if ($LASTEXITCODE -ne 0) { $exists = $false }

        if (-not $exists) {
            Write-Host "Creando $($f.Name)..."
            # --query FunctionArn: evita que el CLI imprima la configuracion completa (con las claves)
            aws lambda create-function --function-name $f.Name `
                --runtime $RUNTIME --handler index.handler --timeout 15 --memory-size 128 `
                --role $ROLE_ARN --zip-file "fileb://$($f.Zip)" `
                --environment "file://$($f.Env)" `
                --query FunctionArn --output text
            aws lambda wait function-active-v2 --function-name $f.Name
        } else {
            Write-Host "Actualizando $($f.Name)..."
            aws lambda update-function-code --function-name $f.Name --zip-file "fileb://$($f.Zip)" `
                --query LastUpdateStatus --output text
            aws lambda wait function-updated-v2 --function-name $f.Name
            aws lambda update-function-configuration --function-name $f.Name `
                --runtime $RUNTIME --handler index.handler --timeout 15 --memory-size 128 `
                --environment "file://$($f.Env)" `
                --query LastUpdateStatus --output text
            aws lambda wait function-updated-v2 --function-name $f.Name
        }
    }
} finally {
    # Los archivos con claves se borran siempre, aunque algo falle
    Remove-Item $envRecorder, $envGenerator, $envStock -ErrorAction SilentlyContinue
    $DATABASE_URL = $null; $NOTICE_API_KEY = $null
}

aws lambda list-functions --query "Functions[?starts_with(FunctionName,'report-')].[FunctionName,Runtime,State]" --output table
