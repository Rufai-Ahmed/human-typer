# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for Human Typer. Produces a windowed (no-terminal) app:
#   macOS   -> dist/Human Typer.app
#   Windows -> dist/HumanTyper/HumanTyper.exe (+ supporting files)
#
# Build with:  python -m PyInstaller --noconfirm --clean HumanTyper.spec

import os
import sys

# App icon for the current build platform (skipped if not yet generated).
_icon = 'icon.icns' if sys.platform == 'darwin' else 'icon.ico'
ICON = _icon if os.path.exists(_icon) else None

datas = [('gui', 'gui')]          # bundle the web UI assets
binaries = []
hiddenimports = []                # keys are validated online now, nothing to embed

# Pull in pywebview and its platform webview backend (pyobjc on macOS,
# pythonnet/WebView2 on Windows). Skipped gracefully if not installed.
try:
    from PyInstaller.utils.hooks import collect_all
    _d, _b, _h = collect_all('webview')
    datas += _d
    binaries += _b
    hiddenimports += _h
except Exception as exc:  # pragma: no cover
    print(f"[spec] pywebview not collected ({exc}); native window may be unavailable.")

a = Analysis(
    ['human_typer.py'],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='HumanTyper',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,          # windowed: no terminal window
    disable_windowed_traceback=False,
    argv_emulation=True,    # let macOS pass file/open events through cleanly
    target_arch='universal2' if sys.platform == 'darwin' else None,
    codesign_identity=None,
    entitlements_file=None,
    icon=ICON,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='HumanTyper',
)

if sys.platform == 'darwin':
    app = BUNDLE(
        coll,
        name='Human Typer.app',
        icon=ICON,
        bundle_identifier='xyz.humantyper.app',
        info_plist={
            'CFBundleName': 'Human Typer',
            'CFBundleDisplayName': 'Human Typer',
            'CFBundleShortVersionString': '1.4.0',
            'CFBundleVersion': '1.4.0',
            'NSHighResolutionCapable': True,
            'LSMinimumSystemVersion': '10.13.0',
            'NSHumanReadableCopyright': '© Human Typer',
        },
    )
