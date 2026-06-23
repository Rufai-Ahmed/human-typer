# Human Typer

A native desktop app that types your text into **any** application the way a real
person does — real OS keystrokes (so the target sees genuine key events,
`isTrusted == true`, no paste to detect), with human rhythm, and a global
**Esc** emergency stop.

Works on **macOS** and **Windows** from one codebase.

## Features

| | |
|---|---|
| **Types anywhere** | Real OS-level keystrokes via CoreGraphics (macOS) / pynput (Windows). Works in any app, any text field — no integration needed. |
| **Layout independent** | Characters are posted directly, so it works regardless of QWERTY/AZERTY/Dvorak. |
| **Speed slider** | 2–200 ms per keystroke. Lower = faster (turn Humanize off for top speed). |
| **Humanize** | Variable Gaussian timing, **bigram flight-time** (distant keys take longer, hand-alternation is faster), pauses after spaces/punctuation, and occasional hesitations. Toggle off for constant-speed typing. |
| **Typo & correction** | Optional: occasionally fat-fingers a nearby key, then backspaces and fixes it. |
| **Global Esc stop** | Press **Esc** to abort instantly — even when another app has focus. |
| **Countdown** | A 1–10 s countdown (default 5 s) to switch to your target window first. |

## How to use (the app)

1. **Paste your text** into the box.
2. **Set the speed** and the Humanize options.
3. **Hit Start**, click into your target app — typing begins after the countdown.
   Press **Esc** anytime to stop.

## Run from source (development)

```bash
pip install -r requirements.txt
python human_typer.py          # opens the native app window
python human_typer.py --gui --browser   # force the browser UI instead
```

> Without `pywebview` installed, the app falls back to opening in your browser.

## Build the app

**macOS:**
```bash
./build_mac.sh        # -> dist/Human Typer.app
```

**Windows:**
```bat
build_win.bat         REM -> dist\HumanTyper\HumanTyper.exe
```

Both scripts install dependencies and produce a windowed (no-terminal) app.

## Distributing & selling

You don't need the App Store — just send buyers the file:

- **macOS:** right-click `Human Typer.app` → **Compress**, send the `.zip`
  (or build a `.dmg`). Unsigned apps: buyers right-click → **Open** the first time.
- **Windows:** zip the `dist\HumanTyper` folder and send it. Unsigned apps:
  buyers click **More info → Run anyway** past SmartScreen.

### Permissions (first launch)

Typing keystrokes is a privileged action:

- **macOS:** System Settings → Privacy & Security → **Accessibility** (required —
  this is what lets it send keystrokes) and **Input Monitoring** (for the global
  Esc stop) → enable Human Typer. Quit and relaunch the app after granting.
- **Windows:** no special permission; some antivirus may prompt on first run.

> **macOS rebuild gotcha:** an ad-hoc-signed app gets a *new* signature every
> build, so macOS forgets the grant — the entry may still show ON but no longer
> applies, and typing silently does nothing. After a rebuild: remove the old
> "Human Typer" row in Accessibility (select it, click **–**), re-add the new
> `dist/Human Typer.app` with **+**, enable it, then relaunch. To avoid this for
> good, sign with a stable identity — run `./sign_mac.sh` after building (or use
> an Apple Developer ID for release).

### Optional polish for a paid product

- **Sign + notarize** the macOS app (Apple Developer ID, $99/yr) to remove the
  Gatekeeper warning.
- **Code-sign** the Windows `.exe` (a code-signing certificate) to remove the
  SmartScreen warning.

## CLI (still available)

```bash
python human_typer.py "Hello, this looks hand-typed."
python human_typer.py -f notes.txt
echo "piped text" | python human_typer.py -
python human_typer.py --clipboard
python human_typer.py "fast, jumpy, with typos" --delay-ms 12 --typos 0.02
python human_typer.py "constant speed" --delay-ms 20 --no-humanize
```

| Flag | Default | Meaning |
|---|---|---|
| `--delay-ms` | (from `--wpm`) | Base ms between keystrokes (2–200). Overrides `--wpm`. |
| `--wpm` | 65 | Target words per minute (used if `--delay-ms` omitted). |
| `--no-humanize` | off | Constant speed — no rhythm, pauses, or typos. |
| `--variance` | 0.35 | Per-key timing jitter as a fraction of the mean. |
| `--typos` | 0.0 | Per-char probability of a typo + self-correction. |
| `--delay` | 5.0 | Countdown seconds before typing starts. |
| `--gui` / `--browser` | — | Launch the desktop window / force the browser UI. |

## Notes

- Intended for legitimate keyboard automation on machines you control — demos,
  repetitive data entry, accessibility, and UI testing.
- Handles uppercase, symbols, newlines (Enter), and tabs.
