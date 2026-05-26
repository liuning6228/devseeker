# Tavily API 自检脚本
# 使用：在 VS Code 配好 Key 后运行本脚本，验证 Key 有效 & 网络通
param(
  [string]$Query = 'React 19 useFormStatus useActionState',
  [string]$KeyPath = '',
  [int]$TopK = 3
)

# 从 VS Code user settings 读 Key（如未手动传入）
if ([string]::IsNullOrWhiteSpace($KeyPath)) {
  $settingsPath = Join-Path $env:APPDATA 'Code\User\settings.json'
  if (-not (Test-Path $settingsPath)) { $settingsPath = Join-Path $env:APPDATA 'Cursor\User\settings.json' }
  if (Test-Path $settingsPath) {
    try {
      $raw = Get-Content $settingsPath -Raw -Encoding UTF8
      # 优先直接 regex 抠值，避免 JSONC 注释 / URL 里的 // 把 ConvertFrom-Json 干掉
      $m = [regex]::Match($raw, '"myAgent\.webResearch\.tavily\.apiKey"\s*:\s*"([^"]+)"')
      if ($m.Success) { $key = $m.Groups[1].Value }
      if (-not $key) {
        # 兜底：剥离整行注释后试 ConvertFrom-Json
        $clean = ($raw -split "`n" | ForEach-Object { if ($_ -match '^\s*//') { '' } else { $_ } }) -join "`n"
        $clean = $clean -replace '/\*[\s\S]*?\*/', ''
        $json = $clean | ConvertFrom-Json
        $key = $json.'myAgent.webResearch.tavily.apiKey'
      }
    } catch {}
  }
} else {
  $key = $KeyPath
}

if ([string]::IsNullOrWhiteSpace($key)) {
  Write-Host "❌ 未从 VS Code settings.json 找到 myAgent.webResearch.tavily.apiKey"
  Write-Host "   请在 VS Code Ctrl+, 里配好，或用 -KeyPath 'tvly-xxx' 手动传入"
  exit 1
}

Write-Host "🔑 Key: $($key.Substring(0, [Math]::Min(12, $key.Length)))... (len=$($key.Length))"

$body = @{
  api_key       = $key
  query         = $Query
  search_depth  = 'basic'
  max_results   = $TopK
  include_answer = $false
} | ConvertTo-Json

try {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $resp = Invoke-RestMethod -Uri 'https://api.tavily.com/search' -Method POST -Body $body -ContentType 'application/json' -TimeoutSec 15
  $sw.Stop()
  Write-Host "✅ Tavily OK | $($sw.ElapsedMilliseconds)ms | results=$($resp.results.Count)"
  $resp.results | Select-Object -First $TopK | ForEach-Object {
    Write-Host "  - $($_.title)"
    Write-Host "    $($_.url)"
  }
} catch {
  Write-Host "❌ Tavily FAIL: $($_.Exception.Message)"
  exit 2
}
