FROM kalilinux/kali-rolling:latest

ARG DEBIAN_FRONTEND=noninteractive

COPY --from=ghcr.io/astral-sh/uv:0.8.9 /uv /uvx /usr/local/bin/

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        python3 \
        python3-venv \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

COPY ./redtrace/pyproject.toml /redtrace/pyproject.toml
COPY ./redtrace/uv.lock /redtrace/uv.lock
WORKDIR /redtrace
RUN uv sync --frozen --no-install-project -i https://mirrors.aliyun.com/pypi/simple/

COPY ./redtrace /redtrace
RUN uv sync --frozen -i https://mirrors.aliyun.com/pypi/simple/

ENV HOME=/root \
    TZ=Asia/Shanghai
