"""check_favicon.py"""
import os

BASE = os.path.dirname(os.path.abspath(__file__))

pages = [
    "public/portal/index.html",
    "public/workspace/index.html",
    "public/admin/index.html",
    "public/provider/index.html",
    "public/mypage/index.html",
    "public/lobby/index.html",
]

for p in pages:
    full = os.path.join(BASE, p)
    if not os.path.exists(full):
        print(f"  MISSING  {p}")
        continue
    with open(full, encoding="utf-8", errors="ignore") as f:
        c = f.read()
    has_favicon = "favicon" in c.lower() or 'rel="icon"' in c
    print(f'  {"OK":10} {p}' if has_favicon else f'  {"NO-ICON":10} {p}')
