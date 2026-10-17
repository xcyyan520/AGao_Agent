# start_phone.ps1 —— 一条命令：起服务 + 开隧道 + 把手机要扫的二维码打在屏幕上
#
# 用法（在 07-同步思考 目录下）：
#   .\start_phone.ps1
#
# 跑起来之后屏幕上会出现一个二维码，手机扫一下就打开页面。
# 关掉这个窗口（或按 Ctrl+C）服务就停了，手机那边随之失效。
#
# 需要先装好 cloudflared（脚本会告诉你怎么装，或者直接去下 exe）。

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

# ── 0. 把控制台切成 UTF-8，否则二维码会变成一整片「鈻堚枅」 ─────────────
# 踩过的坑：Windows 中文版控制台默认代码页是 936(GBK)。qr.mjs 打印的方块字符
# █ 是 U+2588，UTF-8 编码为 E2 96 88 三个字节；GBK 把它们按两字节一组硬解，
# 就得到「鈻堚枅」这种鬼东西，扫不出来。切到 65001 后再打印就正常了。
# 脚本结束时恢复原来的代码页，不然会把调用者的窗口弄成 UTF-8。
$__origCP = $null
try { $__origCP = [Console]::OutputEncoding.CodePage } catch { }
try {
  chcp 65001 > $null
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {
  Write-Host '  (切 UTF-8 失败，二维码可能显示成乱码，看下面那行网址手输即可)' -ForegroundColor Yellow
}

$PORT      = if ($env:PORT) { [int]$env:PORT } else { 8900 }
$TUNNEL_LOG = Join-Path $PWD '.run\tunnel.log'
$TUNNEL_ERR = Join-Path $PWD '.run\tunnel.err.log'
$SERVER_LOG = Join-Path $PWD '.run\server_phone.log'

New-Item -ItemType Directory -Force -Path (Join-Path $PWD '.run') | Out-Null

function Say($t, $c = 'Gray') { Write-Host $t -ForegroundColor $c }

Say ''
Say '  ╔══════════════════════════════════════════════════════════╗' 'DarkCyan'
Say '  ║   边说边出题 · 手机版                                    ║' 'DarkCyan'
Say '  ╚══════════════════════════════════════════════════════════╝' 'DarkCyan'
Say ''

# ── 1. 找 cloudflared ────────────────────────────────────────────────
$cf = $null
foreach ($c in @(
    (Join-Path $env:LOCALAPPDATA 'cloudflared\cloudflared.exe'),
    (Join-Path $env:ProgramFiles 'cloudflared\cloudflared.exe')
  )) {
  if (Test-Path $c) { $cf = $c; break }
}
if (-not $cf) {
  $g = Get-Command cloudflared -ErrorAction SilentlyContinue
  if ($g) { $cf = $g.Source }
}
if (-not $cf) {
  Say '找不到 cloudflared。装一个（二选一）：' 'Yellow'
  Say ''
  Say '  方法一（推荐，一条命令）：' 'White'
  Say '    irm https://ghfast.top/https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe `' 'DarkGray'
  Say '      -OutFile "$env:LOCALAPPDATA\cloudflared\cloudflared.exe"' 'DarkGray'
  Say ''
  Say '  方法二（有 winget 且是管理员）：' 'White'
  Say '    winget install Cloudflare.cloudflared' 'DarkGray'
  Say ''
  Say '  下载好之后重新跑这个脚本即可。' 'White'
  exit 1
}
Say "  cloudflared  $cf" 'DarkGray'

# ── 2. Key ───────────────────────────────────────────────────────────
$key = [Environment]::GetEnvironmentVariable('ALI_DEEPSEEK_API_KEY', 'Machine')
if (-not $key) { $key = [Environment]::GetEnvironmentVariable('ALI_DEEPSEEK_API_KEY', 'User') }
if (-not $key) { $key = $env:ALI_DEEPSEEK_API_KEY }
if (-not $key) {
  Say '找不到 ALI_DEEPSEEK_API_KEY。设置方法：' 'Red'
  Say '  [Environment]::SetEnvironmentVariable("ALI_DEEPSEEK_API_KEY","sk-你的key","User")' 'DarkGray'
  exit 1
}

$env:LLM_BASE  = 'https://dashscope.aliyuncs.com/compatible-mode'   # 不带 /v1
$env:LLM_MODEL = 'deepseek-v4.1-flash'                              # v4.1 后面是短横
$env:LLM_KEY   = $key
# 语音识别要单独一把 Key，但没有独立的就用同一把（两者都在百炼）。
# 不设这个变量的话，手机上点「开始说话」会一直连不上识别服务。
$env:ASR_KEY   = if ($env:ASR_KEY) { $env:ASR_KEY } else { $key }
$env:PORT      = "$PORT"

# ── 3. 起服务（如果 8900 已经有服务在跑就复用） ────────────────────────
$serverProc = $null
$busy = Get-NetTCPConnection -State Listen -LocalPort $PORT -ErrorAction SilentlyContinue
if ($busy) {
  $old = Get-Process -Id $busy[0].OwningProcess -ErrorAction SilentlyContinue
  Say "  端口 $PORT 已有服务在跑（PID $($busy[0].OwningProcess) $($old.ProcessName)），直接复用。" 'DarkGray'
} else {
  Say '  正在起服务…' 'DarkGray'
  $node = (Get-Command node).Source
  $serverProc = Start-Process -FilePath $node -ArgumentList 'server.mjs' -WorkingDirectory $PWD `
    -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $SERVER_LOG -RedirectStandardError "$SERVER_LOG.err"
  # 等到端口真的在听为止，别让隧道抢在服务前面连上去
  $ok = $false
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 250
    if (Get-NetTCPConnection -State Listen -LocalPort $PORT -ErrorAction SilentlyContinue) { $ok = $true; break }
    if ($serverProc.HasExited) { break }
  }
  if (-not $ok) {
    Say '服务没起来。看日志：' 'Red'
    Say "  $SERVER_LOG" 'DarkGray'
    if (Test-Path $SERVER_LOG) { Get-Content $SERVER_LOG -Tail 20 | ForEach-Object { Say "  $_" 'DarkGray' } }
    if ($serverProc -and -not $serverProc.HasExited) { $serverProc | Stop-Process -Force }
    exit 1
  }
  Say "  服务已就绪  http://127.0.0.1:$PORT" 'Green'
}

# ── 4. 开隧道 ────────────────────────────────────────────────────────
Remove-Item $TUNNEL_LOG -Force -ErrorAction SilentlyContinue
Remove-Item $TUNNEL_ERR -Force -ErrorAction SilentlyContinue
Say '  正在开隧道…' 'DarkGray'
# ⚠️ 这里踩过一个坑：cloudflared 把带网址的那个框（就是画着
#     |  https://xxx.trycloudflare.com  |  的那个 banner）直接往 stderr 打印，
#     不经过它自己的 logger，所以 --logfile 指的文件里**没有网址**，
#     只有 JSON 格式的 INFO 日志。第一版只读 --logfile，结果永远拿不到 URL。
#     正确做法：stderr 也必须重定向到文件，然后两个文件一起搜。
$tunnelProc = Start-Process -FilePath $cf `
  -ArgumentList @('tunnel', '--url', "http://127.0.0.1:$PORT", '--no-autoupdate', '--logfile', $TUNNEL_LOG, '--loglevel', 'info') `
  -WindowStyle Hidden -PassThru `
  -RedirectStandardError $TUNNEL_ERR

# 从两个文件里把 trycloudflare 的网址抠出来（stderr 才是真有网址的那个）
$url = $null
for ($i = 0; $i -lt 120; $i++) {
  Start-Sleep -Milliseconds 500
  foreach ($f in @($TUNNEL_ERR, $TUNNEL_LOG)) {
    if ($url) { break }
    if (-not (Test-Path $f)) { continue }
    $hit = Select-String -Path $f -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue |
           Select-Object -First 1
    if ($hit) { $url = [regex]::Match($hit.Line, 'https://[a-z0-9-]+\.trycloudflare\.com').Value }
  }
  if ($url) { break }
  if ($tunnelProc.HasExited) { break }
}

if (-not $url) {
  Say '隧道没开出网址来。日志：' 'Red'
  Say "  $TUNNEL_ERR" 'DarkGray'
  if (Test-Path $TUNNEL_ERR) { Get-Content $TUNNEL_ERR -Tail 25 | ForEach-Object { Say "  $_" 'DarkGray' } }
  if ($tunnelProc -and -not $tunnelProc.HasExited) { $tunnelProc | Stop-Process -Force }
  if ($serverProc -and -not $serverProc.HasExited) { $serverProc | Stop-Process -Force }
  exit 1
}

# ── 5. 打出来 ────────────────────────────────────────────────────────
Say ''
Say '  ════════════════════════════════════════════════════════════' 'Green'
Say '   手机扫这个二维码（用微信扫一扫）' 'Green'
Say '  ════════════════════════════════════════════════════════════' 'Green'
Say ''

node tools/qr.mjs $url

Say ''
Say "  网址：$url" 'Cyan'
Say ''
Say '  ── 怎么用 ────────────────────────────────────────────────' 'DarkGray'
Say '   1. 先在电脑上把「面试材料」贴好、点保存' 'White'
Say '   2. 手机上打开这个页面，把候选人的回答贴进「模拟候选人说话」' 'White'
Say '   3. 点「开始回放」，题目就会一块一块地出来' 'White'
Say ''
Say '  ── 两个别慌的事 ──────────────────────────────────────────' 'DarkGray'
Say '   · 右上角显示「断线，改用轮询」是正常的：' 'White'
Say '     快速隧道不支持 SSE 推送，题目改由每 2 秒一次的轮询送上屏，' 'DarkGray'
Say '     最多慢 2 秒，功能不缺。' 'DarkGray'
Say '   · 这个网址每次重启都变，关了窗口就失效。' 'White'
Say ''
Say '  按 Ctrl+C 结束（服务和隧道会一起关掉）' 'DarkGray'
Say ''

# ── 6. 守着，Ctrl+C 时收摊 ────────────────────────────────────────────
try {
  while ($true) {
    Start-Sleep -Seconds 1
    if ($tunnelProc.HasExited) { Say '隧道退出了。' 'Yellow'; break }
  }
} finally {
  Say ''
  Say '  正在关闭…' 'DarkGray'
  if ($tunnelProc -and -not $tunnelProc.HasExited) { $tunnelProc | Stop-Process -Force -ErrorAction SilentlyContinue }
  if ($serverProc -and -not $serverProc.HasExited) { $serverProc | Stop-Process -Force -ErrorAction SilentlyContinue }
  # 把代码页还原，别把用户原来的窗口弄脏
  if ($__origCP -and $__origCP -ne 65001) {
    try { chcp $__origCP > $null } catch { }
  }
  Say '  已关闭。' 'DarkGray'
}
