FROM rust:1-bookworm AS native
WORKDIR /native
COPY packages/redtrace-engine/src/native/Cargo.toml packages/redtrace-engine/src/native/Cargo.lock packages/redtrace-engine/src/native/build.rs ./
COPY packages/redtrace-engine/src/native/src ./src
RUN cargo build --release --locked

FROM node:24-bookworm-slim

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /redtrace
COPY . .
COPY --from=native /native/target/release/libredtrace_native.so /redtrace/packages/redtrace-engine/src/native/redtrace_native.node
RUN node scripts/build-native.mjs --prebuilt
RUN python3 -m venv /opt/redtrace/benchmark-venv \
    && /opt/redtrace/benchmark-venv/bin/python3 -m pip install --no-cache-dir -r skills/tsecbench-api/requirements.txt
RUN npm ci --prefix packages/redtrace-engine \
    && chmod +x build-dsh.sh start-redtrace.sh \
    && ./build-dsh.sh

ENV HOME=/root TZ=Asia/Shanghai \
    REDTRACE_BENCHMARK_PYTHON=/opt/redtrace/benchmark-venv/bin/python3
EXPOSE 8000
CMD ["sh", "-c", "host=\"$(node scripts/container-host.mjs)\" && exec ./start-redtrace.sh --config /redtrace/redtrace.yaml --host \"$host\" --port 8000"]
