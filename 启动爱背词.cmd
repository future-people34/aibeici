@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
title AiBeiCi - CET6 Vocabulary

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   [ERROR] Node.js not found.
  echo   Please install Node.js 18+ from https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)

node scripts\launch.mjs
if errorlevel 1 pause
