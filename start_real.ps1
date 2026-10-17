# start_real.ps1 —— 用真实的阿里云 DashScope 跑「边说边出题」
#
# 用法（在 07-同步思考 目录下）：
#   .\start_real.ps1
# 然后浏览器打开 http://127.0.0.1:8900，点「开始说话」。
#
# 不需要 fake_stream.mjs —— 那个假接口也不用启动。
#
# ── 两个曾经踩过的坑，别改回去 ──────────────────────────────────────────
# 1. 模型名是 deepseek-v4.1-flash（v4.1 后面是短横，不是 f）。
#    写成 deepseek-v4.1f-flash 会返回 404 model_not_found。
#    对不上时用这个看真实可用的模型列表：
#      curl -H "Authorization: Bearer $env:ALI_DEEPSEEK_API_KEY" `
#           https://dashscope.aliyuncs.com/compatible-mode/v1/models
#
# 2. LLM_BASE 是 .../compatible-mode，【不带 /v1】。
#    engine.mjs 自己会拼 `/v1/chat/completions`，多写一个 /v1 会拼成
#    /v1/v1/... 返回 404。三个写法里只有不带 /v1 的那个通。
#    （拼接那行现在在 engine.mjs 的 `_infer()` 里，搜 `v1/chat/completions`
#      就能找到；改了 engine.mjs 之后行号会漂，别按行号找。）

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

# Key 从系统环境变量读，不写在这个文件里。
# 用 Machine + User 两级回退：只配了其中一级也能跑。
$key = [Environment]::GetEnvironmentVariable('ALI_DEEPSEEK_API_KEY', 'Machine')
if (-not $key) { $key = [Environment]::GetEnvironmentVariable('ALI_DEEPSEEK_API_KEY', 'User') }
if (-not $key) { $key = $env:ALI_DEEPSEEK_API_KEY }
if (-not $key) {
  Write-Host '找不到 ALI_DEEPSEEK_API_KEY。' -ForegroundColor Red
  Write-Host '设置方法（当前用户，永久生效，需要重开终端）：'
  Write-Host '  [Environment]::SetEnvironmentVariable("ALI_DEEPSEEK_API_KEY","sk-你的key","User")'
  exit 1
}

$env:LLM_BASE  = 'https://dashscope.aliyuncs.com/compatible-mode'
$env:LLM_MODEL = 'deepseek-v4.1-flash'
$env:LLM_KEY   = $key
# 语音识别和出题都在百炼，用同一把 Key。这里显式写上，是为了让人一眼看出
# 「录音这条链路要花钱」，而不是以为它是本地免费的。
# 价格 0.00033 元/秒 ≈ 1.19 元/小时（fun-asr-realtime）。
$env:ASR_KEY   = $key
$env:PORT      = if ($env:PORT) { $env:PORT } else { '8900' }

# 端口占用时先报清楚，别让 node 抛一堆 EADDRINUSE 栈
$busy = Get-NetTCPConnection -State Listen -LocalPort ([int]$env:PORT) -ErrorAction SilentlyContinue
if ($busy) {
  $p = Get-Process -Id $busy[0].OwningProcess -ErrorAction SilentlyContinue
  Write-Host "端口 $env:PORT 已被占用（PID $($busy[0].OwningProcess) $($p.ProcessName)）。" -ForegroundColor Yellow
  Write-Host "先停掉它，或换端口：`$env:PORT='8902'; .\start_real.ps1"
  exit 1
}

Write-Host ''
Write-Host '  启动中 · 模型 ' -NoNewline
Write-Host $env:LLM_MODEL -ForegroundColor Cyan -NoNewline
Write-Host " @ dashscope.aliyuncs.com"
Write-Host "  页面 http://127.0.0.1:$env:PORT"
Write-Host ''

node server.mjs
