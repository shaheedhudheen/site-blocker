Add-Type -AssemblyName System.Drawing
$outDir = Join-Path $PSScriptRoot "..\extension\icons"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function New-BanIcon {
    param([int]$Size)
    $bmp = New-Object System.Drawing.Bitmap($Size, $Size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $red = [System.Drawing.Color]::FromArgb(255, 229, 72, 77)
    $penW = [Math]::Max(2.0, [Math]::Round($Size * 0.135))
    $pen = New-Object System.Drawing.Pen($red, $penW)
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pad = $penW / 2 + [Math]::Max(0.5, $Size * 0.02)
    $g.DrawEllipse($pen, $pad, $pad, $Size - 2 * $pad, $Size - 2 * $pad)
    $c = $Size / 2.0
    $r = $c - $pad
    $o = $r * 0.7071
    $g.DrawLine($pen, $c - $o, $c + $o, $c + $o, $c - $o)
    $g.Dispose()
    $pen.Dispose()
    $path = Join-Path $outDir ("icon{0}.png" -f $Size)
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "wrote $path"
}

foreach ($s in 16, 32, 48, 128) { New-BanIcon -Size $s }
