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

rem The Android SDK and JDK 17, when this window doesn't already know them
rem (an Administrator window can run as another account with other settings).
if not defined ANDROID_HOME if exist "%LOCALAPPDATA%\Android\Sdk\platform-tools" set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
if not defined ANDROID_HOME if exist "C:\Users\azureuser\AppData\Local\Android\Sdk\platform-tools" set "ANDROID_HOME=C:\Users\azureuser\AppData\Local\Android\Sdk"
rem Installed from inside the Claude desktop app, the SDK sits in that app's own storage.
if not defined ANDROID_HOME for /d %%P in ("C:\Users\azureuser\AppData\Local\Packages\Claude_*") do if exist "%%P\LocalCache\Local\Android\Sdk\platform-tools" set "ANDROID_HOME=%%P\LocalCache\Local\Android\Sdk"
if not defined ANDROID_HOME (echo No Android SDK found. Install it with Android Studio, or set ANDROID_HOME. & pause & exit /b 1)
set "ANDROID_SDK_ROOT=%ANDROID_HOME%"
if not defined JAVA_HOME for /d %%J in ("C:\Program Files\Eclipse Adoptium\jdk-17*") do set "JAVA_HOME=%%~fJ"
echo Android SDK: %ANDROID_HOME%
echo Java: %JAVA_HOME%

rem Java needs a short temp folder for its sockets on this PC.
if not exist C:\gtmp mkdir C:\gtmp
set "JAVA_TOOL_OPTIONS=-Djdk.net.unixdomain.tmpdir=C:\gtmp"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-android.ps1"
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" echo. & echo The build failed (exit %RESULT%). Copy the red text above into the thread.
pause
exit /b %RESULT%
