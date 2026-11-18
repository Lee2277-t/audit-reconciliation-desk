# Local static server for the reconciliation tool (loopback only).
# Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI,
# which would corrupt any Chinese literal here. $PSScriptRoot resolves the real
# (Chinese) folder path at runtime, so no literals are needed.
$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$marker = Join-Path $env:TEMP 'recon-serve.json'

$version = 'dev'
$versionFile = Join-Path $root 'version.txt'
if (Test-Path -LiteralPath $versionFile) {
  $v = (Get-Content -LiteralPath $versionFile -Raw).Trim()
  if ($v) { $version = $v }
}

function Open-Page([string]$url) {
  try { Start-Process $url } catch { Start-Process 'cmd.exe' -ArgumentList '/c', 'start', '""', $url }
}

function Probe-Existing([string]$port) {
  try {
    $resp = Invoke-WebRequest -Uri ('http://127.0.0.1:' + $port + '/health') -UseBasicParsing -TimeoutSec 2
    return ($resp.StatusCode -eq 200)
  } catch { return $false }
}

# 1) Another copy already running? Reuse it, do not stack listeners.
if (Test-Path -LiteralPath $marker) {
  try {
    $info = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
    if ($info.pid -and $info.port -and (Get-Process -Id $info.pid -ErrorAction SilentlyContinue)) {
      if (Probe-Existing ([string]$info.port)) {
        if ($env:RECON_NO_BROWSER -ne '1') {
          Open-Page ('http://127.0.0.1:' + $info.port + '/index.html')
        }
        exit 0
      }
    }
  } catch { }
}

# 2) Bind the first free loopback port.
# A listener whose Start() failed cannot be reused (Prefixes turns null), so
# build a fresh one per port and only keep the candidate that started.
# Accept 127.0.0.1, localhost and [::1] so a browser that resolves localhost
# to IPv6 first does not show "cannot connect". Fall back to IPv4 + localhost
# when the machine has IPv6 disabled.
function Start-Loopback([int]$p) {
  $full = New-Object System.Net.HttpListener
  $full.Prefixes.Add('http://127.0.0.1:' + $p + '/')
  $full.Prefixes.Add('http://localhost:' + $p + '/')
  try { $full.Prefixes.Add('http://[::1]:' + $p + '/') } catch { }
  try {
    $full.Start()
    return $full
  } catch {
    try { $full.Close() } catch { }
  }
  $basic = New-Object System.Net.HttpListener
  $basic.Prefixes.Add('http://127.0.0.1:' + $p + '/')
  $basic.Prefixes.Add('http://localhost:' + $p + '/')
  $basic.Start()
  return $basic
}

$listener = $null
$port = 0
foreach ($p in 8765..8785) {
  try {
    $listener = Start-Loopback $p
    $port = $p
    break
  } catch { }
}
if (-not $listener) { exit 1 }

try {
  @{ port = $port; pid = $PID; version = $version } | ConvertTo-Json -Compress |
    Set-Content -LiteralPath $marker -Encoding ASCII
  [Console]::Title = 'recon-serve ' + $version + '  http://127.0.0.1:' + $port + '/  (close this window to stop)'
} catch { }

$mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.js'   = 'application/javascript; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.txt'  = 'text/plain; charset=utf-8'
  '.csv'  = 'text/csv; charset=utf-8'
  '.bat'  = 'application/octet-stream'
  '.ico'  = 'image/x-icon'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.svg'  = 'image/svg+xml'
  '.xlsx' = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  '.xlsm' = 'application/vnd.ms-excel.sheet.macroEnabled.12'
  '.xls'  = 'application/vnd.ms-excel'
}

if ($env:RECON_NO_BROWSER -ne '1') {
  Open-Page ('http://127.0.0.1:' + $port + '/index.html')
}

while ($listener.IsListening) {
  try { $ctx = $listener.GetContext() } catch { break }
  try {
    $res = $ctx.Response
    $req = $ctx.Request
    $path = [System.Uri]::UnescapeDataString($req.Url.LocalPath)
    $res.Headers.Set('Cache-Control', 'no-store')

    if ($path -eq '/health') {
      $body = [Text.Encoding]::UTF8.GetBytes('{"ok":true,"version":"' + $version + '"}')
      $res.ContentType = 'application/json; charset=utf-8'
      $res.ContentLength64 = $body.Length
      $res.OutputStream.Write($body, 0, $body.Length)
    }
    elseif ($req.HttpMethod -ne 'GET' -and $req.HttpMethod -ne 'HEAD') {
      $res.StatusCode = 405
    }
    else {
      if ($path -eq '/' -or $path -eq '') { $path = '/index.html' }
      $rel = $path.Substring(1).Replace('/', [IO.Path]::DirectorySeparatorChar)
      $rootFull = [IO.Path]::GetFullPath($root)
      $full = [IO.Path]::GetFullPath((Join-Path $rootFull $rel))
      if (-not $full.StartsWith($rootFull + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
          -not (Test-Path -LiteralPath $full -PathType Leaf)) {
        $res.StatusCode = 404
        $body = [Text.Encoding]::UTF8.GetBytes('Not found')
        $res.ContentType = 'text/plain; charset=utf-8'
        $res.ContentLength64 = $body.Length
        $res.OutputStream.Write($body, 0, $body.Length)
      }
      else {
        $ext = [IO.Path]::GetExtension($full).ToLowerInvariant()
        $type = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
        if ($ext -eq '.html') {
          $text = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($full)).Replace('__APP_VERSION__', $version)
          $body = [Text.Encoding]::UTF8.GetBytes($text)
        }
        else {
          $body = [IO.File]::ReadAllBytes($full)
        }
        $res.ContentType = $type
        $res.ContentLength64 = $body.Length
        $res.OutputStream.Write($body, 0, $body.Length)
      }
    }
  } catch {
    try { $ctx.Response.StatusCode = 500 } catch { }
  }
  finally {
    try { $ctx.Response.Close() } catch { }
  }
}

try { $listener.Stop(); $listener.Close() } catch { }
try { Remove-Item -LiteralPath $marker -ErrorAction SilentlyContinue } catch { }
