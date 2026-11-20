@echo off
setlocal
pushd "%~dp0" || exit /b 1

git pull --ff-only
if errorlevel 1 (
  echo Update failed. Check the Git error above.
  pause
  popd
  exit /b 1
)

call "%~dp0install.cmd"
set "AROMAT_TOOLS_UPDATE_RESULT=%ERRORLEVEL%"
popd
exit /b %AROMAT_TOOLS_UPDATE_RESULT%
