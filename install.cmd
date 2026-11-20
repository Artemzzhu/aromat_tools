@echo off
setlocal
pushd "%~dp0" || exit /b 1

where node.exe >nul 2>&1
if errorlevel 1 (
  echo Install Node.js LTS, then reopen install.cmd.
  goto :failed
)
where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo npm was not found. Reinstall Node.js LTS with npm.
  goto :failed
)

call npm ci --include=dev
if errorlevel 1 goto :failed
node node_modules\electron\install.js
if errorlevel 1 goto :failed

set "AROMAT_TOOLS_INSTALL_DIR=%CD%"
powershell.exe -NoProfile -NonInteractive -Command ^
  "$ErrorActionPreference = 'Stop';" ^
  "$root = $env:AROMAT_TOOLS_INSTALL_DIR;" ^
  "$exe = Join-Path $root 'node_modules\electron\dist\electron.exe';" ^
  "$icon = Join-Path $root 'assets\aromat-mark.ico';" ^
  "if (!(Test-Path -LiteralPath $exe -PathType Leaf) -or !(Test-Path -LiteralPath $icon -PathType Leaf)) { throw 'Electron or the application icon was not found.' }" ^
  "$desktop = [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory);" ^
  "if (!$desktop) { throw 'The current user desktop folder was not found.' }" ^
  "$shell = New-Object -ComObject WScript.Shell;" ^
  "$shortcut = $shell.CreateShortcut((Join-Path $desktop 'Aromat Tools.lnk'));" ^
  "$shortcut.TargetPath = $exe;" ^
  "$shortcut.Arguments = '.';" ^
  "$shortcut.WorkingDirectory = $root;" ^
  "$shortcut.IconLocation = $icon + ',0';" ^
  "$shortcut.Description = 'Aromat Tools';" ^
  "$shortcut.Save();"
if errorlevel 1 goto :failed
echo Aromat Tools is installed. Open the Aromat Tools shortcut on your desktop.
popd
exit /b 0

:failed
echo Installation failed. Close Aromat Tools if it is running, then try again.
pause
popd
exit /b 1
