# gen-installer-bitmaps.ps1 — 生成 NSIS 安装器品牌位图（应用 indigo 风格统一）
# 产物（git-tracked，生成一次提交，样式调整时重跑本脚本）：
#   assets/installer-welcome.bmp  164x314  Welcome/Finish 页左侧竖图
#   assets/installer-header.bmp   150x57   内页顶部右侧品牌图
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts/gen-installer-bitmaps.ps1

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$iconPath = Join-Path $root "assets\icon.png"
$icon = [System.Drawing.Image]::FromFile($iconPath)

$brand600 = [System.Drawing.Color]::FromArgb(0x4F, 0x46, 0xE5)  # #4f46e5
$brand800 = [System.Drawing.Color]::FromArgb(0x37, 0x30, 0xA3)  # #3730a3
$brand950 = [System.Drawing.Color]::FromArgb(0x1E, 0x1B, 0x4B)  # #1e1b4b

function Save-Bmp([System.Drawing.Bitmap]$bmp, [string]$name) {
  $out = Join-Path $root "assets\$name"
  # MUI 兼容：24 位 BMP
  $bmp24 = $bmp.Clone([System.Drawing.Rectangle]::FromLTRB(0, 0, $bmp.Width, $bmp.Height), [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $bmp24.Save($out, [System.Drawing.Imaging.ImageFormat]::Bmp)
  $bmp24.Dispose()
  $bmp.Dispose()
  Write-Host "已生成 $out"
}

# ── Welcome 竖图 164x314：indigo 垂直渐变 + 居中图标 + 底部产品名 ──
$w = 164; $h = 314
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, $brand600, $brand950, 90
$g.FillRectangle($brush, $rect)
$brush.Dispose()

# 居中图标 96x96（带柔和白色光晕底）
$iconSize = 96
$ix = [int](($w - $iconSize) / 2)
$iy = 78
$glowBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(40, 255, 255, 255))
$g.FillEllipse($glowBrush, $ix - 14, $iy - 14, $iconSize + 28, $iconSize + 28)
$glowBrush.Dispose()
$g.DrawImage($icon, $ix, $iy, $iconSize, $iconSize)

# 底部产品名
$font = [System.Drawing.Font]::new("Segoe UI", 13, [System.Drawing.FontStyle]::Bold)
$textBrush = [System.Drawing.Brushes]::White
$sf = New-Object System.Drawing.StringFormat
$sf.Alignment = [System.Drawing.StringAlignment]::Center
$g.DrawString("CryoClaw", $font, $textBrush, [float]($w / 2), 258.0, $sf)
$font2 = [System.Drawing.Font]::new("Segoe UI", 7.5)
$dimBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(200, 0xC7, 0xD2, 0xFE))
$g.DrawString("AI Agent Gateway", $font2, $dimBrush, [float]($w / 2), 282.0, $sf)
$g.Dispose()
Save-Bmp $bmp "installer-welcome.bmp"

# ── Header 图 150x57：浅底 + 右侧图标与产品名（MUI header 显示在页面右上）──
$w = 150; $h = 57
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::White)
$isize = 34
$g.DrawImage($icon, $w - $isize - 10, [int](($h - $isize) / 2), $isize, $isize)
$font = [System.Drawing.Font]::new("Segoe UI", 10, [System.Drawing.FontStyle]::Bold)
$textBrush = New-Object System.Drawing.SolidBrush $brand800
$g.DrawString("CryoClaw", $font, $textBrush, 10.0, 14.0)
$font2 = [System.Drawing.Font]::new("Segoe UI", 7)
$dimBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(0x52, 0x52, 0x5B))
$g.DrawString("Setup", $font2, $dimBrush, 11.0, 32.0)
$g.Dispose()
Save-Bmp $bmp "installer-header.bmp"

$icon.Dispose()
