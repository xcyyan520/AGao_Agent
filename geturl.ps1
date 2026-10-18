# geturl.ps1 —— 只问一件事：外部地址是多少？
#
# 用法（在 07-同步思考 目录下，或者任意目录传绝对路径）：
#   .\geturl.ps1            有隧道就打印，没有就开一条再打印
#   .\geturl.ps1 -Restart   把旧隧道关掉重开（网址会变）
#
# 为什么单独有这个脚本：
#   隧道是在后台跑的（Start-Process -WindowStyle Hidden），它的网址只写在
#   cloudflared 的 stderr 里，那个窗口根本没有界面可看。于是「外部网址是多少」
#   这个问题，每次都得靠人回忆、翻日志、或者重新开一遍隧道。
#   有 .run\URL.txt 之后这件事应该永远是 0 秒：
#       Get-Content .run\URL.txt
#   这个脚本就是那一步的加强版：文件没了、进程死了，它自己会补上。
#
# 和 start_phone.ps1 的分工：
#   start_phone.ps1  从零起「服务 + 隧道 + 二维码」，用完 Ctrl+C 全关
#   geturl.ps1       服务已经在跑（或要在别处用），只想拿个能发给别人的网址

param(
  [switch]$Restart,
  [int]$Port = 8900
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

# 二维码要打方块字符，先切 UTF-8，结束时还原
$__origCP = $null
try { $__origCP = [Console]::OutputEncoding.CodePage } catch { }
try {
  chcp 65001 > $null
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch { }

function Say($t, $c = 'Gray') { Write-Host $t -ForegroundColor $c }

$RUN = Join-Path $PWD '.run'
$URL_FILE  = Join-Path $RUN 'URL.txt'
$TUNNEL_LOG = Join-Path $RUN 'tunnel.log'
$TUNNEL_ERR = Join-Path $RUN 'tunnel.err.log'
$TUNNEL_OUT = Join-Path $RUN 'tunnel.out.log'
New-Item -ItemType Directory -Force -Path $RUN | Out-Null

function Find-Urls {
  # 把所有可能的网址都收上来，不去重排序里的先后（调用处自己决定优先级）。
  # ★ 为什么不能「找到第一个就返回」：URL.txt 是上一次隧道的缓存，隧道重启后
  #   它里面的地址已经死了。先信它就会打印一个打不开的网址——而问「网址是多少」
  #   的人拿到一个打不开的地址，比什么都没拿到更耽误事。
  param([string[]]$Files)
  $seen = @{}
  $out = @()
  foreach ($f in $Files) {
    if (-not (Test-Path $f)) { continue }
    $hits = Select-String -Path $f -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue
    foreach ($h in $hits) {
      $m = [regex]::Match($h.Line, 'https://[a-z0-9-]+\.trycloudflare\.com').Value
      if ($m -and -not $seen.ContainsKey($m)) { $seen[$m] = $true; $out += $m }
    }
  }
  return $out
}

function Test-Url {
  # 从外网打回首页。5.1 和 7 都认的写法（-SkipHttpErrorCheck 只有 7 有）。
  #
  # ★ 超时必须短（6 秒）。这里的探测会被重试十几轮，25 秒超时意味着「刚开好
  #   的隧道 DNS 还没生效」时第一轮就干等 25 秒——实测整体拖到 83 秒，人早以为
  #   它挂了。6 秒足够一次正常的 TLS 握手 + 首页返回（首页是几十 KB 的纯文本）。
  param([string]$U)
  try {
    $r = Invoke-WebRequest -Uri "$U/" -TimeoutSec 6 -UseBasicParsing -ErrorAction Stop
    return [int]$r.StatusCode
  } catch {
    $rr = $_.Exception.Response
    if ($rr -and $rr.StatusCode) { return [int]$rr.StatusCode }
    return 0
  }
}

try {
  # ── 1. 服务在不在？网址没人访问得通就没意义 ──────────────────────
  $listen = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
  if (-not $listen) {
    Say "  端口 $Port 上没有服务在跑。先起服务：" 'Red'
    Say '    .\start_real.ps1        （真实模型）' 'DarkGray'
    Say '    .\start_phone.ps1       （服务 + 隧道 + 二维码，一条龙）' 'DarkGray'
    exit 1
  }

  # ── 2. 已有隧道还活着吗？──────────────────────────────────────────
  $tunnel = Get-Process cloudflared -ErrorAction SilentlyContinue
  $cands = @(Find-Urls @($URL_FILE, $TUNNEL_ERR, $TUNNEL_LOG))

  if ($Restart -and $tunnel) {
    Say '  按 -Restart 把旧隧道关掉…' 'DarkGray'
    $tunnel | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 800
    $tunnel = $null
    $cands = @()
  }

  # 进程在但网址拿不到：日志被清过或还没写出来，等一会儿再找
  if ($tunnel -and -not $cands.Count) {
    for ($i = 0; $i -lt 40; $i++) {
      Start-Sleep -Milliseconds 500
      $cands = @(Find-Urls @($TUNNEL_ERR, $TUNNEL_LOG))
      if ($cands.Count) { break }
    }
  }

  # ── 3. 没有隧道就开一条 ──────────────────────────────────────────
  if (-not $tunnel) {
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
      Say '  找不到 cloudflared。装一个：' 'Red'
      Say '    irm https://ghfast.top/https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe `' 'DarkGray'
      Say '      -OutFile "$env:LOCALAPPDATA\cloudflared\cloudflared.exe"' 'DarkGray'
      exit 1
    }

    Say '  开隧道…' 'DarkGray'
    Remove-Item $TUNNEL_LOG, $TUNNEL_ERR, $TUNNEL_OUT -Force -ErrorAction SilentlyContinue
    # ★ -RedirectStandardOutput 不能省。cloudflared 是长跑进程，如果不给它指定
    #   stdout，它就会继承本脚本的 stdout 管道并且一直不关；于是调用方
    #   （`.\geturl.ps1 | ...`、`$(...)`、任何 CI）在脚本明明已经退出之后还会
    #   永远等下去。实测一次就挂足 150 秒被转后台，而隧道本身早已 200。
    #   stderr 同理，两个都重定向掉，句柄才不会漏到底层进程手里。
    $tunnel = Start-Process -FilePath $cf `
      -ArgumentList @('tunnel', '--url', "http://127.0.0.1:$Port", '--no-autoupdate',
                      '--logfile', $TUNNEL_LOG, '--loglevel', 'info') `
      -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput $TUNNEL_OUT -RedirectStandardError $TUNNEL_ERR

    for ($i = 0; $i -lt 120; $i++) {
      Start-Sleep -Milliseconds 500
      $cands = @(Find-Urls @($TUNNEL_ERR, $TUNNEL_LOG))
      if ($cands.Count) { break }
      if ($tunnel.HasExited) { break }
    }
    # 日志里出现网址的那一刻，Cloudflare 的 DNS 往往还没建好。给它 3 秒再开打，
    # 否则第一轮必然超时——那是纯粹白等。
    if ($cands.Count) { Start-Sleep -Seconds 3 }
  }

  # ── 3.5 挑一个真的通的 ───────────────────────────────────────────
  # 只有 cloudflared 现在的进程还在，日志里那串才可能是活的；但日志可能
  # 混着上一轮的地址，所以还是要逐个打一次。全都不通才算失败。
  #
  # ★ 刚开出来的隧道不能只打一次就判死。Cloudflare 那边 DNS 生效要几秒，
  #   第一次请求常常连不上，实测拿到 HTTP 0 —— 如果这时就下结论，就会出现
  #   「明明刚开好一条活隧道，脚本却说隧道死了，让人再 -Restart 一次」，
  #   于是每次都换新网址，恶性循环。所以候选地址反复重试，有一轮 200 就算通。
  $url = $null
  $code = 0
  $maxRounds = 12          # 12 轮 × 3 秒 ≈ 36 秒，够 DNS 生效，又不用干等太久
  $needDelay = $true       # 第一轮之前先喘一口，别在 DNS 还没好的时候打
  for ($round = 1; $round -le $maxRounds -and -not $url; $round++) {
    foreach ($c in $cands) {
      $c2 = Test-Url $c
      if ($c2 -eq 200) { $url = $c; $code = 200; break }
      $code = $c2
    }
    if (-not $url -and $round -lt $maxRounds) {
      if ($needDelay) { Say '  隧道刚开，等它生效（最多半分钟）…' 'DarkGray'; $needDelay = $false }
      Start-Sleep -Seconds 3
    }
  }

  if (-not $url -and $cands.Count) {
    Say "  找到网址但都不通（最后一次 HTTP $code）：" 'Red'
    $cands | ForEach-Object { Say "    $_" 'DarkGray' }
    Say '  隧道可能在建的过程中失败了。看日志：' 'DarkGray'
    Say "    $TUNNEL_ERR" 'DarkGray'
    if (Test-Path $TUNNEL_ERR) { Get-Content $TUNNEL_ERR -Tail 10 | ForEach-Object { Say "    $_" 'DarkGray' } }
    # 死掉的地址留在 URL.txt 里会一直误导人，删掉
    if ((Test-Path $URL_FILE) -and -not (Get-Process cloudflared -ErrorAction SilentlyContinue)) {
      Remove-Item -LiteralPath $URL_FILE -Force -ErrorAction SilentlyContinue
    }
    exit 1
  }

  if (-not $url) {
    Say '  没拿到网址。日志：' 'Red'
    Say "    $TUNNEL_ERR" 'DarkGray'
    if (Test-Path $TUNNEL_ERR) { Get-Content $TUNNEL_ERR -Tail 20 | ForEach-Object { Say "    $_" 'DarkGray' } }
    exit 1
  }

  # ── 4. 记下来 ────────────────────────────────────────────────────
  # 自检已经在 3.5 做过了（走到这里说明打回首页就是 200），不再重复请求：
  # 每多打一次就多 1 秒等待，而结论不会变。
  try { Set-Content -LiteralPath $URL_FILE -Value $url -Encoding ascii -NoNewline } catch { }

  Say ''
  Say '  ════════════════════════════════════════════════════════════' 'Green'
  Say '   ★ 外部地址（手机、别人的电脑，都能直接打开）' 'Green'
  Say '  ════════════════════════════════════════════════════════════' 'Green'
  Say ''
  Say "    $url" 'White'
  Say ''
  Say '    自检：从外网打回首页，HTTP 200，能用。' 'Green'
  Say ''
  Say "    已存到 $URL_FILE" 'DarkGray'
  Say '    下次再查：Get-Content .run\URL.txt' 'DarkGray'
  Say '    换了要重开：.\geturl.ps1 -Restart' 'DarkGray'
  Say ''

  node tools/qr.mjs $url
  Say ''
  Say '  这个网址跟着 cloudflared 进程活着。进程一停就失效（网址会变）。' 'DarkGray'
  Say '  用完想关：Get-Process cloudflared | Stop-Process -Force' 'DarkGray'
  Say ''
}
finally {
  if ($__origCP -and $__origCP -ne 65001) {
    try { chcp $__origCP > $null } catch { }
  }
}
