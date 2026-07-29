FROM ghcr.io/astral-sh/uv:python3.13-trixie

RUN apt-get update \
    && apt-get install -y --no-install-recommends npm \
    && npm install -g \
        @openai/codex@0.118.0 \
        @anthropic-ai/claude-code@2.1.98 \
        @mariozechner/pi-coding-agent@0.73.0 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

COPY ./redtrace/pyproject.toml /redtrace/pyproject.toml
COPY ./redtrace/uv.lock /redtrace/uv.lock
WORKDIR /redtrace
RUN uv sync --frozen --no-install-project -i https://mirrors.aliyun.com/pypi/simple/

COPY ./redtrace /redtrace
COPY ./skills /redtrace/skills
COPY ./mcp /redtrace/mcp
COPY ./plugins /redtrace/plugins
RUN uv sync --frozen -i https://mirrors.aliyun.com/pypi/simple/

ENV TZ=Asia/Shanghai
