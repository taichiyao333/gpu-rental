"""check_csp_violations.py - 全ページの外部スクリプト・CSP違反チェック"""
import re, os

BASE = os.path.dirname(os.path.abspath(__file__))

pages = [
    "public/portal/index.html",
    "public/workspace/index.html",
    "public/lobby/index.html",
    "public/admin/index.html",
    "public/mypage/index.html",
    "public/provider/index.html",
]

# CSP で許可されている外部ドメイン
ALLOWED_SCRIPT_DOMAINS = [
    "translate.google.com",
    "translate.googleapis.com",
    "www.google.com",
    "www.gstatic.com",
    "js.stripe.com",
    "fonts.googleapis.com",
    "fonts.gstatic.com",
]

script_src_pat = re.compile(r'<script[^>]+src=["\']([^"\']+)["\']', re.IGNORECASE)

print("=" * 65)
print("  CSP Violation / External Script Checker")
print("=" * 65)

violations = {}

for p in pages:
    full = os.path.join(BASE, p)
    if not os.path.exists(full):
        continue
    with open(full, encoding="utf-8", errors="ignore") as f:
        c = f.read()
    
    issues = []
    for m in script_src_pat.finditer(c):
        src = m.group(1)
        # Check if it's an external HTTP(S) URL
        if src.startswith("http://") or src.startswith("https://") or src.startswith("//"):
            # Remove protocol
            domain = src.lstrip("/").split("/")[0].split("?")[0]
            allowed = any(allowed in domain for allowed in ALLOWED_SCRIPT_DOMAINS)
            if not allowed:
                issues.append(f"BLOCKED BY CSP: {src}")
            else:
                issues.append(f"OK (allowed):   {src}")
        else:
            issues.append(f"OK (local):     {src}")
    
    if issues:
        print(f"\n  {p}:")
        for i in issues:
            marker = "  ❌" if "BLOCKED" in i else "  ✅"
            print(f"  {marker} {i}")

print("\n" + "=" * 65)
