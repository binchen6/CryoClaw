# gen-installer-bitmaps.ps1 — 生成 NSIS 安装器品牌位图（应用沉稳蓝风格统一）
# 产物（git-tracked，生成一次提交，样式调整时重跑本脚本）：
#   assets/installer-welcome.bmp  164x314  Welcome/Finish 页左侧竖图
#   assets/installer-header.bmp   150x57   内页顶部右侧品牌图
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts/gen-installer-bitmaps.ps1
#
# 设计（v2，2026-09-07 安装器 UI 重构）：
#   - Welcome：对角三段式沉稳蓝渐变 + 三层冰晶几何装饰（半透明圆/环）+
#     双层光晕图标 + 居中字标 + 细分隔线 + 英文 tagline（安装器语言跟随系统，文案保持中性）
#   - Header：白底 + 左侧品牌竖条 + 图标 + 字标 + "Setup" 副标 + 底部浅色分隔线

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$iconPath = Join-Path $root "assets\icon.png"
$icon = [System.Drawing.Image]::FromFile($iconPath)

$brand500 = [System.Drawing.Color]::FromArgb(0x2A, 0x89, 0xDD)  # #2a89dd 品牌主色
$brand600 = [System.Drawing.Color]::FromArgb(0x1A, 0x6F, 0xD0)  # #1a6fd0
$brand800 = [System.Drawing.Color]::FromArgb(0x16, 0x4A, 0x90)  # #164a90
$brand950 = [System.Drawing.Color]::FromArgb(0x0F, 0x2A, 0x4E)  # #0f2a4e

function Save-Bmp([System.Drawing.Bitmap]$bmp, [string]$name) {
  $out = Join-Path $root "assets\$name"
  # MUI 兼容：24 位 BMP
  $bmp24 = $bmp.Clone([System.Drawing.Rectangle]::FromLTRB(0, 0, $bmp.Width, $bmp.Height), [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $bmp24.Save($out, [System.Drawing.Imaging.ImageFormat]::Bmp)
  $bmp24.Dispose()
  $bmp.Dispose()
  Write-Host "已生成 $out"
}

# ── Welcome 竖图 164x314 ──
$w = 164; $h = 314
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

# 对角渐变（左上 brand600 → 右下 brand950，经 brand800 过渡）
$rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, $brand600, $brand950, 55
$cblend = New-Object System.Drawing.Drawing2D.ColorBlend
$cblend.Colors = @($brand600, $brand800, $brand950)
$cblend.Positions = @(0.0, 0.55, 1.0)
$brush.InterpolationColors = $cblend
$g.FillRectangle($brush, $rect)
$brush.Dispose()

# 冰晶几何装饰：右上大半透明圆 + 两个同心环 + 左下小圆（营造冰面反光层次）
$deco = @(
  @{ x = 96;  y = -58;  d = 170; a = 18 },
  @{ x = 116; y = -38;  d = 130; a = 14 },
  @{ x = -44; y = 236;  d = 132; a = 12 },
  @{ x = -28; y = 252;  d = 100; a = 10 }
)
foreach ($c in $deco) {
  $b = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb($c.a, 255, 255, 255))
  $g.FillEllipse($b, [int]$c.x, [int]$c.y, [int]$c.d, [int]$c.d)
  $b.Dispose()
}
# 细环（冰裂纹意象）：圆心同右上装饰，线宽 1
$ringPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(36, 255, 255, 255)), 1
$g.DrawEllipse($ringPen, 88, -66, 186, 186)
$g.DrawEllipse($ringPen, -52, 228, 148, 148)
$ringPen.Dispose()

# 顶部小标 "SETUP"（字距加宽通过手动逐字符绘制模拟）
$labelFont = [System.Drawing.Font]::new("Segoe UI", 6.5, [System.Drawing.FontStyle]::Bold)
$labelBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(170, 255, 255, 255))
$g.DrawString("S E T U P", $labelFont, $labelBrush, [float]($w / 2), 20.0, (New-Object System.Drawing.StringFormat -Property @{ Alignment = [System.Drawing.StringAlignment]::Center }))
$labelFont.Dispose()
$labelBrush.Dispose()

# 居中图标 100x100（双层光晕：外圈大而淡、内圈小而亮）
$iconSize = 100
$ix = [int](($w - $iconSize) / 2)
$iy = 74
$glowOuter = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(26, 255, 255, 255))
$g.FillEllipse($glowOuter, $ix - 20, $iy - 20, $iconSize + 40, $iconSize + 40)
$glowOuter.Dispose()
$glowInner = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(46, 255, 255, 255))
$g.FillEllipse($glowInner, $ix - 8, $iy - 8, $iconSize + 16, $iconSize + 16)
$glowInner.Dispose()
$g.DrawImage($icon, $ix, $iy, $iconSize, $iconSize)

# 字标 + 细分隔线 + tagline
$nameFont = [System.Drawing.Font]::new("Segoe UI", 14, [System.Drawing.FontStyle]::Bold)
$nameBrush = [System.Drawing.Brushes]::White
$center = New-Object System.Drawing.StringFormat
$center.Alignment = [System.Drawing.StringAlignment]::Center
$g.DrawString("CryoClaw", $nameFont, $nameBrush, [float]($w / 2), 212.0, $center)
$nameFont.Dispose()

$dividerPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(120, 191, 219, 254)), 2
$g.DrawLine($dividerPen, [int]($w / 2 - 22), 246, [int]($w / 2 + 22), 246)
$dividerPen.Dispose()

$tagFont = [System.Drawing.Font]::new("Segoe UI", 7.5)
$tagBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(210, 0xBF, 0xDB, 0xFE))
$g.DrawString("AI Agent Gateway", $tagFont, $tagBrush, [float]($w / 2), 254.0, $center)
$tagFont.Dispose()
$tagBrush.Dispose()

$g.Dispose()
Save-Bmp $bmp "installer-welcome.bmp"

# ── Header 图 150x57：白底 + 左侧品牌竖条 + 图标 + 字标 + "Setup" 副标 ──
$w = 150; $h = 57
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::White)

# 左侧品牌竖条 4px（品牌主色 → brand800 竖向渐变）
$barRect = New-Object System.Drawing.Rectangle 0, 0, 4, $h
$barBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $barRect, $brand500, $brand800, 90
$g.FillRectangle($barBrush, $barRect)
$barBrush.Dispose()

$isize = 34
$g.DrawImage($icon, $w - $isize - 10, [int](($h - $isize) / 2), $isize, $isize)
$nameFont = [System.Drawing.Font]::new("Segoe UI", 10, [System.Drawing.FontStyle]::Bold)
$nameBrush = New-Object System.Drawing.SolidBrush $brand800
$g.DrawString("CryoClaw", $nameFont, $nameBrush, 12.0, 13.0)
$nameFont.Dispose()
$nameBrush.Dispose()
$subFont = [System.Drawing.Font]::new("Segoe UI", 7)
$subBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(0x52, 0x52, 0x5B))
$g.DrawString("Setup", $subFont, $subBrush, 13.0, 31.0)
$subFont.Dispose()
$subBrush.Dispose()

# 底部 1px 浅色分隔线（与 MUI 页面内容区分层）
$linePen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(230, 0xE2, 0xE8, 0xF0)), 1
$g.DrawLine($linePen, 0, $h - 1, $w, $h - 1)
$linePen.Dispose()
$g.Dispose()
Save-Bmp $bmp "installer-header.bmp"

$icon.Dispose()
