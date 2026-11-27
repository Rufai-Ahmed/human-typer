#!/usr/bin/env python3
"""Generate Human Typer license keys.

Writes LICENSE_KEYS.txt, the plaintext keys (PRIVATE; gitignored). Load them into
Supabase with `node landing/seed_supabase.mjs` and they become the sale pool:
checkout emails pool keys to buyers by itself, so never hand one of these out. To
give someone a key (bank transfer, replacement, gift), use the admin page:
Generate keys, give to a buyer. Validation is online (Supabase), so nothing is
embedded in the app.

Usage:
  python gen_licenses.py [count]        # default 50 (REPLACES the file)
  python gen_licenses.py --add N        # append N new keys, keep existing ones
"""
import secrets
import sys

# Unambiguous alphabet: no 0/O/1/I/L to avoid buyer typos.
ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
KEYS_FILE = "LICENSE_KEYS.txt"


def _group(n=5):
    return "".join(secrets.choice(ALPHABET) for _ in range(n))


def make_key():
    return f"HT-{_group()}-{_group()}-{_group()}"


def read_existing_keys():
    try:
        with open(KEYS_FILE, "r", encoding="utf-8") as fh:
            return [m for ln in fh for m in [_extract(ln)] if m]
    except FileNotFoundError:
        return []


def _extract(line):
    line = line.strip()
    if line.startswith("#") or not line:
        return None
    return line.split(". ", 1)[-1] if ". " in line else line


def write(keys):
    with open(KEYS_FILE, "w", encoding="utf-8") as fh:
        fh.write("# Human Typer license keys — PRIVATE. Do not commit or publish.\n")
        fh.write("# Sale pool once seeded: checkout emails these by itself, so never hand one out.\n")
        fh.write("# To give someone a key use the admin page (Generate keys, give to a buyer).\n")
        fh.write(f"# Total: {len(keys)}\n\n")
        for i, k in enumerate(keys, 1):
            fh.write(f"{i:>3}. {k}\n")


def main():
    args = sys.argv[1:]
    add_mode = "--add" in args
    nums = [a for a in args if a.isdigit()]
    count = int(nums[0]) if nums else 50

    existing = read_existing_keys() if add_mode else []
    new = set()
    while len(new) < count:
        new.add(make_key())
    keys = existing + sorted(new)

    write(keys)
    print(f"{'Added' if add_mode else 'Generated'} {count} keys ({len(keys)} total) -> {KEYS_FILE}")
    print("Next: seed them into Supabase with  node landing/seed_supabase.mjs")


if __name__ == "__main__":
    main()
