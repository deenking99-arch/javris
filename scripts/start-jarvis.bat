@echo off
REM JARVIS 2.0 – Start unter Windows (für Autostart: Verknüpfung in shell:startup ablegen)
cd /d "%~dp0\.."
if not exist "client\dist\index.html" call npm run build
start "JARVIS Server" /min cmd /c "npm start"
timeout /t 4 /nobreak >nul
REM App-Fenster ohne Browserleiste; erlaubt Sprachausgabe ohne vorherigen Klick
start "" chrome --app=http://127.0.0.1:7777 --autoplay-policy=no-user-gesture-required --start-fullscreen
