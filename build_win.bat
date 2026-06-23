@echo off
REM Build Human Typer for Windows.
cd /d "%~dp0"

echo === Building Human Typer for Windows ===
python -m pip install --upgrade -r requirements.txt pyinstaller

if exist build rmdir /s /q build
if exist dist rmdir /s /q dist
python -m PyInstaller --noconfirm --clean HumanTyper.spec

echo.
echo Done -^> dist\HumanTyper\HumanTyper.exe
echo Distribute: zip the whole dist\HumanTyper folder and send it.
echo (Needs the Microsoft Edge WebView2 runtime, preinstalled on Windows 10/11.)
pause
