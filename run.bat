@echo off

rem set PORT=8080
rem :findport
rem netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1
rem if %errorlevel%==0 (
rem   set /a PORT+=1
rem   goto findport
rem )

rem start http://127.0.0.1:%PORT%
rem http-server -p %PORT%

start http://127.0.0.1:8080
node app.js

@pause