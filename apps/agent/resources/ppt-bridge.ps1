# Slide Relay Agent — PowerPoint bridge for Windows.
#
# Runs as one long-lived Windows PowerShell 5.1 process. Reads one JSON request
# per line on stdin and writes one JSON response per line on stdout:
#   {"id":"1","op":"status"}  ->  {"id":"1","ok":true,"data":{...}}
# Talks to the PowerPoint that is already running (it never starts PowerPoint).

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms

$RPC_E_CALL_REJECTED = -2147418111        # 0x80010001: PowerPoint is busy
$RPC_E_SERVERCALL_RETRYLATER = -2147417846 # 0x8001010A

function Invoke-Retry([scriptblock]$Block) {
  for ($i = 0; $i -lt 10; $i++) {
    try {
      return & $Block
    } catch [System.Runtime.InteropServices.COMException] {
      $code = $_.Exception.HResult
      if ($code -eq $RPC_E_CALL_REJECTED -or $code -eq $RPC_E_SERVERCALL_RETRYLATER) {
        Start-Sleep -Milliseconds 60
        continue
      }
      throw
    }
  }
  return & $Block
}

function Get-PowerPoint {
  try { return [System.Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application') } catch { return $null }
}

function Get-ShowWindow($app) {
  if ($null -eq $app) { return $null }
  if ($app.SlideShowWindows.Count -gt 0) { return $app.SlideShowWindows.Item(1) }
  return $null
}

function Get-Presentation($app) {
  $w = Get-ShowWindow $app
  if ($null -ne $w) { return $w.Presentation }
  if ($app.Presentations.Count -eq 0) { return $null }
  try { return $app.ActivePresentation } catch { return $app.Presentations.Item(1) }
}

function Get-ClickBuilds($slide) {
  $count = 0
  try {
    foreach ($effect in $slide.TimeLine.MainSequence) {
      # msoAnimTriggerOnPageClick = 1; "with/after previous" effects are not clicks
      if ($effect.Timing.TriggerType -eq 1) { $count++ }
    }
  } catch { }
  return $count
}

function Get-Status {
  $app = Get-PowerPoint
  if ($null -eq $app) { return @{ running = $false; open = $false; inShow = $false } }
  $r = @{ running = $true; open = $false; inShow = $false; blank = $false; ended = $false }
  $p = Get-Presentation $app
  if ($null -eq $p) { return $r }
  $r.open = $true
  $r.slideCount = $p.Slides.Count
  $r.fileName = $p.Name
  $r.fullName = $p.FullName
  $r.slideW = $p.PageSetup.SlideWidth
  $r.slideH = $p.PageSetup.SlideHeight
  $w = Get-ShowWindow $app
  if ($null -ne $w) {
    $v = $w.View
    $r.inShow = $true
    $state = $v.State
    # ppSlideShowBlackScreen = 3, ppSlideShowWhiteScreen = 4, ppSlideShowDone = 5
    $r.blank = ($state -eq 3 -or $state -eq 4)
    $r.ended = ($state -eq 5)
    try { $r.slide = $v.Slide.SlideIndex } catch { $r.slide = $null }
    try {
      $r.click = $v.GetClickIndex()
      $r.clickCount = $v.GetClickCount()
    } catch { }
  }
  return $r
}

function Require-View {
  $w = Get-ShowWindow (Get-PowerPoint)
  if ($null -eq $w) { throw 'No slideshow is running' }
  return $w.View
}

function Start-Show([int]$From) {
  $app = Get-PowerPoint
  if ($null -eq $app) { throw 'PowerPoint is not running' }
  $p = Get-Presentation $app
  if ($null -eq $p) { throw 'No presentation is open' }
  $w = Get-ShowWindow $app
  if ($null -eq $w) { $w = $p.SlideShowSettings.Run() }
  if ($From -gt 1) { $w.View.GotoSlide($From) }
  return @{}
}

function Get-BuildCounts {
  $p = Get-Presentation (Get-PowerPoint)
  if ($null -eq $p) { return @{ counts = @() } }
  $counts = @()
  foreach ($s in $p.Slides) { $counts += (Get-ClickBuilds $s) }
  return @{ counts = $counts }
}

function Export-Deck([string]$Dir, [int]$Width) {
  $p = Get-Presentation (Get-PowerPoint)
  if ($null -eq $p) { throw 'No presentation is open' }
  if ($Width -lt 320) { $Width = 1280 }
  $height = [int][Math]::Round($Width * $p.PageSetup.SlideHeight / $p.PageSetup.SlideWidth)
  $out = @()
  $i = 0
  foreach ($s in $p.Slides) {
    $i++
    $file = Join-Path $Dir ('{0}.png' -f $i)
    Invoke-Retry { $s.Export($file, 'PNG', $Width, $height) } | Out-Null
    $title = $null
    try { if ($s.Shapes.HasTitle) { $title = $s.Shapes.Title.TextFrame.TextRange.Text } } catch { }
    $notes = $null
    try {
      foreach ($shape in $s.NotesPage.Shapes) {
        # msoPlaceholder = 14, ppPlaceholderBody = 2
        if ($shape.Type -eq 14 -and $shape.PlaceholderFormat.Type -eq 2 -and $shape.HasTextFrame) {
          $notes = $shape.TextFrame.TextRange.Text
        }
      }
    } catch { }
    $hidden = $false
    try { $hidden = ($s.SlideShowTransition.Hidden -ne 0) } catch { }
    $out += @{ n = $i; image = $file; title = $title; notes = $notes; hidden = $hidden; builds = (Get-ClickBuilds $s) }
  }
  return @{ slides = $out }
}

function Send-Keys([string]$Keys) {
  [System.Windows.Forms.SendKeys]::SendWait($Keys)
  return @{}
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim().Length -eq 0) { continue }
  $id = $null
  try {
    $req = ConvertFrom-Json $line
    $id = $req.id
    $a = $req.args
    switch ($req.op) {
      'status'   { $data = Invoke-Retry { Get-Status } }
      'next'     { Invoke-Retry { (Require-View).Next() } | Out-Null; $data = @{} }
      'previous' { Invoke-Retry { (Require-View).Previous() } | Out-Null; $data = @{} }
      'goto'     { Invoke-Retry { (Require-View).GotoSlide([int]$a.slide) } | Out-Null; $data = @{} }
      'blank'    {
        $v = Require-View
        if ($a.on) { Invoke-Retry { $v.State = 3 } | Out-Null } else { Invoke-Retry { $v.State = 1 } | Out-Null }
        $data = @{}
      }
      'start'    { $data = Invoke-Retry { Start-Show ([int]$a.from) } }
      'builds'   { $data = Invoke-Retry { Get-BuildCounts } }
      'export'   { $data = Export-Deck ([string]$a.dir) ([int]$a.width) }
      'keys'     { $data = Send-Keys ([string]$a.keys) }
      'ping'     { $data = @{ pong = $true } }
      default    { throw ('Unknown op: ' + $req.op) }
    }
    $res = @{ id = $id; ok = $true; data = $data }
  } catch {
    $res = @{ id = $id; ok = $false; error = $_.Exception.Message }
  }
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $res -Compress -Depth 6))
  [Console]::Out.Flush()
}
