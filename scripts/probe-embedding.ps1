# probe-embedding.ps1 — 独立验证 DashScope text-embedding-v3 连通性
# 用法：cd c:\Users\12575\workspace\my-agent; .\scripts\probe-embedding.ps1

$ErrorActionPreference = 'Continue'
Write-Host "=== DashScope Embedding Probe ===" -ForegroundColor Cyan

# 1) 从 VS Code settings.json 读 Key（不在屏幕显示完整 Key）
$settingsPath = "$env:APPDATA\Code\User\settings.json"
if (-not (Test-Path $settingsPath)) {
  Write-Host "❌ 找不到 settings.json: $settingsPath" -ForegroundColor Red
  exit 1
}
$settings = Get-Content $settingsPath -Raw | ConvertFrom-Json
$apiKey = $settings.'myAgent.qwenVl.apiKey'
$baseUrl = $settings.'myAgent.qwenVl.baseUrl'
if (-not $baseUrl) { $baseUrl = 'https://dashscope.aliyuncs.com/compatible-mode/v1' }

if (-not $apiKey) {
  Write-Host "❌ settings.json 里没有 myAgent.qwenVl.apiKey" -ForegroundColor Red
  exit 1
}
$keyMask = $apiKey.Substring(0,[Math]::Min(6,$apiKey.Length)) + '...(' + $apiKey.Length + ' chars)'
Write-Host "API Key : $keyMask" -ForegroundColor Gray
Write-Host "Base URL: $baseUrl" -ForegroundColor Gray

# 2) DNS 探测
Write-Host "`n[1/3] DNS 解析..." -ForegroundColor Yellow
try {
  $dns = Resolve-DnsName -Name 'dashscope.aliyuncs.com' -Type A -ErrorAction Stop
  $dns | Select-Object Name, IPAddress | Format-Table | Out-String | Write-Host
} catch {
  Write-Host "❌ DNS 失败: $($_.Exception.Message)" -ForegroundColor Red
}

# 3) TCP 443 探测
Write-Host "[2/3] TCP 443 连通性..." -ForegroundColor Yellow
try {
  $tcp = Test-NetConnection -ComputerName 'dashscope.aliyuncs.com' -Port 443 -WarningAction SilentlyContinue
  Write-Host "TcpTestSucceeded = $($tcp.TcpTestSucceeded); RemoteAddress = $($tcp.RemoteAddress)" -ForegroundColor Gray
} catch {
  Write-Host "❌ TCP 失败: $($_.Exception.Message)" -ForegroundColor Red
}

# 4) 实际调用 embedding 接口
Write-Host "`n[3/3] POST $baseUrl/embeddings ..." -ForegroundColor Yellow
$body = @{
  model = 'text-embedding-v3'
  input = @('hello world', 'test embedding call')
  encoding_format = 'float'
} | ConvertTo-Json -Depth 4

$headers = @{
  'Authorization' = "Bearer $apiKey"
  'Content-Type'  = 'application/json'
}

try {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $resp = Invoke-RestMethod -Uri "$baseUrl/embeddings" -Method POST -Headers $headers -Body $body -TimeoutSec 30 -ErrorAction Stop
  $sw.Stop()
  $dim = $resp.data[0].embedding.Count
  Write-Host "✅ HTTP 200, 耗时 $($sw.ElapsedMilliseconds) ms" -ForegroundColor Green
  Write-Host "   返回 $($resp.data.Count) 条向量，维度 = $dim，tokens = $($resp.usage.total_tokens)" -ForegroundColor Green
} catch [System.Net.WebException] {
  $we = $_.Exception
  $resp = $we.Response
  if ($resp) {
    $reader = New-Object IO.StreamReader($resp.GetResponseStream())
    $text = $reader.ReadToEnd()
    Write-Host "❌ HTTP $([int]$resp.StatusCode): $text" -ForegroundColor Red
  } else {
    Write-Host "❌ WebException: $($we.Message)" -ForegroundColor Red
  }
} catch {
  Write-Host "❌ 未知错误: $($_.Exception.GetType().Name): $($_.Exception.Message)" -ForegroundColor Red
  if ($_.Exception.InnerException) {
    Write-Host "   inner: $($_.Exception.InnerException.Message)" -ForegroundColor Red
  }
}

# 5) 代理信息
Write-Host "`n=== 代理环境信息 ===" -ForegroundColor Cyan
"HTTP_PROXY  = $env:HTTP_PROXY"
"HTTPS_PROXY = $env:HTTPS_PROXY"
"NO_PROXY    = $env:NO_PROXY"
$vscSettings = @(
  'http.proxy',
  'http.proxyStrictSSL',
  'http.proxySupport',
  'http.systemCertificates'
)
foreach ($k in $vscSettings) {
  $v = $settings.$k
  Write-Host "VSCode $k = $v"
}
