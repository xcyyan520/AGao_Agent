# make_tts.ps1 —— 用 Windows 自带的语音合成生成测试音频
#
# 为什么需要它：.run\ui_check.mjs 的麦克风那一段要用一个 WAV 当「假麦克风输入」，
# 喂给无头 Chrome（--use-file-for-fake-audio-capture）。那段断言如果找不到 WAV
# 会直接报失败——这是故意的，静默跳过就成了假绿。
#
# 两个文件：
#   tts_test.wav —— 候选人说的话，用来验「浏览器采音 → 阿里云识别 → 文字上屏」
#   tts_q.wav    —— 面试官的问题，用来验「面试官那一路会开新问题、候选人记忆被清」
#
# 用法（在 07-同步思考 目录下）：
#   .\\.run\\make_tts.ps1
#
# 只依赖 Windows 自带的 SAPI，不用装 ffmpeg、不用联网。

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)

$voice = New-Object -ComObject SAPI.SpVoice
# 优先挑中文声音。系统没装中文声音时 SpVoice 会退回默认英文声音，
# 念中文会变成一串拼音或者干脆不响——那时候生成的 WAV 是废的，测出来会误判。
#
# ⚠️ 这里刻意用索引循环而不是 `$voices | Where-Object {...}` 再 `$zh[0]`：
#    SAPI 返回的是 COM 集合，过滤后只有一个元素时 PowerShell 会把它拆成单个
#    __ComObject（不是数组），此时 `$zh[0]` 会去对 COM 对象做 PROPERTYGET
#    DISPID 0，报 "Error while invoking [PROPERTYGET, DISPID(0)]"。
#    老老实实按下标取就没这个坑。
$voices = $voice.GetVoices()
$zhIdx = -1
for ($i = 0; $i -lt $voices.Count; $i++) {
  if ($voices.Item($i).GetDescription() -match 'Chinese|中文|Huihui|Yaoyao|Kangkang') { $zhIdx = $i; break }
}
if ($zhIdx -ge 0) {
  $voice.Voice = $voices.Item($zhIdx)
  Write-Host ("声音：" + $voice.Voice.GetDescription()) -ForegroundColor Cyan
} else {
  Write-Host '⚠️ 没找到中文声音，生成的音频可能念不出中文。' -ForegroundColor Yellow
  Write-Host '   Windows 设置 → 时间和语言 → 语音 → 添加语音，装一个中文的。'
}

# 22.05kHz / 16bit / 单声道。SAPI 默认就是这个，
# 浏览器侧会再降采样到 16kHz 给阿里云，不用在这里操心。
function Save-Wav([string]$text, [string]$path) {
  $stream = New-Object -ComObject SAPI.SpFileStream
  $stream.Format.Type = 22          # SAFT22kHz16BitMono
  $stream.Open($path, 3, $false)    # 3 = SSFMCreateForWrite
  $voice.AudioOutputStream = $stream
  $voice.Speak($text, 0) | Out-Null
  $stream.Close()
  $size = (Get-Item $path).Length
  Write-Host ("  → " + $path + "  " + $size + " 字节") -ForegroundColor Green
}

Save-Wav '是 LangGraph，把 Agent 模成状态机，支持循环和断点恢复。' '.run\tts_test.wav'
Save-Wav '那你们这个状态是怎么持久化的？多副本部署的时候，怎么保证不串台？' '.run\tts_q.wav'

Write-Host ''
Write-Host '生成完毕。现在可以跑：' -ForegroundColor Cyan
Write-Host '  node .run\ui_check.mjs                    # 界面 + 麦克风全量'
Write-Host '  node .run\probe_asr_e2e.mjs candidate .run\tts_test.wav   # 只验 ASR 链路'
