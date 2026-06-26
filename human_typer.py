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
import random
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
    state: str = "idle"         # "idle", "countdown", "typing", "done", "aborted"
    text: str = ""
    total_chars: int = 0
    typed_chars: int = 0
    current_char: str = ""
    elapsed_time: float = 0.0
    effective_wpm: float = 0.0
    countdown_remaining: float = 0.0
    cancel_event: threading.Event = None

typing_status = TypingState()
typing_status.cancel_event = threading.Event()


# --- Global Esc emergency stop ---------------------------------------------
_abort_listener = None
_ESC_KEYCODE = 53  # macOS virtual keycode for Esc


def _macos_esc_poller() -> None:
    """Poll the global Esc key state via CoreGraphics (thread-safe, no TSM).

    pynput's listener queries Text Services from its own thread, which crashes
    inside a Cocoa app; polling CGEventSourceKeyState sidesteps that entirely.
    """
    while True:
        if typing_status.state in ("countdown", "typing"):
            try:
                # Check both source states (combined session + HID) for reliability.
                if cg.CGEventSourceKeyState(0, _ESC_KEYCODE) or cg.CGEventSourceKeyState(1, _ESC_KEYCODE):
                    typing_status.cancel_event.set()
            except Exception:
                pass
            time.sleep(0.03)   # responsive while a run is active
        else:
            time.sleep(0.25)   # idle: barely wake the CPU when nothing's running


def start_global_abort_listener() -> bool:
    """Watch for Esc globally so the user can abort from any app.

    Mirrors goghostwriter's emergency stop: pressing Esc while a countdown or
    typing run is active cancels it, even when another window has focus.
    """
    global _abort_listener
    if _abort_listener is not None:
        return False

    # macOS: poll CoreGraphics key state (pynput's listener is unsafe here).
    if IS_MAC and HAS_COREGRAPHICS:
        _abort_listener = threading.Thread(target=_macos_esc_poller, daemon=True)
        _abort_listener.start()
        return True

    # Windows/Linux: pynput global listener.
    if HAS_PYNPUT:
        def on_press(key):
            if key == Key.esc and typing_status.state in ("countdown", "typing"):
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
APP_VERSION = "1.3.0"
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


def _post_activate(key: str, timeout: float = 12.0):
    """Ask the server to activate/re-check a key for this device.

    Returns {"ok": True} / {"ok": False, "reason": "..."}, or None if the server
    is unreachable (offline).
    """
    payload = json.dumps({"key": key, "device_id": _machine_id()}).encode("utf-8")
    req = urllib.request.Request(
        ACTIVATE_URL, data=payload,
        headers={"Content-Type": "application/json"}, method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode("utf-8"))
        except Exception:
            return {"ok": False, "reason": "invalid"}
    except Exception:
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


def is_activated() -> bool:
    """Fast local gate: a saved activation bound to THIS machine. No network."""
    data = _local_activation()
    return bool(data and data.get("key") and data.get("device_id") == _machine_id())


def revalidate_online() -> None:
    """Re-check the saved key with the server; drop it if revoked/invalid/moved.

    Fail-open when offline so a buyer without internet can still use the app.
    """
    data = _local_activation()
    if not data or not data.get("key"):
        return
    res = _post_activate(data["key"], timeout=6.0)
    if res is not None and not res.get("ok"):
        _clear_activation()


def activate(key: str) -> dict:
    """Activate a key for this device via the server. Returns {ok, reason?}."""
    key = (key or "").strip()
    if not key:
        return {"ok": False, "reason": "missing"}
    res = _post_activate(key)
    if res is None:
        return {"ok": False, "reason": "offline"}
    if res.get("ok"):
        try:
            with open(_activation_file(), "w", encoding="utf-8") as fh:
                json.dump({"key": _normalize_key(key), "device_id": _machine_id()}, fh)
        except Exception:
            pass
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
        with urllib.request.urlopen(req, timeout=6) as resp:
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

    start = time.perf_counter()
    prev = ""
    for idx, ch in enumerate(text):
        if is_gui:
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


class GUIRequestHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # suppress server logging

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/" or parsed.path == "/index.html":
            self.serve_static("index.html", "text/html")
        elif parsed.path == "/style.css":
            self.serve_static("style.css", "text/css")
        elif parsed.path == "/app.js":
            self.serve_static("app.js", "application/javascript")
        elif parsed.path == "/api/license":
            revalidate_online()   # drops the local record if the key was revoked/moved
            self.send_json({"activated": is_activated()})
        elif parsed.path == "/api/status":
            self.send_json({
                "state": typing_status.state,
                "total_chars": typing_status.total_chars,
                "typed_chars": typing_status.typed_chars,
                "current_char": typing_status.current_char,
                "elapsed_time": round(typing_status.elapsed_time, 2),
                "effective_wpm": round(typing_status.effective_wpm, 1),
                "countdown_remaining": round(typing_status.countdown_remaining, 1)
            })
        elif parsed.path == "/api/clipboard":
            try:
                clip_text = read_clipboard()
                self.send_json({"text": clip_text})
            except Exception as e:
                self.send_json({"error": str(e)}, 500)
        elif parsed.path == "/api/update":
            self.send_json(check_update())
        else:
            self.send_error(404, "File Not Found")

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/license/activate":
            body = self._read_body()
            try:
                params = json.loads(body)
                result = activate(params.get("key", ""))
                self.send_json({"activated": bool(result.get("ok")), "reason": result.get("reason", "")})
            except Exception as e:
                self.send_json({"activated": False, "reason": "error", "error": str(e)}, 400)

        elif parsed.path == "/api/type":
            if not is_activated():
                self.send_json({"error": "License required."}, 403)
                return
            body = self._read_body()
            try:
                params = json.loads(body)
                text = params.get("text", "")
                humanize = bool(params.get("humanize", True))
                delay_ms = float(params.get("delay_ms", 100.0))
                variance = float(params.get("variance", 0.35))
                typo_prob = float(params.get("typos", 0.0))
                delay = float(params.get("delay", 5.0))

                if not text:
                    self.send_json({"error": "Empty text"}, 400)
                    return

                if typing_status.state in ("countdown", "typing"):
                    self.send_json({"error": "Already typing"}, 400)
                    return

                profile = TypingProfile(
                    delay_ms=delay_ms,
                    humanize=humanize,
                    variance=variance if humanize else 0.0,
                    typo_prob=typo_prob if humanize else 0.0,
                    pauses=humanize,
                )

                t = threading.Thread(
                    target=type_text,
                    args=(text, profile, delay, True),
                    daemon=True
                )
                t.start()

                self.send_json({"status": "started"})
            except Exception as e:
                self.send_json({"error": str(e)}, 400)

        elif parsed.path == "/api/abort":
            typing_status.cancel_event.set()
            self.send_json({"status": "abort_requested"})

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
        else:
            self.send_error(404)

    def _read_body(self) -> str:
        content_length = int(self.headers.get('Content-Length', 0))
        return self.rfile.read(content_length).decode('utf-8')

    def serve_static(self, filename, content_type):
        file_path = os.path.join(_resource_dir(), "gui", filename)
        try:
            with open(file_path, "rb") as f:
                content = f.read()
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)
        except Exception:
            self.send_error(404, f"File {filename} not found")

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


def run_app(port=5000, force_browser=False):
    """Run the engine server and present the UI in a native desktop window.

    Uses pywebview for a real window (WKWebView on macOS, WebView2 on Windows),
    falling back to the system browser if pywebview is unavailable.
    """
    httpd, p = _bind_server(port)
    url = f"http://127.0.0.1:{p}"
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    start_global_abort_listener()

    if not force_browser:
        try:
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
        except ImportError:
            print("pywebview not installed — opening in your browser instead.")
            print("For the native app window, run: pip install pywebview")
        except Exception as exc:
            print(f"Native window unavailable ({exc}); opening in your browser instead.")

    print(f"Human Typer is running at {url}")
    print("Press Ctrl-C here to quit.")
    webbrowser.open(url)
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nShutting down.")
    finally:
        httpd.shutdown()


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
    return p


def main() -> None:
    args = build_parser().parse_args()

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
