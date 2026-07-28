# CTF Misc - Lightweight Automation Scripts (Original Format)

These scripts are small utilities aligned with existing MISC technique style.

## 1) Auto-encoding chain decoder (safe attempt loop)

```python
import base64, codecs, urllib.parse

def try_decode(s):
    attempts = []
    # base64
    try:
        d = base64.b64decode(s).decode('utf-8', errors='ignore')
        attempts.append(('base64', d))
    except Exception:
        pass
    # base32
    try:
        d = base64.b32decode(s).decode('utf-8', errors='ignore')
        attempts.append(('base32', d))
    except Exception:
        pass
    # hex
    try:
        d = bytes.fromhex(s).decode('utf-8', errors='ignore')
        attempts.append(('hex', d))
    except Exception:
        pass
    # rot13
    try:
        d = codecs.decode(s, 'rot_13')
        attempts.append(('rot13', d))
    except Exception:
        pass
    # url
    try:
        d = urllib.parse.unquote(s)
        if d != s:
            attempts.append(('url', d))
    except Exception:
        pass
    return attempts
```

## 2) Nested archive unpack loop (zip/7z/gz/bz2/xz)

```bash
while f=$(ls *.tar* *.gz *.bz2 *.xz *.zip *.7z 2>/dev/null|head -1) && [ -n "$f" ]; do
    7z x -y "$f" && rm "$f"
done
```

## 3) Quick artifact classifier (heuristic)

```python
def classify_artifact(text):
    if any(k in text.lower() for k in ['flag{','ctf{','key=','secret=']):
        return 'likely_flag'
    if set(text.strip()) <= set('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567='):
        return 'maybe_base32'
    if all(c in '0123456789abcdefABCDEF' for c in text.strip()) and len(text.strip())%2==0:
        return 'maybe_hex'
    return 'unknown'
```
