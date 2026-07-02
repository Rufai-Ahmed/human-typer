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
# certifi carries the CA roots the app falls back to when the OS store is stale.
_collect = ['webview', 'certifi']
if sys.platform.startswith('win'):
    _collect += ['clr_loader', 'pythonnet']   # pywebview's WinForms/WebView2 backend
for _pkg in _collect:
    try:
        from PyInstaller.utils.hooks import collect_all
        _d, _b, _h = collect_all(_pkg)
        datas += _d
        binaries += _b
        hiddenimports += _h
    except Exception as exc:  # pragma: no cover
        print(f"[spec] {_pkg} not collected ({exc}).")

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

# macOS arch: universal2 by default (CI, where a universal2 Python is installed).
# Set HT_MAC_ARCH=native for a fast single-arch local build from a non-fat Python
# (e.g. updating this machine's own copy).
if sys.platform == 'darwin':
    _target_arch = None if os.environ.get('HT_MAC_ARCH') == 'native' else 'universal2'
else:
    _target_arch = None

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
    target_arch=_target_arch,
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
            'CFBundleShortVersionString': '1.6.4',
            'CFBundleVersion': '1.6.4',
            'NSHighResolutionCapable': True,
            'LSMinimumSystemVersion': '10.13.0',
            'NSHumanReadableCopyright': '© Human Typer',
        },
    )
