from pathlib import Path

import click
import uvicorn

from redtrace.dispatcher.config import DispatchConfig
from redtrace.dispatcher.logging import configure_logging
from redtrace.dispatcher.scheduler.loop import DispatcherLoop
from redtrace.dispatcher.singleton import (
    DispatcherAlreadyRunning,
    DispatcherInstanceLock,
)
from redtrace.server import db
from redtrace.skill_home import ensure_agent_skill_roots


@click.group()
def main():
    """RedTrace - agent-driven security research and evidence runtime."""


@main.command()
@click.option("--host", default="127.0.0.1", show_default=True, help="Bind host")
@click.option("--port", default=8000, show_default=True, help="Bind port")
@click.option(
    "--db-path",
    type=click.Path(),
    default=str(db.DEFAULT_DB),
    show_default=True,
    help="SQLite database path",
)
@click.option("--log-level", default="info", show_default=True, help="Uvicorn log level")
@click.option("--access-log/--no-access-log", default=False, show_default=True, help="Enable Uvicorn access log")
def serve(host: str, port: int, db_path: str, log_level: str, access_log: bool):
    """Start the RedTrace API server."""
    db.configure(Path(db_path))
    from redtrace.server.app import app

    uvicorn.run(
        app,
        host=host,
        port=port,
        log_level=log_level.lower(),
        access_log=access_log,
    )


@main.command()
@click.option(
    "--config",
    "config_path",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    required=True,
    help="Dispatcher config path",
)
@click.option("--once", is_flag=True, help="Run one scheduling iteration and exit")
@click.option(
    "--startup-healthcheck-only",
    is_flag=True,
    help="Run startup worker healthchecks and exit",
)
@click.option("--log-level", default="INFO", show_default=True, help="Log level")
def dispatch(config_path: Path, once: bool, startup_healthcheck_only: bool, log_level: str):
    """Run the RedTrace dispatcher."""
    configure_logging(log_level, bare=startup_healthcheck_only)
    try:
        config = DispatchConfig.load(config_path)
        if config.runtime.execution == "local":
            # The dispatcher process owns machine-level setup: point every
            # agent's user-level Skill root at the canonical store so Claude,
            # Codex and Pi load RedTrace Skills natively. Library code and
            # tests never touch the user home.
            ensure_agent_skill_roots(config.paths.layout().skills)
        if startup_healthcheck_only:
            loop = DispatcherLoop(config_path)
            loop.run_startup_healthchecks_only()
            return
        with DispatcherInstanceLock(
            config.server,
            config.paths.layout().runtime / "locks",
        ):
            loop = DispatcherLoop(config_path)
            loop.run(once=once)
    except (DispatcherAlreadyRunning, RuntimeError) as exc:
        raise click.ClickException(str(exc)) from exc
