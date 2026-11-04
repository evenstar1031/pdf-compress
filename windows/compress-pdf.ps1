<#
  PDF 압축 (윈도우용) — 설치된 Ghostscript로 여러 PDF를 한 번에 압축합니다.

  쓰는 법
    · PDF-Compress.bat 위로 PDF 파일들이나 폴더를 끌어다 놓기
    · 또는 PDF-Compress.bat 더블클릭 → 파일 고르기 창에서 여러 개 선택

  결과
    · 원본과 같은 폴더에 "이름_압축.pdf"로 저장 (원본은 건드리지 않음)
    · 압축해도 거의 안 줄어드는 파일은 새로 만들지 않고 건너뜀

  고급 (명령줄)
    powershell -File compress-pdf.ps1 [-Level extreme|recommended|low] [-KeepName] [-OutDir 폴더] [-NoPause] 파일또는폴더...
      -KeepName : 이름을 그대로 두고, 원본 옆 "압축됨" 폴더(또는 -OutDir)에 저장
#>
[CmdletBinding(PositionalBinding = $false)]
param(
  [ValidateSet('extreme', 'recommended', 'low', '')][string]$Level = '',
  [switch]$KeepName,
  [string]$OutDir = '',
  [switch]$NoPause,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Paths
)

$onWindows = ($PSVersionTable.PSEdition -eq 'Desktop') -or $IsWindows
$SUFFIX = '_압축'
$KEEP_DIR = '압축됨'

# iLovePDF 3단계와 같은 개념 (웹 버전과 같은 설정)
$PRESETS = @{ extreme = '/screen'; recommended = '/ebook'; low = '/printer' }
$LABELS  = @{ extreme = '강하게'; recommended = '권장'; low = '약하게' }
# 프리셋(-dPDFSETTINGS)을 먼저 주고, 그 뒤에 세부 옵션을 덧씌움
$GS_COMMON = @(
  '-dCompatibilityLevel=1.5',
  '-dNOPAUSE', '-dBATCH', '-dSAFER',
  '-dAutoRotatePages=/None', '-dDetectDuplicateImages=true',
  '-dCompressFonts=true', '-dSubsetFonts=true',
  '-dColorImageDownsampleType=/Bicubic', '-dGrayImageDownsampleType=/Bicubic'
)

function Format-Size([double]$b) {
  if ($b -ge 1GB) { return '{0:N2} GB' -f ($b / 1GB) }
  if ($b -ge 1MB) { return '{0:N1} MB' -f ($b / 1MB) }
  if ($b -ge 1KB) { return '{0:N0} KB' -f ($b / 1KB) }
  return "$b B"
}

function Wait-Exit([int]$code = 0) {
  if (-not $NoPause) { Write-Host ''; [void](Read-Host 'Enter를 누르면 창이 닫혀요') }
  exit $code
}

function Find-Ghostscript {
  if ($env:GS_EXE -and (Test-Path -LiteralPath $env:GS_EXE)) { return $env:GS_EXE }
  $names = if ($onWindows) { @('gswin64c', 'gswin32c') } else { @('gs') }
  foreach ($n in $names) {
    $c = Get-Command $n -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) { return $c.Source }
  }
  if (-not $onWindows) { return $null }
  # 기본 설치 위치: C:\Program Files\gs\gs10.xx.x\bin\gswin64c.exe — 여러 버전이 있으면 최신으로
  $found = foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
    if (-not $root) { continue }
    Get-ChildItem -LiteralPath (Join-Path $root 'gs') -Directory -ErrorAction SilentlyContinue | ForEach-Object {
      Get-ChildItem -LiteralPath (Join-Path $_.FullName 'bin') -Filter 'gswin*c.exe' -ErrorAction SilentlyContinue
    }
  }
  $best = $found | Sort-Object -Descending -Property @{ Expression = {
      try { [version](($_.Directory.Parent.Name -replace '^gs', '') -replace '[^\d\.]', '') } catch { [version]'0.0' } } },
    @{ Expression = { $_.Name -eq 'gswin64c.exe' } } | Select-Object -First 1
  if ($best) { return $best.FullName }
  return $null
}

# Ghostscript 작업 폴더: 한글/긴 경로 문제를 피하려고 영문 경로를 고름 (윈도우 사용자 이름이 한글이어도 OK)
function Get-WorkDir {
  $candidates = @([IO.Path]::GetTempPath())
  if ($env:PUBLIC) { $candidates += $env:PUBLIC }
  $root = $candidates | Where-Object { $_ -and ($_ -cmatch '^[\x20-\x7E]+$') -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
  if (-not $root) { $root = [IO.Path]::GetTempPath() }
  $dir = Join-Path $root ('pdfc_' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  return $dir
}

# ---------------------------------------------------------------------------
Write-Host ''
Write-Host '  PDF 압축  (Ghostscript)' -ForegroundColor Cyan
Write-Host '  ───────────────────────'

$gs = Find-Ghostscript
if (-not $gs) {
  Write-Host ''
  Write-Host 'Ghostscript가 설치돼 있지 않아요. (처음 한 번만 설치하면 돼요)' -ForegroundColor Yellow
  Write-Host '  1) 지금 열리는 페이지에서 "Ghostscript AGPL Release" 줄의 64 bit Windows 설치 파일을 받기'
  Write-Host '  2) 받은 파일 실행 → 기본 설정 그대로 Next / Install'
  Write-Host '  3) 설치가 끝나면 이 창을 닫고 다시 실행'
  if ($onWindows) { Start-Process 'https://ghostscript.com/releases/gsdnld.html' }
  Wait-Exit 1
}

# 아무것도 안 끌어다 놓고 더블클릭했으면 파일 고르기 창
if ((-not $Paths -or $Paths.Count -eq 0) -and $onWindows) {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    $owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }
    $dlg = New-Object System.Windows.Forms.OpenFileDialog
    $dlg.Title = '압축할 PDF 고르기 (Ctrl/Shift로 여러 개 선택)'
    $dlg.Filter = 'PDF 파일 (*.pdf)|*.pdf'
    $dlg.Multiselect = $true
    if ($dlg.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $Paths = $dlg.FileNames }
    $owner.Dispose()
  } catch { }
}
if (-not $Paths -or $Paths.Count -eq 0) {
  Write-Host '압축할 PDF가 없어요. PDF 파일이나 폴더를 PDF-Compress.bat 위로 끌어다 놓아 주세요.' -ForegroundColor Yellow
  Wait-Exit 1
}

# 파일 모으기 (폴더는 안쪽까지, 이미 압축된 결과물은 제외)
$files = New-Object System.Collections.Generic.List[System.IO.FileInfo]
$seen = @{}
foreach ($p in $Paths) {
  if (-not $p) { continue }
  $p = $p.Trim().Trim('"')
  if (Test-Path -LiteralPath $p -PathType Container) {
    $inDir = Get-ChildItem -LiteralPath $p -Recurse -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Extension -ieq '.pdf' -and $_.BaseName -notmatch "$SUFFIX`$" -and $_.Directory.Name -ne $KEEP_DIR } |
      Sort-Object FullName
    foreach ($fi in $inDir) { if (-not $seen[$fi.FullName]) { $seen[$fi.FullName] = $true; $files.Add($fi) } }
  } elseif (Test-Path -LiteralPath $p -PathType Leaf) {
    $fi = Get-Item -LiteralPath $p
    if ($fi.Extension -ieq '.pdf') { if (-not $seen[$fi.FullName]) { $seen[$fi.FullName] = $true; $files.Add($fi) } }
    else { Write-Host "  건너뜀 (PDF 아님): $($fi.Name)" -ForegroundColor DarkGray }
  } else {
    Write-Host "  찾을 수 없음: $p" -ForegroundColor DarkGray
  }
}
if ($files.Count -eq 0) { Write-Host 'PDF 파일을 찾지 못했어요.' -ForegroundColor Yellow; Wait-Exit 1 }

$totalIn = ($files | Measure-Object -Property Length -Sum).Sum
Write-Host ("  PDF {0}개 · 합계 {1}" -f $files.Count, (Format-Size $totalIn))

if (-not $Level) {
  Write-Host ''
  Write-Host '  압축 수준을 고르세요'
  Write-Host '    1  강하게   이미지 72dpi  · 가장 작게, 사진은 흐려질 수 있음'
  Write-Host '    2  권장     이미지 150dpi · 화면으로 보기 충분      ← 그냥 Enter'
  Write-Host '    3  약하게   이미지 300dpi · 인쇄용, 덜 줄어듦'
  $ans = "$(Read-Host '  번호')".Trim()
  switch ($ans) { '1' { $Level = 'extreme' } '3' { $Level = 'low' } default { $Level = 'recommended' } }
}
Write-Host ("  → {0}" -f $LABELS[$Level]) -ForegroundColor Cyan
Write-Host ''

$work = Get-WorkDir
$tin = Join-Path $work 'in.pdf'
$tout = Join-Path $work 'out.pdf'
$stats = @{ done = 0; kept = 0; fail = 0; inDone = 0L; outDone = 0L }
$i = 0
$allTimer = [Diagnostics.Stopwatch]::StartNew()

try {
  foreach ($f in $files) {
    $i++
    $name = $f.Name.Normalize([Text.NormalizationForm]::FormC)   # 아이패드에서 온 분리된 한글 이름 정리
    $base = [IO.Path]::GetFileNameWithoutExtension($name)
    if ($KeepName) {
      $destDir = if ($OutDir) { $OutDir } else { Join-Path $f.DirectoryName $KEEP_DIR }
      $destName = "$base.pdf"
    } else {
      $destDir = if ($OutDir) { $OutDir } else { $f.DirectoryName }
      $destName = "$base$SUFFIX.pdf"
    }
    $dest = Join-Path $destDir $destName
    $tag = "[$i/$($files.Count)]"
    Write-Host ("{0} {1}  {2}" -f $tag, $name, (Format-Size $f.Length)) -NoNewline

    Copy-Item -LiteralPath $f.FullName -Destination $tin -Force
    if (Test-Path -LiteralPath $tout) { Remove-Item -LiteralPath $tout -Force }

    $log = New-Object System.Collections.Generic.List[string]
    $script:pageTotal = 0
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $gsArgs = @('-sDEVICE=pdfwrite', "-dPDFSETTINGS=$($PRESETS[$Level])") + $GS_COMMON + @("-sOutputFile=$tout", $tin)
    & $gs @gsArgs 2>&1 | ForEach-Object {
      $line = "$_"
      $log.Add($line)
      if ($line -match '^Processing pages \d+ through (\d+)') { $script:pageTotal = [int]$Matches[1] }
      elseif ($line -match '^Page (\d+)$' -and $script:pageTotal -gt 0) {
        $pg = [int]$Matches[1]
        Write-Progress -Activity "$tag $name" -Status "$pg / $($script:pageTotal) 쪽" -PercentComplete ([math]::Min(100, [int](100 * $pg / $script:pageTotal)))
      }
    }
    $rc = $LASTEXITCODE
    Write-Progress -Activity "$tag $name" -Completed
    $secs = '{0:N1}초' -f $timer.Elapsed.TotalSeconds
    $text = $log -join "`n"

    if ($text -match 'requires a password|password did not work') {
      $stats.fail++
      Write-Host '  → 실패: 암호가 걸린 PDF예요 (암호를 풀고 다시)' -ForegroundColor Red
    } elseif ($rc -ne 0 -or -not (Test-Path -LiteralPath $tout) -or $text -match "No pages will be processed|Couldn't initialise file") {
      $stats.fail++
      Write-Host '  → 실패: 처리하지 못했어요 (손상된 파일일 수 있어요)' -ForegroundColor Red
      $last = ($log | Where-Object { $_ -match '\S' } | Select-Object -Last 3) -join ' / '
      if ($last) { Write-Host "      $last" -ForegroundColor DarkGray }
    } else {
      $outSize = (Get-Item -LiteralPath $tout).Length
      if ($outSize -ge $f.Length * 0.99) {
        $stats.kept++
        Write-Host '  → 이미 최적화돼 있어 건너뜀 (원본 그대로)' -ForegroundColor DarkYellow
      } else {
        if (-not (Test-Path -LiteralPath $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
        Move-Item -LiteralPath $tout -Destination $dest -Force
        $stats.done++; $stats.inDone += $f.Length; $stats.outDone += $outSize
        $pct = [math]::Round(100 * (1 - $outSize / $f.Length))
        Write-Host ("  → {0}  (-{1}%)  {2}" -f (Format-Size $outSize), $pct, $secs) -ForegroundColor Green
        if ($text -match 'Output may be incorrect') {
          Write-Host '      주의: 원본 PDF에 오류가 있었어요. 결과 파일을 한 번 열어서 확인해 주세요.' -ForegroundColor Yellow
        }
      }
    }
    Remove-Item -LiteralPath $tin -Force -ErrorAction SilentlyContinue
  }
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host '  ───────────────────────'
$summary = "  완료 $($stats.done)개"
if ($stats.kept) { $summary += " · 건너뜀 $($stats.kept)개" }
if ($stats.fail) { $summary += " · 실패 $($stats.fail)개" }
Write-Host $summary
if ($stats.done) {
  $pct = [math]::Round(100 * (1 - $stats.outDone / $stats.inDone))
  Write-Host ("  {0} → {1}  (-{2}%)  ·  총 {3:N0}초" -f (Format-Size $stats.inDone), (Format-Size $stats.outDone), $pct, $allTimer.Elapsed.TotalSeconds) -ForegroundColor Green
  if ($OutDir) { Write-Host "  결과: $OutDir" }
  elseif ($KeepName) { Write-Host "  결과: 각 원본 옆 '$KEEP_DIR' 폴더 (이름은 그대로)" }
  else { Write-Host "  결과: 원본과 같은 폴더에 '…$SUFFIX.pdf'" }
}
Wait-Exit ([int]($stats.fail -gt 0))
