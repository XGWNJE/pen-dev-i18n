param(
  [string]$Target = (Join-Path $env:USERPROFILE 'Pen汉化'),
  [string]$AppPath,
  [switch]$Start
)

$ErrorActionPreference = 'Stop'
$cli = Join-Path $PSScriptRoot 'bin\zh-patch.mjs'
if (-not (Test-Path -LiteralPath $cli)) { throw '请从仓库根目录运行 install.ps1。' }
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) { throw '需要 Node.js 20 或更高版本。' }
$nodeMajor = [int](& $nodeCommand.Source -p 'parseInt(process.versions.node,10)')
if ($LASTEXITCODE -ne 0 -or $nodeMajor -lt 20) { throw '需要 Node.js 20 或更高版本。' }

if ($AppPath) {
  $resolvedApp = (Resolve-Path -LiteralPath $AppPath -ErrorAction Stop).Path
  if ([System.IO.Path]::GetFileName($resolvedApp) -ne 'Pen.exe') { throw '-AppPath 必须指向 Pen.exe。' }
  $env:PEN_APP_PATH = $resolvedApp
}

New-Item -ItemType Directory -Path $Target -Force | Out-Null
& $nodeCommand.Source $cli preset use pen --dir $Target
if ($LASTEXITCODE -ne 0) { throw '生成 Pen 配置失败。' }
& $nodeCommand.Source $cli install-launcher --dir $Target
if ($LASTEXITCODE -ne 0) { throw '生成启动器失败。' }
Write-Host "安装完成：$Target\启动汉化.bat"
Write-Host '使用汉化前，请先保存设计并正常退出已运行的 Pen。'

if ($Start) {
  Push-Location -LiteralPath $Target
  try {
    & $nodeCommand.Source $cli start
    if ($LASTEXITCODE -ne 0) { throw '启动或注入失败，请检查上面的错误。' }
  } finally { Pop-Location }
}
