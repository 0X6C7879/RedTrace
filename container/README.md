The default Compose deployment builds this Kali Linux worker image locally:

```bash
docker compose build redtrace-worker-image
```

Standalone builds support both `linux/amd64` and `linux/arm64`:

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  -f container/Dockerfile container
```
