# dsh-android-control 卸载脚本
#
# 从 desktop profile 里移除插件。默认路径是 $DSH_HOME/profiles/desktop，
# 可用 -Profile 指定别的 profile。
#
# 用法:
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1 -Profile web

param(
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }),
  [string]$Profile = 'desktop',
  [string]$Package = 'dsh-android-control'
)

$prof = Join-Path $DshHome "profiles\$Profile"
$pkgJson = Join-Path $prof 'package.json'

if (-not (Test-Path $pkgJson)) {
  Write-Host "找不到 profile: $prof" -ForegroundColor Red
  exit 1
}

Write-Host "1) 从 bundles 移除 $Package"
$j = Get-Content $pkgJson -Raw -Encoding UTF8 | ConvertFrom-Json
$before = $j.dsh.profile.bundles.Count
$j.dsh.profile.bundles = @($j.dsh.profile.bundles | Where-Object { $_ -ne $Package })
$after = $j.dsh.profile.bundles.Count
# 无 BOM 写回：JSON.parse 不容忍 BOM
[System.IO.File]::WriteAllText($pkgJson, ($j | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding($false)))
Write-Host "   bundles: $before -> $after"

Write-Host "2) 删除目录联接"
$link = Join-Path $prof "node_modules\$Package"
if (Test-Path $link) {
  cmd /c "rd `"$link`"" 2>&1 | Out-Null
  if (Test-Path $link) { Write-Host "   仍有残留: $link" } else { Write-Host "   已删除" }
} else {
  Write-Host "   不存在，跳过"
}

Write-Host ""
Write-Host "完成。重启 DSH 生效。" -ForegroundColor Green