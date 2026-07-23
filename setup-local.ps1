$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Write-Host "Arquivo .env criado. Preencha as credenciais antes de iniciar." -ForegroundColor Yellow
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw "Docker Desktop não foi encontrado."
}

$envContent = Get-Content ".env" -Raw
if ($envContent -match "troque_esta_senha") {
  Write-Host "Edite .env e troque senhas/tokens antes de continuar." -ForegroundColor Yellow
  notepad ".env"
  exit 0
}

docker compose up -d --build
Write-Host "CRM iniciado em http://localhost:3000" -ForegroundColor Green
