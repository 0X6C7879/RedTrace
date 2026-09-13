FROM node:24.21.0-bookworm-slim

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /redtrace
COPY . .
RUN npm ci --prefix packages/redtrace-engine \
    && corepack enable \
    && chmod +x build-dsh.sh start-redtrace.sh \
    && ./build-dsh.sh

ENV HOME=/root TZ=Asia/Shanghai
EXPOSE 8000
CMD ["./start-redtrace.sh", "--config", "/redtrace/redtrace.yaml", "--host", "0.0.0.0", "--port", "8000"]
