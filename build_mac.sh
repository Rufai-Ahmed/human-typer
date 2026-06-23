#!/bin/bash
# Build Human Typer.app for macOS.
set -e
cd "$(dirname "$0")"

echo "=== Building Human Typer for macOS ==="
python3 -m pip install --upgrade -r requirements.txt pyinstaller

rm -rf build dist
python3 -m PyInstaller --noconfirm --clean HumanTyper.spec

# Sign with the stable self-signed identity so macOS keeps the Accessibility /
# Input Monitoring grant across rebuilds (skipped if the script isn't present).
if [ -x ./sign_mac.sh ]; then
    ./sign_mac.sh
fi

echo ""
echo "Done -> dist/Human Typer.app"
echo "Test it:   open 'dist/Human Typer.app'"
echo "Distribute: right-click the .app > Compress, then send the .zip."
echo ""
echo "First launch on a buyer's Mac: they right-click > Open (unsigned app),"
echo "then grant Accessibility + Input Monitoring in System Settings > Privacy."
