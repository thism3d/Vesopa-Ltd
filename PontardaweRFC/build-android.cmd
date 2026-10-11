@echo off
rem Pontardawe RFC for Android, in one go: double-click this file, or run it
rem from cmd or PowerShell. It runs build-android.ps1 from the repository root
rem with what this PC needs around it.
setlocal
cd /d "%~dp0.."

rem A Gradle daemon left over from an earlier build holds files in build\app.
if exist "%~dp0build\app\android\gradlew.bat" (
    pushd "%~dp0build\app\android"
    call gradlew.bat --stop >nul 2>&1
    popd
)

rem Java needs a short temp folder for its sockets on this PC.
if not exist C:\gtmp mkdir C:\gtmp
set "JAVA_TOOL_OPTIONS=-Djdk.net.unixdomain.tmpdir=C:\gtmp"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-android.ps1"
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" echo. & echo The build failed (exit %RESULT%). Copy the red text above into the thread.
pause
exit /b %RESULT%
