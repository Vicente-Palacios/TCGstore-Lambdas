# Empaqueta cada Lambda en dist\<nombre>.zip con index.js, package.json y node_modules en la raiz del zip.
# No toca AWS. Ejecutar desde la raiz del repo: .\scripts\01-package.ps1

$ErrorActionPreference = "Stop"
$ROOT = Split-Path -Parent $PSScriptRoot
$DIST = Join-Path $ROOT "dist"
New-Item -ItemType Directory -Force $DIST | Out-Null

foreach ($fn in "recorder", "generator", "stock-alert") {
    Push-Location (Join-Path $ROOT $fn)
    try {
        # Instalacion limpia y solo dependencias de produccion (pg), segun package-lock.json
        npm ci --omit=dev --no-audit --no-fund --silent
        if ($LASTEXITCODE -ne 0) { throw "npm ci fallo en $fn" }
        $zip = Join-Path $DIST "$fn.zip"
        if (Test-Path $zip) { Remove-Item $zip }
        # tar -a crea un zip con rutas "/" (Compress-Archive usa "\" y Lambda en Linux no las entiende bien)
        tar -a -c -f $zip index.js package.json node_modules
        if ($LASTEXITCODE -ne 0) { throw "tar fallo en $fn" }
    } finally {
        Pop-Location
    }
}
Get-ChildItem (Join-Path $DIST "*.zip") | Select-Object Name, @{n = "KB"; e = { [math]::Round($_.Length / 1KB) } }
