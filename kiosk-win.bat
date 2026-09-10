@echo off
setlocal

rem Run from the folder this script lives in, however it was launched.
cd /d "%~dp0"

set "URL=http://localhost:8080"

rem set "FLAGS=--kiosk --incognito --no-first-run --noerrdialogs --disable-infobars"
set "FLAGS=--start-fullscreen --no-first-run"

rem Chrome ignores these flags when it joins an already-running instance, so
rem give the kiosk window its own profile -- the equivalent of "open -n" on Mac.
set "PROFILE=%TEMP%\nap-xtz-kiosk"

set "CHROME="
if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined CHROME for /f "delims=" %%C in ('where chrome 2^>nul') do if not defined CHROME set "CHROME=%%C"

if not defined CHROME (
  echo Could not find chrome.exe. Install Google Chrome, or set CHROME by hand in this script.
  pause
  exit /b 1
)

start "nap-xtz-server" /min cmd /c node app.js

rem Blocks until the kiosk window is closed, then the server goes with it.
start "" /wait "%CHROME%" %FLAGS% --user-data-dir="%PROFILE%" "%URL%"

taskkill /fi "WINDOWTITLE eq nap-xtz-server" /t /f >nul 2>&1

endlocal
