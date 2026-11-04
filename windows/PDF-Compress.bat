@echo off
rem  PDF compressor launcher
rem  - Drag PDF files or folders onto this file, or double-click it to pick files.
rem  - Needs Ghostscript installed once (the script tells you how if it's missing).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0compress-pdf.ps1" %*
