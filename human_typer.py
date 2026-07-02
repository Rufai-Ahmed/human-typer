#!/usr/bin/env python3
"""
Human Typer — simulate human typing at the OS level.

Generates real keystrokes. On macOS, this is done natively via CoreGraphics (ctypes)
to bypass external library requirements. On Windows/Linux it uses pynput.

Speed is set as a per-keystroke delay (2-200 ms). With "Humanize" on, the rhythm
is drawn from a Gaussian around that delay, with bigram (layout-proximity) flight
timing, word/sentence pauses, occasional hesitations, and optional typo+correction
loops, so the result looks hand-typed rather than metronomic.

Press Esc at any time to abort — globally, even when another app has focus.

Usage:
    python human_typer.py                       # Native app window (default)
    python human_typer.py --gui                 # Native app window (explicit)
    python human_typer.py --gui --browser       # Force the browser UI instead
    python human_typer.py "some text to type"   # CLI literal text mode
    python human_typer.py -f notes.txt          # CLI file mode
    python human_typer.py --clipboard           # CLI clipboard mode
"""

import argparse
import hashlib
import json
import math
import os
import platform
import random
import ssl
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from dataclasses import dataclass
from urllib.parse import urlparse

# In a PyInstaller windowed (no-console) build — notably on Windows — sys.stdin,
# sys.stdout and sys.stderr are all None. Re-point any that are None at os.devnull
# so .isatty()/.read()/print() never crash ("'NoneType' has no attribute 'isatty'").
for _std_name, _std_mode in (("stdin", "r"), ("stdout", "w"), ("stderr", "w")):
    if getattr(sys, _std_name, None) is None:
        try:
            setattr(sys, _std_name, open(os.devnull, _std_mode))
        except OSError:
            pass

# pynput drives keystrokes on Windows/Linux and the global Esc listener everywhere.
HAS_PYNPUT = False
try:
    from pynput.keyboard import Controller, Key, Listener
    HAS_PYNPUT = True
except ImportError:
    Controller, Key, Listener = None, None, None

import ctypes
import ctypes.util

IS_MAC = sys.platform == "darwin"
HAS_COREGRAPHICS = False

# How long a key is "held" between its press and release events (seconds).
# Small so fast speeds stay fast, but non-zero so target apps reliably register it.
KEY_HOLD = 0.001

# Native macOS CoreGraphics binding for zero-dependency key posting.
if IS_MAC:
    try:
        cg = ctypes.CDLL('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
        cf = ctypes.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')

        cg.CGEventCreateKeyboardEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint16, ctypes.c_bool]
        cg.CGEventCreateKeyboardEvent.restype = ctypes.c_void_p

        cg.CGEventKeyboardSetUnicodeString.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_void_p]
        cg.CGEventKeyboardSetUnicodeString.restype = None

        cg.CGEventPost.argtypes = [ctypes.c_uint32, ctypes.c_void_p]
        cg.CGEventPost.restype = None

        cf.CFRelease.argtypes = [ctypes.c_void_p]
        cf.CFRelease.restype = None

        # Thread-safe global key-state read (used for the Esc emergency stop).
        cg.CGEventSourceKeyState.argtypes = [ctypes.c_int, ctypes.c_uint16]
        cg.CGEventSourceKeyState.restype = ctypes.c_bool

        HAS_COREGRAPHICS = True
    except Exception:
        pass

# Exit if we cannot type at all on this system.
if not HAS_PYNPUT and not (IS_MAC and HAS_COREGRAPHICS):
    sys.exit(
        "Dependency error: pynput is not installed and macOS CoreGraphics cannot be loaded.\n"
        "Run: pip install pynput"
    )

# Keys physically adjacent on a QWERTY layout, used to generate believable typos.
QWERTY_NEIGHBORS = {
    "a": "qwsz", "b": "vghn", "c": "xdfv", "d": "serfcx", "e": "wsdr",
    "f": "drtgvc", "g": "ftyhbv", "h": "gyujnb", "i": "ujko", "j": "huikmn",
    "k": "jiolm", "l": "kop", "m": "njk", "n": "bhjm", "o": "iklp",
    "p": "ol", "q": "wa", "r": "edft", "s": "awedxz", "t": "rfgy",
    "u": "yhji", "v": "cfgb", "w": "qase", "x": "zsdc", "y": "tghu",
    "z": "asx",
}

# Approximate physical coordinates of each key on a staggered QWERTY layout, used
# to model "flight time" between consecutive keys (bigrams): distant keys take
# longer to reach and hand-alternation flows faster — the way real typing moves.
_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"]
_ROW_STAGGER = [0.0, 0.5, 1.0]
KEY_COORDS = {}
for _r, _keys in enumerate(_ROWS):
    for _c, _k in enumerate(_keys):
        KEY_COORDS[_k] = (float(_r), _c + _ROW_STAGGER[_r])

_LEFT_HAND = set("qwertasdfgzxcvb")
_RIGHT_HAND = set("yuiophjklnm")


def _hand(ch: str):
    if ch in _LEFT_HAND:
        return "L"
    if ch in _RIGHT_HAND:
        return "R"
    return None


def bigram_factor(prev_char: str, cur_char: str) -> float:
    """Scale the base delay by how far the fingers travel from prev -> cur."""
    a, b = prev_char.lower(), cur_char.lower()
    if a not in KEY_COORDS or b not in KEY_COORDS:
        return 1.0
    if a == b:
        return 0.78  # repeating a key is quick
    (r1, c1), (r2, c2) = KEY_COORDS[a], KEY_COORDS[b]
    dist = math.hypot(r1 - r2, c1 - c2)
    factor = 0.72 + 0.07 * dist
    ha, hb = _hand(a), _hand(b)
    if ha and hb:
        factor *= 0.9 if ha != hb else 1.06  # alternating hands flow faster
    return max(0.6, min(1.7, factor))


@dataclass
class TypingProfile:
    delay_ms: float = 100.0       # base delay between keystrokes in ms (5-200)
    humanize: bool = True         # master toggle: realistic rhythm vs. constant speed
    variance: float = 0.35        # stddev of per-key delay as a fraction of the mean
    min_delay: float = 0.002      # hard floor between keystrokes (seconds)
    word_pause: float = 0.06      # extra mean pause after a space
    sentence_pause: float = 0.30  # extra mean pause after . ! ?
    hesitation_prob: float = 0.015  # chance of a "thinking" pause per char
    hesitation: float = 0.7       # mean length of a thinking pause (seconds)
    typo_prob: float = 0.0        # chance of a typo+correction per alpha char
    pauses: bool = True           # toggle word/sentence/hesitation pauses

    @property
    def mean_delay(self) -> float:
        return max(self.delay_ms, 0.0) / 1000.0


# Thread-safe global typing state for the GUI backend.
@dataclass
class TypingState:
    state: str = "idle"         # "idle", "countdown", "typing", "paused", "done", "aborted"
    text: str = ""
    total_chars: int = 0
    typed_chars: int = 0
    current_char: str = ""
    elapsed_time: float = 0.0
    effective_wpm: float = 0.0
    countdown_remaining: float = 0.0
    cancel_event: threading.Event = None
    pause_event: threading.Event = None
    pause_reason: str = ""       # "manual", "focus" or "waiting" while paused
    focus_guard: bool = True     # auto-pause if the frontmost app changes mid-run
    focus_target: object = None  # token for the app focused when typing began
    gui_token: object = None     # token for our own window when Start was clicked
    waiting_since: float = 0.0   # monotonic time the "waiting" pause began
    run_id: int = 0              # bumped per /api/type; guards stale watcher commits

typing_status = TypingState()
typing_status.cancel_event = threading.Event()
typing_status.pause_event = threading.Event()
_start_lock = threading.Lock()   # serializes the /api/type check-and-start


# --- Global emergency stop --------------------------------------------------
_abort_listener = None
_focus_listener = None
_ESC_KEYCODE = 53  # macOS virtual keycode for Esc
_event_tap_cb = None       # keep the ctypes tap callback alive (else it's GC'd → crash)
_event_tap_port = [None]   # the live CFMachPort, so the callback can re-arm the tap


def _frontmost_token():
    """A comparable token for the frontmost app/window (None = unknown, fail-open).

    On Windows this is (hwnd, window title): browser TABS share one hwnd, so the
    title is what lets a run started from our page in one Edge tab target a form
    in ANOTHER tab of the same window. Compare with _token_core() when only the
    window identity matters (titles change while pages load or docs autosave).
    """
    try:
        if IS_MAC:
            out = subprocess.run(["lsappinfo", "front"], capture_output=True,
                                 text=True, timeout=1).stdout.strip()
            return out or None
        if sys.platform.startswith("win"):
            hwnd = ctypes.windll.user32.GetForegroundWindow()
            if not hwnd:
                return None
            buf = ctypes.create_unicode_buffer(256)
            ctypes.windll.user32.GetWindowTextW(hwnd, buf, 256)
            return (int(hwnd), buf.value)
    except Exception:
        return None
    return None


def _token_core(tok):
    """The window-level part of a focus token (drops the title on Windows)."""
    return tok[0] if isinstance(tok, tuple) else tok


# Windows shell surfaces that are momentarily "foreground" while the user is on
# their way somewhere else. Locking a run onto one of these would inject keys
# into the alt-tab switcher or the Start menu search box.
_WIN_TRANSIENT_CLASSES = {
    "XamlExplorerHostIslandWindow", "MultitaskingViewFrame", "ForegroundStaging",
    "TaskSwitcherWnd", "TaskListThumbnailWnd", "Shell_TrayWnd",
    "Windows.UI.Core.CoreWindow",
}


def _is_transient_surface(tok) -> bool:
    """True when tok is a Windows shell surface no run should ever target."""
    if not (isinstance(tok, tuple) and sys.platform.startswith("win")):
        return False
    try:
        buf = ctypes.create_unicode_buffer(128)
        ctypes.windll.user32.GetClassNameW(tok[0], buf, 128)
        return buf.value in _WIN_TRANSIENT_CLASSES
    except Exception:
        return False


def _focus_watcher() -> None:
    """Auto-pause a run if the user genuinely switches away from their target.

    Debounced: the frontmost app must differ for two consecutive polls (~0.9s)
    before pausing, so a transient blip (a menu, a notification) doesn't pause.
    """
    miss = 0
    cand, cand_hits = None, 0   # waiting-state landing candidate + stability count
    while True:
        s = typing_status
        if s.state == "typing" and s.focus_guard and s.focus_target is not None and not s.pause_event.is_set():
            # Guard on the WINDOW only (token core): a page title changing mid-run
            # (loading spinners, autosave marks) must not read as a focus switch.
            # Exception: an exact match on our OWN token (same window, our tab
            # title) means the user came back to the GUI tab -- that must pause,
            # or we'd type into our own page.
            tok = _frontmost_token()
            if tok is not None and (_token_core(tok) != _token_core(s.focus_target)
                                    or (s.gui_token is not None and tok == s.gui_token)):
                miss += 1
                if miss >= 2:
                    s.pause_reason = "focus"
                    s.pause_event.set()
                    miss = 0
            else:
                miss = 0
            time.sleep(0.45)
        elif s.state == "paused" and s.pause_reason == "waiting" and s.pause_event.is_set():
            # Run started while our own window/tab was still frontmost: lock onto
            # the first OTHER app -- or other TAB (full-token compare catches a
            # title change within the same window) -- and let typing begin there.
            # The landing WINDOW (token core) must hold for two polls so transient
            # surfaces are never mistaken for the target; the freshest full token
            # is what gets committed (page titles may tick while we count).
            tok = _frontmost_token()
            if tok is not None and tok != s.gui_token and not _is_transient_surface(tok):
                if cand is not None and _token_core(tok) == _token_core(cand):
                    cand_hits += 1
                else:
                    cand_hits = 1
                cand = tok
                if cand_hits >= 2:
                    run = s.run_id
                    time.sleep(0.9)   # a beat to click into the exact field
                    # Commit atomically AFTER the grace beat, onto where the user
                    # REALLY is now (they may have moved during the beat), and only
                    # for the run this decision was made for: an abort + instant
                    # restart (or a /api/resume) during the sleep must not be
                    # released by a stale landing. Until then the GUI keeps showing
                    # the waiting copy, so no Resume button can race us.
                    cur = _frontmost_token()
                    if (s.run_id == run and s.pause_reason == "waiting"
                            and not s.cancel_event.is_set()
                            and cur is not None
                            and _token_core(cur) == _token_core(cand)
                            and cur != s.gui_token
                            and not _is_transient_surface(cur)):
                        s.focus_target = cur
                        s.pause_reason = ""
                        s.pause_event.clear()
                    cand, cand_hits = None, 0
            else:
                cand, cand_hits = None, 0
            if (s.pause_event.is_set() and s.pause_reason == "waiting"
                    and s.waiting_since and time.monotonic() - s.waiting_since > 45):
                # Never landed anywhere detectable: degrade to a normal pause the
                # user can Resume, instead of killing the run (which would also
                # discard any queued documents behind it).
                s.pause_reason = "manual"
                s.waiting_since = 0.0
            miss = 0
            time.sleep(0.3)
        else:
            miss = 0
            cand, cand_hits = None, 0
            time.sleep(0.3)


# --- Quick-type hotkey + clipboard watch -----------------------------------
hotkey_enabled = False
clipwatch_enabled = False
_hotkey_listener = None
_last_clip = None


def _chord_down() -> bool:
    """True while the quick-type chord (Cmd/Ctrl + Shift + H) is held.

    macOS uses the same thread-safe CGEventSourceKeyState as the Esc stop (never
    pynput, which crashes Text Services from a worker thread inside the Cocoa app).
    """
    try:
        if IS_MAC and HAS_COREGRAPHICS:
            cmd = cg.CGEventSourceKeyState(0, 55) or cg.CGEventSourceKeyState(0, 54)
            shift = cg.CGEventSourceKeyState(0, 56) or cg.CGEventSourceKeyState(0, 60)
            return bool(cmd and shift and cg.CGEventSourceKeyState(0, 4))  # H = keycode 4
        if sys.platform.startswith("win"):
            g = ctypes.windll.user32.GetAsyncKeyState
            return bool((g(0x11) & 0x8000) and (g(0x10) & 0x8000) and (g(0x48) & 0x8000))
    except Exception:
        return False
    return False


def _fire_quick_type() -> None:
    """Type the clipboard into the focused field, no window raise, 1s lead-in."""
    if not is_activated() or not accessibility_ok():
        return
    try:
        text = read_clipboard()
    except Exception:
        return
    if not text or not text.strip():
        return
    # Same claim discipline as /api/type, so a hotkey firing the instant the user
    # clicks Start can't spawn a second interleaved typing thread.
    with _start_lock:
        if typing_status.state in ("countdown", "typing", "paused"):
            return
        typing_status.state = "countdown"
        typing_status.focus_guard = False   # quick-type goes wherever you already are
        typing_status.run_id += 1
        try:
            threading.Thread(target=type_text, args=(text, TypingProfile(), 1.0, True), daemon=True).start()
        except Exception:
            typing_status.state = "idle"


def _hotkey_watcher() -> None:
    global _last_clip
    armed = True
    tick = 0
    while True:
        if typing_status.state == "idle" and (hotkey_enabled or clipwatch_enabled):
            if hotkey_enabled and not IS_MAC:   # macOS handles the chord via the CGEventTap
                if _chord_down():
                    if armed:
                        armed = False
                        _fire_quick_type()
                else:
                    armed = True
            if clipwatch_enabled and tick % 4 == 0:    # poll the clipboard ~every 0.5s
                try:
                    clip = read_clipboard()
                    if _last_clip is None:
                        _last_clip = clip          # baseline; don't fire on the existing clipboard
                    elif clip != _last_clip:
                        _last_clip = clip
                        if clip and clip.strip():
                            _fire_quick_type()
                except Exception:
                    pass
            tick += 1
            time.sleep(0.06)
        else:
            time.sleep(0.25)


def _macos_event_tap() -> None:
    """Global keyboard tap (Accessibility-gated) for the panic-stop and hotkey.

    Replaces CGEventSourceKeyState polling, which needed the separate Input Monitoring
    permission AND could not see the Touch Bar Esc key (delivered as a system event,
    not a normal keyDown). A listen-only CGEventTap on its own CFRunLoop catches:
      * Cmd + .   -> stop  (a chord, so it fires on EVERY Mac incl. Touch Bar)
      * Esc       -> stop  (only Macs with a physical Esc emit this globally)
      * Cmd+Shift+H -> quick-type hotkey
    Built on the CoreGraphics/CoreFoundation CDLLs the app already loads (no extra
    PyInstaller deps). The callback only reads keycodes/flags and sets thread-safe
    events — no Text Services calls — so it's safe off the main thread (pynput wasn't).
    The tap needs Accessibility (a superset that also covers input monitoring); we
    retry creating it until that's granted via the permission gate.
    """
    global _event_tap_cb
    PERIOD, H_KC = 47, 4
    KEYCODE_FIELD = 9                 # kCGKeyboardEventKeycode
    FLAG_SHIFT, FLAG_CMD = 0x20000, 0x100000
    KEYDOWN = 10                      # kCGEventKeyDown
    DISABLED = (0xFFFFFFFE, 0xFFFFFFFF)  # tap disabled by timeout / user input
    MASK = 1 << KEYDOWN

    CB = ctypes.CFUNCTYPE(ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint32,
                          ctypes.c_void_p, ctypes.c_void_p)

    cg.CGEventTapCreate.argtypes = [ctypes.c_uint32, ctypes.c_uint32, ctypes.c_uint32,
                                    ctypes.c_uint64, CB, ctypes.c_void_p]
    cg.CGEventTapCreate.restype = ctypes.c_void_p
    cg.CGEventTapEnable.argtypes = [ctypes.c_void_p, ctypes.c_bool]
    cg.CGEventGetIntegerValueField.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
    cg.CGEventGetIntegerValueField.restype = ctypes.c_int64
    cg.CGEventGetFlags.argtypes = [ctypes.c_void_p]
    cg.CGEventGetFlags.restype = ctypes.c_uint64
    cf.CFMachPortCreateRunLoopSource.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_long]
    cf.CFMachPortCreateRunLoopSource.restype = ctypes.c_void_p
    cf.CFRunLoopGetCurrent.restype = ctypes.c_void_p
    cf.CFRunLoopAddSource.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
    mode = ctypes.c_void_p.in_dll(cf, "kCFRunLoopDefaultMode")

    def _cb(proxy, etype, event, refcon):
        try:
            if etype == KEYDOWN:
                kc = cg.CGEventGetIntegerValueField(event, KEYCODE_FIELD)
                flags = cg.CGEventGetFlags(event)
                cmd = bool(flags & FLAG_CMD)
                active = typing_status.state in ("countdown", "typing", "paused")
                if active and (kc == _ESC_KEYCODE or (kc == PERIOD and cmd)):
                    typing_status.cancel_event.set()
                elif kc == H_KC and cmd and (flags & FLAG_SHIFT) and hotkey_enabled:
                    _fire_quick_type()
            elif etype in DISABLED and _event_tap_port[0]:
                cg.CGEventTapEnable(_event_tap_port[0], True)   # system disabled us → re-arm
        except Exception:
            pass
        return event

    _event_tap_cb = CB(_cb)   # MUST stay referenced for the life of the tap

    while True:
        port = None
        try:
            # tap=kCGSessionEventTap(1), place=kCGHeadInsertEventTap(0), opt=listenOnly(1)
            port = cg.CGEventTapCreate(1, 0, 1, MASK, _event_tap_cb, None)
        except Exception:
            port = None
        if port:
            _event_tap_port[0] = port
            src = cf.CFMachPortCreateRunLoopSource(None, port, 0)
            cf.CFRunLoopAddSource(cf.CFRunLoopGetCurrent(), src, mode)
            cg.CGEventTapEnable(port, True)
            cf.CFRunLoopRun()   # blocks this daemon thread, dispatching _cb
        time.sleep(2.0)         # no Accessibility yet (or tap died) — retry until granted


def start_global_abort_listener() -> bool:
    """Watch for Esc globally so the user can abort from any app.

    Mirrors goghostwriter's emergency stop: pressing Esc while a countdown or
    typing run is active cancels it, even when another window has focus.
    """
    global _abort_listener, _focus_listener, _hotkey_listener
    if _focus_listener is None:
        _focus_listener = threading.Thread(target=_focus_watcher, daemon=True)
        _focus_listener.start()
    if _hotkey_listener is None:
        _hotkey_listener = threading.Thread(target=_hotkey_watcher, daemon=True)
        _hotkey_listener.start()
    if _abort_listener is not None:
        return False

    # macOS: a listen-only CGEventTap (pynput's listener is unsafe here, and key-state
    # polling missed Touch Bar keys / needed Input Monitoring).
    if IS_MAC and HAS_COREGRAPHICS:
        _abort_listener = threading.Thread(target=_macos_event_tap, daemon=True)
        _abort_listener.start()
        return True

    # Windows/Linux: pynput global listener.
    if HAS_PYNPUT:
        def on_press(key):
            if key == Key.esc and typing_status.state in ("countdown", "typing", "paused"):
                typing_status.cancel_event.set()
        _abort_listener = Listener(on_press=on_press)
        _abort_listener.daemon = True
        _abort_listener.start()
        return True

    return False


# --- Online license activation ----------------------------------------------
# Keys are validated by our server (Supabase-backed), which binds each key to ONE
# device and supports revocation. Activation needs internet once; afterwards the
# local record (tied to this machine's fingerprint) gates the app, re-checked
# online at launch (fail-open when offline, so offline use keeps working).
ACTIVATE_URL = os.environ.get(
    "HUMANTYPER_ACTIVATE_URL", "https://humantyper.rufaiahmed.com/api/activate"
)

# Bump this on every release; the app compares it to the server's latest version
# and shows a "Download update" banner when this build is behind.
APP_VERSION = "1.6.5"
VERSION_URL = os.environ.get(
    "HUMANTYPER_VERSION_URL", ACTIVATE_URL.rsplit("/api/", 1)[0] + "/api/version"
)


def _config_dir() -> str:
    if sys.platform == "win32":
        base = os.environ.get("APPDATA", os.path.expanduser("~"))
        path = os.path.join(base, "HumanTyper")
    elif sys.platform == "darwin":
        path = os.path.expanduser("~/Library/Application Support/HumanTyper")
    else:
        path = os.path.expanduser("~/.config/humantyper")
    os.makedirs(path, exist_ok=True)
    return path


def _profiles_file() -> str:
    return os.path.join(_config_dir(), "profiles.json")


def _log_launch(msg: str) -> None:
    """Append a line to launch.log in the config dir (support/debug breadcrumbs).

    A windowed build has no console, so this file is the only place launch
    problems (like the native window failing) leave a trace a buyer can send us.
    """
    try:
        path = os.path.join(_config_dir(), "launch.log")
        if os.path.exists(path) and os.path.getsize(path) > 65536:
            os.remove(path)  # keep it tiny; it's a breadcrumb file, not a journal
        stamp = time.strftime("%Y-%m-%d %H:%M:%S")
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(f"[{stamp}] v{APP_VERSION} {msg}\n")
    except Exception:
        pass


def load_user_profiles() -> dict:
    """User-saved typing profiles ({name: settings}); empty dict on any error."""
    try:
        with open(_profiles_file(), "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _write_user_profiles(profs: dict) -> None:
    try:
        with open(_profiles_file(), "w", encoding="utf-8") as fh:
            json.dump(profs, fh)
    except Exception:
        pass


def _activation_file() -> str:
    return os.path.join(_config_dir(), "activation.json")


def _normalize_key(key: str) -> str:
    # Canonical form: alphanumerics only, uppercased — forgiving of dashes,
    # spaces, and case so a pasted key matches however it was formatted.
    return "".join(ch for ch in key if ch.isalnum()).upper()


def _machine_id() -> str:
    """A stable, hashed per-machine fingerprint so a key binds to one device."""
    raw = ""
    try:
        if sys.platform == "darwin":
            out = subprocess.run(["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"],
                                 capture_output=True, text=True).stdout
            for line in out.splitlines():
                if "IOPlatformUUID" in line:
                    raw = line.split('"')[-2]
                    break
        elif sys.platform.startswith("win"):
            out = subprocess.run(
                ["reg", "query", r"HKLM\SOFTWARE\Microsoft\Cryptography", "/v", "MachineGuid"],
                capture_output=True, text=True,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            ).stdout
            for tok in out.split():
                if len(tok) >= 32 and "-" in tok:
                    raw = tok
                    break
        else:
            for p in ("/etc/machine-id", "/var/lib/dbus/machine-id"):
                try:
                    with open(p) as fh:
                        raw = fh.read().strip()
                    if raw:
                        break
                except Exception:
                    pass
    except Exception:
        raw = ""
    if not raw:
        import getpass
        import platform
        raw = f"{platform.node()}|{getpass.getuser()}|{platform.machine()}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


# Last low-level network failure, surfaced to the GUI with the 'offline' message
# so a buyer's "no internet" report tells us WHY (e.g. an SSL verify failure).
_last_net_error = ""


def _ssl_context():
    """TLS context trusting the OS store PLUS certifi's bundled roots.

    Old or unpatched Windows machines often lack newer roots (e.g. ISRG Root X1
    behind this domain's cert) and, unlike browsers, Python never fetches missing
    roots on demand — so activation there fails as 'offline' despite a working
    connection. certifi ships the current Mozilla roots inside the app.
    """
    ctx = ssl.create_default_context()
    try:
        import certifi
        ctx.load_verify_locations(certifi.where())
    except Exception:
        pass
    return ctx


def _post_activate(key: str, timeout: float = 12.0):
    """Ask the server to activate/re-check a key for this device.

    Returns {"ok": True} / {"ok": False, "reason": "..."}, or None if the server
    is unreachable (offline).
    """
    global _last_net_error
    payload = json.dumps({"key": key, "device_id": _machine_id()}).encode("utf-8")
    req = urllib.request.Request(
        ACTIVATE_URL, data=payload,
        headers={"Content-Type": "application/json"}, method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_ssl_context()) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode("utf-8"))
        except Exception:
            return {"ok": False, "reason": "invalid"}
    except Exception as e:
        _last_net_error = str(e) or e.__class__.__name__
        return None  # offline / network error


def _local_activation():
    try:
        with open(_activation_file(), "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return None


def _clear_activation() -> None:
    try:
        os.remove(_activation_file())
    except Exception:
        pass


def _write_activation(data: dict) -> None:
    try:
        with open(_activation_file(), "w", encoding="utf-8") as fh:
            json.dump(data, fh)
    except Exception:
        pass


def _parse_ts(s):
    """Parse an ISO / Postgres timestamptz to epoch seconds (UTC). None if absent/bad."""
    if not s:
        return None
    try:
        from datetime import datetime, timezone
        dt = datetime.fromisoformat(str(s).strip().replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    except Exception:
        return None


def _is_expired(data) -> bool:
    """True when a monthly record's stored expiry is in the past.

    Lifetime records carry no expires_at, so they never expire. The expiry date lives
    in the local activation record, which is what makes a monthly pass enforceable
    OFFLINE: this check needs no network.
    """
    if not isinstance(data, dict):
        return False
    exp = _parse_ts(data.get("expires_at"))
    return exp is not None and time.time() >= exp


def is_activated() -> bool:
    """Fast local gate: a saved activation bound to THIS machine, not expired. No network."""
    data = _local_activation()
    return bool(
        data and data.get("key")
        and data.get("device_id") == _machine_id()
        and not _is_expired(data)
    )


def revalidate_online() -> None:
    """Re-check the saved key with the server; sync expiry; drop it if revoked/moved.

    Fail-open when offline so a buyer without internet keeps working (a monthly pass
    is still enforced locally from the stored expiry). On an OK re-check we copy any
    new expires_at down, so RENEWING a monthly pass restores access on the next launch
    with no re-entry. An 'expired' result keeps the key (paying again auto-recovers);
    revoked / invalid / in_use means the key is dead or moved, so it is dropped.
    """
    data = _local_activation()
    if not data or not data.get("key"):
        return
    res = _post_activate(data["key"], timeout=6.0)
    if res is None:
        return  # offline
    if res.get("ok"):
        changed = False
        for f in ("plan", "expires_at"):
            if res.get(f) != data.get(f):
                data[f] = res.get(f)
                changed = True
        if changed:
            _write_activation(data)
        return
    if res.get("reason") == "expired":
        if res.get("expires_at") and res.get("expires_at") != data.get("expires_at"):
            data["expires_at"] = res.get("expires_at")
            if res.get("plan"):
                data["plan"] = res.get("plan")
            _write_activation(data)
        return
    _clear_activation()


def activate(key: str) -> dict:
    """Activate a key for this device via the server. Returns {ok, reason?}."""
    key = (key or "").strip()
    if not key:
        return {"ok": False, "reason": "missing"}
    res = _post_activate(key)
    if res is None:
        return {"ok": False, "reason": "offline", "detail": _last_net_error}
    if res.get("ok"):
        rec = {"key": _normalize_key(key), "device_id": _machine_id()}
        if res.get("plan"):
            rec["plan"] = res.get("plan")
        if res.get("expires_at"):
            rec["expires_at"] = res.get("expires_at")
        _write_activation(rec)
        return {"ok": True}
    return {"ok": False, "reason": res.get("reason", "invalid")}


def _version_tuple(v: str):
    parts = []
    for p in (v or "").strip().lstrip("vV").split("."):
        digits = "".join(ch for ch in p if ch.isdigit())
        parts.append(int(digits) if digits else 0)
    return tuple(parts) or (0,)


def check_update() -> dict:
    """Ask the server for the latest version; flag if this build is behind.

    Returns {update_available, latest, url}. Fail-open (no banner) on any error.
    """
    try:
        req = urllib.request.Request(VERSION_URL, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=6, context=_ssl_context()) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        latest = data.get("version") or ""
        downloads = data.get("downloads") or {}
        if latest and _version_tuple(latest) > _version_tuple(APP_VERSION):
            if sys.platform.startswith("win"):
                url = downloads.get("windows")
            elif sys.platform == "darwin":
                # One universal build serves all Macs now; fall back to the old
                # per-arch keys so updaters from <=1.3.0 still resolve a URL.
                url = downloads.get("mac") or downloads.get("macArm") or downloads.get("macIntel")
            else:
                url = downloads.get("windows")
            return {"update_available": True, "latest": latest, "url": url or ""}
    except Exception:
        pass
    return {"update_available": False, "latest": APP_VERSION, "url": ""}


def accessibility_ok() -> bool:
    """True when the OS lets us send keystrokes.

    macOS gates synthetic keystrokes behind the Accessibility permission; we read
    it with AXIsProcessTrusted(). Other platforms don't gate this. Fail-open if the
    probe itself errors, so a check bug can never permanently brick the app.
    """
    if sys.platform != "darwin":
        return True
    try:
        import ctypes
        from ctypes import util as _ctutil
        appsvc = ctypes.cdll.LoadLibrary(_ctutil.find_library("ApplicationServices"))
        appsvc.AXIsProcessTrusted.restype = ctypes.c_bool
        return bool(appsvc.AXIsProcessTrusted())
    except Exception:
        return True


def input_monitoring_ok() -> bool:
    """True if the app may read global key state.

    The Esc-anywhere stop and the Cmd/Ctrl+Shift+H quick-type both poll global key
    state (CGEventSourceKeyState), which macOS gates behind Input Monitoring; without
    it those silently no-op. Fail-open if the probe itself errors.
    """
    if sys.platform != "darwin" or not HAS_COREGRAPHICS:
        return True
    try:
        cg.CGPreflightListenEventAccess.restype = ctypes.c_bool
        return bool(cg.CGPreflightListenEventAccess())
    except Exception:
        return True


def request_input_monitoring() -> None:
    """Prompt for Input Monitoring and register the app in the Privacy list."""
    if sys.platform == "darwin" and HAS_COREGRAPHICS:
        try:
            cg.CGRequestListenEventAccess.restype = ctypes.c_bool
            cg.CGRequestListenEventAccess()
        except Exception:
            pass


def _gauss_positive(mean: float, rel_std: float) -> float:
    """Gaussian sample folded to stay non-negative."""
    return abs(random.gauss(mean, mean * rel_std))


def keystroke_delay(prev_char: str, cur_char: str, profile: TypingProfile) -> float:
    """Compute how long to wait *before* typing the next char."""
    base = profile.mean_delay
    if not profile.humanize:
        return max(profile.min_delay, base)

    base *= bigram_factor(prev_char, cur_char)
    d = random.gauss(base, base * profile.variance)
    d = max(profile.min_delay, d)

    if profile.pauses:
        if prev_char == " ":
            d += _gauss_positive(profile.word_pause, 0.5)
        elif prev_char in ".!?":
            d += _gauss_positive(profile.sentence_pause, 0.5)
        elif prev_char in ",;:":
            d += _gauss_positive(profile.word_pause * 0.8, 0.5)
        if random.random() < profile.hesitation_prob:
            d += _gauss_positive(profile.hesitation, 0.5)
    return d


def _post_keycode_macos(code: int) -> None:
    """Post key press & release events using CoreGraphics virtual keycodes."""
    ev_down = cg.CGEventCreateKeyboardEvent(None, code, True)
    ev_up = cg.CGEventCreateKeyboardEvent(None, code, False)
    if ev_down and ev_up:
        cg.CGEventPost(0, ev_down)
        time.sleep(KEY_HOLD)
        cg.CGEventPost(0, ev_up)
        cf.CFRelease(ev_down)
        cf.CFRelease(ev_up)


def _post_unicode_macos(ch: str) -> None:
    """Post key press & release using CoreGraphics Unicode payload binding."""
    utf16_units = ch.encode('utf-16-le')
    length = len(utf16_units) // 2
    arr_type = ctypes.c_uint16 * length
    arr = arr_type.from_buffer_copy(utf16_units)

    # Virtual keycode 0 acts as a placeholder; the Unicode payload defines the char.
    ev_down = cg.CGEventCreateKeyboardEvent(None, 0, True)
    cg.CGEventKeyboardSetUnicodeString(ev_down, length, ctypes.byref(arr))

    ev_up = cg.CGEventCreateKeyboardEvent(None, 0, False)
    cg.CGEventKeyboardSetUnicodeString(ev_up, length, ctypes.byref(arr))

    if ev_down and ev_up:
        cg.CGEventPost(0, ev_down)
        time.sleep(KEY_HOLD)
        cg.CGEventPost(0, ev_up)
        cf.CFRelease(ev_down)
        cf.CFRelease(ev_up)


def press_char_macos(ch: str) -> None:
    """Mac native implementation using CoreGraphics events."""
    if ch == "\n":
        _post_keycode_macos(36)    # Enter
    elif ch == "\t":
        _post_keycode_macos(48)    # Tab
    elif ch == "\b":
        _post_keycode_macos(51)    # Backspace
    else:
        _post_unicode_macos(ch)


def press_char(kb, ch: str) -> None:
    """Send a single character as a real key event."""
    if IS_MAC and HAS_COREGRAPHICS:
        press_char_macos(ch)
    else:
        # Fallback to pynput (Windows/Linux).
        if ch == "\n":
            kb.press(Key.enter)
            kb.release(Key.enter)
        elif ch == "\t":
            kb.press(Key.tab)
            kb.release(Key.tab)
        elif ch == "\b":
            kb.press(Key.backspace)
            kb.release(Key.backspace)
        else:
            kb.type(ch)


def maybe_typo(kb, ch: str, profile: TypingProfile) -> None:
    """
    Occasionally fat-finger an adjacent key, pause as a human would notice it,
    backspace, then continue (the correct char is typed by the caller after).
    """
    if profile.typo_prob <= 0:
        return
    low = ch.lower()
    if low not in QWERTY_NEIGHBORS or random.random() >= profile.typo_prob:
        return

    wrong = random.choice(QWERTY_NEIGHBORS[low])
    if ch.isupper():
        wrong = wrong.upper()

    press_char(kb, wrong)
    time.sleep(keystroke_delay(wrong, "\b", profile))
    # Human reaction lag before spotting and fixing the mistake.
    time.sleep(_gauss_positive(0.25, 0.6))
    press_char(kb, "\b")
    time.sleep(keystroke_delay("\b", ch, profile))


def type_text(text: str, profile: TypingProfile, countdown: float, is_gui: bool = False) -> None:
    global typing_status

    # On macOS we post events via CoreGraphics, so we must NOT build a pynput
    # Controller here — its layout lookup calls Text Services from this worker
    # thread and crashes inside the Cocoa app. Only build it where it's used.
    use_pynput = HAS_PYNPUT and not (IS_MAC and HAS_COREGRAPHICS)
    kb = Controller() if use_pynput else None

    if is_gui:
        typing_status.state = "countdown"
        typing_status.text = text
        typing_status.total_chars = len(text)
        typing_status.typed_chars = 0
        typing_status.current_char = ""
        typing_status.elapsed_time = 0.0
        typing_status.effective_wpm = 0.0
        typing_status.countdown_remaining = countdown
        typing_status.cancel_event.clear()
        typing_status.pause_event.clear()
        typing_status.pause_reason = ""
        typing_status.focus_target = None

    if countdown > 0:
        if not is_gui:
            print(f"Typing in {countdown:.0f}s — click into the target field now...")

        end = time.perf_counter() + countdown
        last_shown = None
        while True:
            remaining = end - time.perf_counter()
            if remaining <= 0:
                break
            if is_gui:
                typing_status.countdown_remaining = remaining
                if typing_status.cancel_event.is_set():
                    typing_status.state = "aborted"
                    return
            else:
                shown = math.ceil(remaining)
                if shown != last_shown:
                    print(f"  {shown}...", end="\r", flush=True)
                    last_shown = shown
            time.sleep(0.05)  # fine-grained so Esc aborts the countdown promptly

        if not is_gui:
            print(" " * 20, end="\r")  # clear the countdown line

    if is_gui:
        typing_status.state = "typing"
        typing_status.countdown_remaining = 0.0
        if typing_status.focus_guard:
            tok = _frontmost_token()
            on_gui = tok is not None and tok == typing_status.gui_token
            manual_hold = (typing_status.pause_event.is_set()
                           and typing_status.pause_reason == "manual")
            if on_gui and not manual_hold:
                # The countdown ran out with our own window still frontmost: instead
                # of typing into ourselves, hold in a "waiting" pause. The focus
                # watcher locks onto the first app the user switches to and resumes.
                typing_status.pause_reason = "waiting"
                typing_status.waiting_since = time.monotonic()
                typing_status.pause_event.set()
                typing_status.focus_target = None
            else:
                # An explicit Pause pressed during the countdown must survive it,
                # so never overwrite a manual hold with the waiting state.
                typing_status.focus_target = None if on_gui else tok

    start = time.perf_counter()
    prev = ""
    for idx, ch in enumerate(text):
        if is_gui:
            # Pause: block here while paused, until resumed or cancelled.
            while typing_status.pause_event.is_set() and not typing_status.cancel_event.is_set():
                typing_status.state = "paused"
                time.sleep(0.08)
            if typing_status.state == "paused" and not typing_status.cancel_event.is_set():
                typing_status.state = "typing"
            if typing_status.cancel_event.is_set():
                typing_status.state = "aborted"
                return
            typing_status.typed_chars = idx
            typing_status.current_char = ch
            typing_status.elapsed_time = time.perf_counter() - start
            typing_status.effective_wpm = (idx / 5.0) / (typing_status.elapsed_time / 60.0) if typing_status.elapsed_time else 0.0

        time.sleep(keystroke_delay(prev, ch, profile))

        # Double check the cancel event right before the keystroke.
        if is_gui and typing_status.cancel_event.is_set():
            typing_status.state = "aborted"
            return

        maybe_typo(kb, ch, profile)

        if is_gui and typing_status.cancel_event.is_set():
            typing_status.state = "aborted"
            return

        press_char(kb, ch)
        prev = ch

    elapsed = time.perf_counter() - start
    effective_wpm = (len(text) / 5.0) / (elapsed / 60.0) if elapsed else 0.0

    if is_gui:
        typing_status.typed_chars = len(text)
        typing_status.current_char = ""
        typing_status.elapsed_time = elapsed
        typing_status.effective_wpm = effective_wpm
        typing_status.state = "done"
    else:
        print(f"\nDone — {len(text)} chars in {elapsed:.1f}s (~{effective_wpm:.0f} WPM).")


def read_clipboard() -> str:
    """Best-effort cross-platform clipboard read."""
    if sys.platform == "darwin":
        return subprocess.run(["pbpaste"], capture_output=True, text=True).stdout
    if sys.platform.startswith("linux"):
        return subprocess.run(
            ["xclip", "-selection", "clipboard", "-o"],
            capture_output=True, text=True,
        ).stdout
    if sys.platform.startswith("win"):
        # CREATE_NO_WINDOW stops a console window flashing up in the no-console app.
        return subprocess.run(
            ["powershell", "-NoProfile", "-Command", "Get-Clipboard"],
            capture_output=True, text=True,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        ).stdout
    sys.exit("Clipboard read not supported on this platform.")


def resolve_text(args) -> str:
    if args.clipboard:
        return read_clipboard()
    if args.file:
        with open(args.file, "r", encoding="utf-8") as fh:
            return fh.read()
    if args.text == "-" or (args.text is None and not sys.stdin.isatty()):
        return sys.stdin.read()
    if args.text:
        return args.text
    sys.exit("No text given. Pass a string, -f FILE, --clipboard, or pipe via stdin.")


# --- Web server request handler --------------------------------------------
from http.server import BaseHTTPRequestHandler


def _resource_dir() -> str:
    """Directory holding bundled assets (handles PyInstaller's _MEIPASS)."""
    return getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))


_last_gui_request = [0.0]   # monotonic time of the last GUI request (idle watchdog)


class GUIRequestHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # suppress server logging

    def do_GET(self):
        _last_gui_request[0] = time.monotonic()
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/license":
            revalidate_online()   # drops/refreshes the local record (revoked/moved/renewed)
            activated = is_activated()
            payload = {"activated": activated}
            if not activated:
                data = _local_activation()
                if data and _is_expired(data):
                    payload["reason"] = "expired"   # monthly pass lapsed -> show a renew hint
            self.send_json(payload)
        elif path == "/api/status":
            self.send_json({
                "state": typing_status.state,
                "total_chars": typing_status.total_chars,
                "typed_chars": typing_status.typed_chars,
                "current_char": typing_status.current_char,
                "elapsed_time": round(typing_status.elapsed_time, 2),
                "effective_wpm": round(typing_status.effective_wpm, 1),
                "countdown_remaining": round(typing_status.countdown_remaining, 1),
                "pause_reason": typing_status.pause_reason,
            })
        elif parsed.path == "/api/clipboard":
            try:
                clip_text = read_clipboard()
                self.send_json({"text": clip_text})
            except Exception as e:
                self.send_json({"error": str(e)}, 500)
        elif parsed.path == "/api/update":
            self.send_json(check_update())
        elif parsed.path == "/api/permissions":
            self.send_json({"accessibility": accessibility_ok(),
                            "input_monitoring": input_monitoring_ok()})
        elif parsed.path == "/api/profiles":
            self.send_json({"profiles": load_user_profiles()})
        elif not path.startswith("/api/"):
            self.serve_static_path(path)   # index.html, css, js, fonts/*.woff2, svg, ...
        else:
            self.send_error(404, "File Not Found")

    def do_POST(self):
        _last_gui_request[0] = time.monotonic()
        parsed = urlparse(self.path)
        if parsed.path == "/api/license/activate":
            body = self._read_body()
            try:
                params = json.loads(body)
                result = activate(params.get("key", ""))
                self.send_json({"activated": bool(result.get("ok")),
                                "reason": result.get("reason", ""),
                                "detail": result.get("detail", "")})
            except Exception as e:
                self.send_json({"activated": False, "reason": "error", "error": str(e)}, 400)

        elif parsed.path == "/api/type":
            if not is_activated():
                self.send_json({"error": "License required."}, 403)
                return
            if not accessibility_ok():
                self.send_json({"error": "accessibility_required"}, 403)
                return
            body = self._read_body()
            try:
                params = json.loads(body)
                text = params.get("text", "")
                humanize = bool(params.get("humanize", True))
                delay = float(params.get("delay", 5.0))
                focus_guard = bool(params.get("focus_guard", True))

                if not text:
                    self.send_json({"error": "Empty text"}, 400)
                    return

                # Forward the full humanize parameter set (Personas drive all of these).
                _d = TypingProfile()
                profile = TypingProfile(
                    delay_ms=float(params.get("delay_ms", _d.delay_ms)),
                    humanize=humanize,
                    variance=(float(params.get("variance", _d.variance)) if humanize else 0.0),
                    min_delay=float(params.get("min_delay", _d.min_delay)),
                    word_pause=float(params.get("word_pause", _d.word_pause)),
                    sentence_pause=float(params.get("sentence_pause", _d.sentence_pause)),
                    hesitation_prob=float(params.get("hesitation_prob", _d.hesitation_prob)),
                    hesitation=float(params.get("hesitation", _d.hesitation)),
                    typo_prob=(float(params.get("typos", _d.typo_prob)) if humanize else 0.0),
                    pauses=bool(params.get("pauses", humanize)),
                )

                # The server is threaded: serialize the busy-check and thread start
                # so two concurrent /api/type calls can't both pass the check.
                with _start_lock:
                    if typing_status.state in ("countdown", "typing", "paused"):
                        self.send_json({"error": "Already typing"}, 400)
                        return
                    typing_status.state = "countdown"   # claim the slot before the thread spins up
                    typing_status.focus_guard = focus_guard
                    # Our own window is frontmost right now (the user just clicked
                    # Start in it); remember it so the run never locks onto it as
                    # the target. capture_gui:false (queue items after the first)
                    # means "don't recapture": the user is likely IN their target,
                    # and the retained token still protects our window if not.
                    if bool(params.get("capture_gui", True)):
                        typing_status.gui_token = _frontmost_token()
                    typing_status.run_id += 1

                    try:
                        t = threading.Thread(
                            target=type_text,
                            args=(text, profile, delay, True),
                            daemon=True
                        )
                        t.start()
                    except Exception:
                        typing_status.state = "idle"   # release the claimed slot
                        raise

                self.send_json({"status": "started"})
            except Exception as e:
                self.send_json({"error": str(e)}, 400)

        elif parsed.path == "/api/abort":
            typing_status.cancel_event.set()
            self.send_json({"status": "abort_requested"})

        elif parsed.path == "/api/pause":
            if typing_status.state in ("typing", "countdown"):
                typing_status.pause_reason = "manual"
                typing_status.pause_event.set()
            self.send_json({"ok": True})

        elif parsed.path == "/api/resume":
            if typing_status.focus_guard:
                # Resume is clicked inside OUR window, so "current front" is us.
                # Re-enter the waiting pause: the watcher locks onto wherever the
                # user lands next and typing continues there.
                typing_status.gui_token = _frontmost_token()
                typing_status.focus_target = None
                typing_status.pause_reason = "waiting"
                typing_status.waiting_since = time.monotonic()
                # pause_event stays set; the focus watcher clears it on landing.
            else:
                typing_status.pause_event.clear()
                typing_status.pause_reason = ""
            self.send_json({"ok": True})

        elif parsed.path == "/api/open-download":
            body = self._read_body()
            try:
                url = json.loads(body).get("url", "")
                if url.startswith("https://github.com/"):
                    webbrowser.open(url)
                    self.send_json({"ok": True})
                else:
                    self.send_json({"ok": False, "error": "bad url"}, 400)
            except Exception as e:
                self.send_json({"ok": False, "error": str(e)}, 400)

        elif parsed.path == "/api/open-accessibility":
            try:
                if sys.platform == "darwin":
                    subprocess.Popen(["open",
                        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"])
                elif sys.platform.startswith("win"):
                    subprocess.Popen("start ms-settings:privacy", shell=True)
                self.send_json({"ok": True})
            except Exception as e:
                self.send_json({"ok": False, "error": str(e)}, 400)

        elif parsed.path == "/api/open-input-monitoring":
            try:
                if sys.platform == "darwin":
                    request_input_monitoring()   # register + prompt
                    subprocess.Popen(["open",
                        "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"])
                elif sys.platform.startswith("win"):
                    subprocess.Popen("start ms-settings:privacy", shell=True)
                self.send_json({"ok": True})
            except Exception as e:
                self.send_json({"ok": False, "error": str(e)}, 400)

        elif parsed.path == "/api/profiles/save":
            body = self._read_body()
            try:
                p = json.loads(body)
                name = str(p.get("name", "")).strip()[:60]
                settings = p.get("settings", {})
                if not name or not isinstance(settings, dict):
                    self.send_json({"ok": False, "error": "bad profile"}, 400)
                    return
                profs = load_user_profiles()
                profs[name] = settings
                _write_user_profiles(profs)
                self.send_json({"ok": True, "profiles": profs})
            except Exception as e:
                self.send_json({"ok": False, "error": str(e)}, 400)

        elif parsed.path == "/api/profiles/delete":
            body = self._read_body()
            try:
                name = str(json.loads(body).get("name", ""))
                profs = load_user_profiles()
                profs.pop(name, None)
                _write_user_profiles(profs)
                self.send_json({"ok": True, "profiles": profs})
            except Exception as e:
                self.send_json({"ok": False, "error": str(e)}, 400)

        elif parsed.path == "/api/quicktype":
            body = self._read_body()
            try:
                global hotkey_enabled, clipwatch_enabled, _last_clip
                p = json.loads(body)
                hotkey_enabled = bool(p.get("hotkey", hotkey_enabled))
                was = clipwatch_enabled
                clipwatch_enabled = bool(p.get("clipwatch", clipwatch_enabled))
                if clipwatch_enabled and not was:
                    _last_clip = None   # re-baseline so it won't fire on the current clipboard
                self.send_json({"ok": True, "hotkey": hotkey_enabled, "clipwatch": clipwatch_enabled})
            except Exception as e:
                self.send_json({"ok": False, "error": str(e)}, 400)
        else:
            self.send_error(404)

    def _read_body(self) -> str:
        content_length = int(self.headers.get('Content-Length', 0))
        return self.rfile.read(content_length).decode('utf-8')

    _STATIC_MIME = {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf",
        ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon",
    }

    def serve_static_path(self, url_path):
        """Serve any asset under gui/ (index.html, css, js, fonts/*.woff2, svg, ...)."""
        rel = url_path.lstrip("/") or "index.html"
        gui_dir = os.path.realpath(os.path.join(_resource_dir(), "gui"))
        target = os.path.realpath(os.path.join(gui_dir, rel))
        if target != gui_dir and not target.startswith(gui_dir + os.sep):
            self.send_error(403, "Forbidden")   # path-traversal guard
            return
        ctype = self._STATIC_MIME.get(os.path.splitext(target)[1].lower(), "application/octet-stream")
        try:
            with open(target, "rb") as f:
                content = f.read()
        except OSError:
            self.send_error(404, "Not Found")
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def send_json(self, data, status=200):
        content = json.dumps(data).encode('utf-8')
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)


def _bind_server(port):
    from http.server import ThreadingHTTPServer
    for p in range(port, port + 10):
        try:
            httpd = ThreadingHTTPServer(('127.0.0.1', p), GUIRequestHandler)
            return httpd, p
        except OSError:
            continue
    sys.exit("Could not find a free port to run the app server.")


def _unblock_bundle() -> None:
    """Strip Mark-of-the-Web from our own bundled DLLs (Windows, frozen only).

    A zip downloaded in a browser carries a Zone.Identifier stream that Extract
    All propagates onto every file. .NET Framework then REFUSES to load our
    bundled Python.Runtime.dll, so the native window dies on machines that are
    otherwise perfectly healthy (pyinstaller#8294) — while dev boxes and CI,
    whose files were never downloaded, work fine. Deleting the stream is exactly
    what Explorer's "Unblock" checkbox does.
    """
    if not (sys.platform.startswith("win") and getattr(sys, "frozen", False)):
        return
    root = os.path.dirname(sys.executable)
    cleared = 0
    try:
        for dirpath, _dirs, files in os.walk(root):
            for name in files:
                if not name.lower().endswith((".dll", ".exe", ".pyd", ".json")):
                    continue
                try:
                    os.remove(os.path.join(dirpath, name) + ":Zone.Identifier")
                    cleared += 1
                except OSError:
                    pass  # no stream on this file (the usual case)
        if cleared:
            _log_launch(f"unblocked {cleared} bundle file(s) (Mark-of-the-Web)")
    except Exception as exc:
        _log_launch(f"unblock scan failed: {exc!r}")


def _edge_path():
    """Locate msedge.exe (guaranteed present on Windows 10/11)."""
    for c in (
        os.path.expandvars(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"),
        os.path.expandvars(r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"),
        os.path.expandvars(r"%LocalAppData%\Microsoft\Edge\Application\msedge.exe"),
    ):
        if os.path.exists(c):
            return c
    try:
        import winreg
        with winreg.OpenKey(
            winreg.HKEY_LOCAL_MACHINE,
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe",
        ) as k:
            p = winreg.QueryValueEx(k, None)[0]
            if p and os.path.exists(p):
                return p
    except Exception:
        pass
    return None


def run_app(port=5000, force_browser=False):
    """Run the engine server and present the UI in a native desktop window.

    Window strategy: pywebview (WKWebView on macOS, WebView2 on Windows); if that
    fails on Windows, an Edge "--app" window (chromeless, looks native, and Edge is
    guaranteed on Windows 10/11); last resort, a plain browser tab. Every fallback
    is logged to launch.log so a buyer's machine can tell us what went wrong.
    """
    httpd, p = _bind_server(port)
    url = f"http://127.0.0.1:{p}"
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    start_global_abort_listener()   # CGEventTap for the global stop runs on Accessibility

    if not force_browser:
        try:
            _unblock_bundle()   # MOTW-blocked DLLs are the #1 frozen-only failure
            if sys.platform.startswith("win"):
                # pywebview silently retries with coreclr when netfx fails, which
                # masks the real error AND needs a .NET Core install the buyer
                # won't have. Win10/11 ship .NET Framework 4.8: pin netfx.
                os.environ.setdefault("PYTHONNET_RUNTIME", "netfx")
            import webview
            webview.create_window(
                "Human Typer",
                url,
                width=1180,
                height=860,
                min_size=(960, 680),
                background_color="#0b0b12",
            )
            webview.start()
            return
        except ImportError as exc:
            _log_launch(f"pywebview import failed: {exc!r}")
            print("pywebview not installed — opening in your browser instead.")
            print("For the native app window, run: pip install pywebview")
        except Exception as exc:
            _log_launch(f"native window failed: {exc!r}")
            print(f"Native window unavailable ({exc}); opening in your browser instead.")

    edge_proc = None
    if not force_browser and sys.platform.startswith("win"):
        edge = _edge_path()
        if edge:
            try:
                # A dedicated profile dir forces a NEW Edge process (not a handoff
                # to a running instance), so this window looks and lives like a
                # native app: our PID is the window, and its exit means "closed".
                # Per-PORT dir so a second app launch (which binds the next port)
                # gets its own Edge process too. Local, not roaming: Chromium
                # profiles are big and not roaming-safe.
                base = os.environ.get("LOCALAPPDATA") or _config_dir()
                profile = os.path.join(base, "HumanTyper", f"edge-profile-{p}")
                edge_proc = subprocess.Popen([
                    edge, f"--app={url}", f"--user-data-dir={profile}",
                    "--no-first-run", "--no-default-browser-check",
                    "--disable-sync", "--new-window", "--window-size=1200,900",
                    "--disk-cache-size=10485760",
                ])
                _log_launch("opened as an Edge app window")
            except Exception as exc:
                edge_proc = None
                _log_launch(f"edge app window failed: {exc!r}")
    if edge_proc is None:
        _log_launch("opened in the default browser")
        webbrowser.open(url)

    print(f"Human Typer is running at {url}")
    print("Press Ctrl-C here to quit.")
    try:
        if edge_proc is not None:
            t0 = time.monotonic()
            edge_proc.wait()    # app-window closed -> quit like a native app would
            if time.monotonic() - t0 < 5:
                # Exited instantly: Edge handed the URL to another process despite
                # the dedicated profile (e.g. an enterprise UserDataDir policy).
                # Keep serving while the GUI shows signs of life (it pings every
                # 45s), then exit instead of lingering invisibly forever.
                _log_launch("edge app process exited immediately; watching GUI activity")
                baseline = _last_gui_request[0]
                while True:
                    time.sleep(15)
                    last = _last_gui_request[0]
                    if last == baseline and time.monotonic() - t0 > 180:
                        # No window ever talked to us after the handoff.
                        _log_launch("no GUI connected after handoff; exiting")
                        break
                    if last != baseline and time.monotonic() - last > 1800:
                        _log_launch("no GUI activity for 30 minutes; exiting")
                        break
        else:
            while True:
                time.sleep(1)
    except KeyboardInterrupt:
        print("\nShutting down.")
    finally:
        httpd.shutdown()


def run_diag(out_path=None) -> int:
    """Self-check the (frozen) bundle: can the native-window stack even import?

    Writes JSON to out_path (a windowed exe has no stdout) and returns 0 when all
    modules REQUIRED on this platform import, 2 otherwise. CI runs the built exe
    with --diag so a bundle that can't create the native window fails the build
    instead of shipping; on a buyer's machine the same file explains a fallback.
    """
    info = {
        "version": APP_VERSION,
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "frozen": bool(getattr(sys, "frozen", False)),
        "imports": {},
        "webview2_runtime": None,
        "edge_path": None,
    }
    is_win = sys.platform.startswith("win")
    if is_win:
        # Same runtime pin run_app uses, so the diag exercises the shipped config.
        os.environ.setdefault("PYTHONNET_RUNTIME", "netfx")
    required = ["webview"] + (["clr_loader", "clr"] if is_win else [])
    for mod in ["webview", "clr_loader", "clr"] if is_win else ["webview"]:
        try:
            __import__(mod)
            info["imports"][mod] = "ok"
        except Exception as e:
            info["imports"][mod] = f"FAIL: {e!r}"
    if is_win:
        info["edge_path"] = _edge_path()
        try:
            import winreg
            probes = [
                (winreg.HKEY_LOCAL_MACHINE,
                 r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"),
                (winreg.HKEY_LOCAL_MACHINE,
                 r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"),
                (winreg.HKEY_CURRENT_USER,
                 r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"),
            ]
            for hive, key in probes:
                try:
                    with winreg.OpenKey(hive, key) as k:
                        pv = winreg.QueryValueEx(k, "pv")[0]
                        if pv and pv != "0.0.0.0":
                            info["webview2_runtime"] = pv
                            break
                except OSError:
                    continue
        except Exception as e:
            info["webview2_runtime"] = f"probe failed: {e!r}"
        if getattr(sys, "frozen", False):
            # Count bundle files still carrying Mark-of-the-Web (a browser-download
            # stream that makes .NET refuse our DLLs). Non-destructive evidence;
            # the app strips these itself on launch (_unblock_bundle).
            blocked = 0
            try:
                for dirpath, _dirs, files in os.walk(os.path.dirname(sys.executable)):
                    for name in files:
                        if name.lower().endswith((".dll", ".exe", ".pyd")):
                            if os.path.exists(os.path.join(dirpath, name) + ":Zone.Identifier"):
                                blocked += 1
            except Exception:
                blocked = -1
            info["motw_blocked_files"] = blocked
    ok = all(info["imports"].get(m) == "ok" for m in required)
    info["ok"] = ok
    payload = json.dumps(info, indent=2)
    print(payload)
    if out_path:
        try:
            with open(out_path, "w", encoding="utf-8") as fh:
                fh.write(payload)
        except Exception:
            pass
    _log_launch(f"diag: ok={ok} imports={info['imports']} webview2={info['webview2_runtime']}")
    return 0 if ok else 2


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Simulate human typing with real OS keystrokes.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("text", nargs="?", help="Text to type, or '-' for stdin.")
    p.add_argument("-f", "--file", help="Read text from a file.")
    p.add_argument("--clipboard", action="store_true", help="Read text from the clipboard.")
    p.add_argument("--gui", action="store_true", help="Launch the desktop app window.")
    p.add_argument("--browser", action="store_true",
                   help="With --gui, use the system browser instead of a native window.")

    p.add_argument("--delay-ms", type=float, default=None, dest="delay_ms",
                   help="Base delay between keystrokes in ms (2-200). Overrides --wpm.")
    p.add_argument("--wpm", type=float, default=65.0,
                   help="Target words per minute (used only if --delay-ms is omitted).")
    p.add_argument("--no-humanize", action="store_true",
                   help="Type at a constant speed (disable rhythm, pauses, and typos).")
    p.add_argument("--variance", type=float, default=0.35,
                   help="Per-key timing jitter as a fraction of the mean (when humanized).")
    p.add_argument("--typos", type=float, default=0.0,
                   help="Per-char probability of a typo+self-correction (e.g. 0.02).")
    p.add_argument("--delay", type=float, default=5.0,
                   help="Countdown seconds before typing starts.")
    p.add_argument("--tabs", action="store_true",
                   help="Form mode: press Tab between lines (Tab-jump through fields).")
    p.add_argument("--diag", action="store_true",
                   help="Self-check the bundle (imports, WebView2) and exit.")
    p.add_argument("--diag-out", default=None,
                   help="With --diag, also write the JSON report to this file.")
    return p


def main() -> None:
    args = build_parser().parse_args()

    if args.diag:
        sys.exit(run_diag(args.diag_out))

    # In a packaged app launched from Finder/Explorer there is no controlling
    # terminal (isatty() is False), so treat "frozen + no input args" as GUI too.
    no_input_args = args.text is None and args.file is None and not args.clipboard
    is_frozen = getattr(sys, "frozen", False)
    is_gui_triggered = args.gui or (
        no_input_args and (sys.stdin.isatty() or is_frozen)
    )

    if is_gui_triggered:
        run_app(force_browser=args.browser)
        return

    text = resolve_text(args)
    if not text:
        sys.exit("Resolved text is empty — nothing to type.")
    if args.tabs:
        text = text.replace("\r\n", "\n").replace("\n", "\t")  # form mode: Tab between fields

    if args.delay_ms is not None:
        delay_ms = args.delay_ms
    else:
        delay_ms = 12000.0 / max(args.wpm, 1.0)  # convert WPM -> ms/char
    humanize = not args.no_humanize

    profile = TypingProfile(
        delay_ms=delay_ms,
        humanize=humanize,
        variance=args.variance if humanize else 0.0,
        typo_prob=args.typos if humanize else 0.0,
        pauses=humanize,
    )
    start_global_abort_listener()  # CLI also benefits from the global Esc abort
    try:
        type_text(text, profile, countdown=args.delay)
    except KeyboardInterrupt:
        print("\nInterrupted.")


if __name__ == "__main__":
    main()
