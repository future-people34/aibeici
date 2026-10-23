@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
title AiBeiCi - Build APK

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   [ERROR] Node.js not found. Install from https://nodejs.org first.
  echo.
  pause
  exit /b 1
)

if not exist "android-sdk\jdk\bin\javac.exe" (
  echo   第一次打包，先下载 JDK 和 Android 构建工具（约 300 MB）...
  call node scripts\fetch-sdk.mjs
  if errorlevel 1 goto fail
)

call node scripts\build-apk.mjs
if errorlevel 1 goto fail

echo.
echo   APK 在 dist-android\aibeici.apk
echo   传到手机点击安装即可。
echo.
pause
exit /b 0

:fail
echo.
echo   [ERROR] 打包失败，看上面的报错信息。
echo.
pause
exit /b 1
