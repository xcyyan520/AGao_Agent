# fixbom.ps1 -- make sure every .ps1 in this folder starts with a UTF-8 BOM.
#
# WHY THIS EXISTS
#   These scripts contain Chinese text. Windows PowerShell 5.1 (the one that
#   runs when a human double-clicks a .ps1) detects encoding by BOM only.
#   Without a BOM it assumes the system code page (936 / GBK) and decodes the
#   UTF-8 bytes as pairs. Some Chinese characters then swallow the next byte,
#   which shows up as this completely misleading error:
#
#       Missing closing '}' in statement block or type definition.
#       The Try statement is missing its Catch or Finally block.
#
#   The parens are fine. Only the encoding is wrong. Cost us two debugging
#   rounds before we wrote this file down.
#
# WHY IT IS PURE ASCII
#   So it can repair itself. A tool that needs a BOM to run cannot repair a
#   missing BOM in its own folder.
#
# USAGE
#   .\tools\fixbom.ps1           # check and fix everything in the repo root
#   .\tools\fixbom.ps1 -Check    # report only, change nothing (exit 1 if bad)
#
# Run this after ANY edit to a .ps1 file: most editors and patch tools write
# UTF-8 without BOM by default.

param(
    [switch]$Check,
    [string]$Root = ''
)

$ErrorActionPreference = 'Stop'

if (-not $Root) {
    # default: the folder one level up from tools\
    $Root = Split-Path -Parent $PSScriptRoot
    if (-not $Root) { $Root = (Get-Location).Path }
}

$files = @(Get-ChildItem -Path $Root -Filter '*.ps1' -File -ErrorAction SilentlyContinue)
$tools = @(Get-ChildItem -Path (Join-Path $Root 'tools') -Filter '*.ps1' -File -ErrorAction SilentlyContinue)
$all = @($files + $tools) | Sort-Object FullName -Unique

if (-not $all.Count) {
    Write-Host "  no .ps1 files under $Root"
    exit 0
}

$utf8Bom = [System.Text.UTF8Encoding]::new($true)
$utf8Raw = [System.Text.UTF8Encoding]::new($false)
$bad = 0

foreach ($f in $all) {
    $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
    $ok = ($bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191)

    if ($ok) {
        Write-Host ("  [ok]    " + $f.Name)
        continue
    }

    $bad++
    if ($Check) {
        Write-Host ("  [NOBOM] " + $f.Name + "  <-- 5.1 will mis-parse this")
        continue
    }

    # Decode as UTF-8 (no BOM) then write back as UTF-8 *with* BOM.
    # If the file is not valid UTF-8 this throws, and that is the right
    # outcome: silently rewriting a GBK file as UTF-8 would corrupt it.
    $text = [System.IO.File]::ReadAllText($f.FullName, $utf8Raw)
    [System.IO.File]::WriteAllText($f.FullName, $text, $utf8Bom)
    $after = [System.IO.File]::ReadAllBytes($f.FullName)
    if ($after[0] -eq 239 -and $after[1] -eq 187 -and $after[2] -eq 191) {
        Write-Host ("  [fixed] " + $f.Name)
    } else {
        Write-Host ("  [FAILED] " + $f.Name)
    }
}

if ($bad -and $Check) {
    Write-Host ""
    Write-Host "  $bad file(s) missing BOM. Run without -Check to fix."
    exit 1
}
if (-not $bad) {
    Write-Host ""
    Write-Host "  all .ps1 files carry a UTF-8 BOM"
}
exit 0
