FROM ghcr.io/astral-sh/uv:python3.13-trixie

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
