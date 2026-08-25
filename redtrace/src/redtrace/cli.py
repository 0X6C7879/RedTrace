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
from redtrace.startup import StartupError, run as run_startup


@click.group()
def main():
    """RedTrace - agent-driven security research and evidence runtime."""


@main.command()
@click.option(
    "--host",
    default="127.0.0.1",
    show_default=True,
    help="Bind host",
)
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
    help="Dispatcher config path (default: <checkout>/redtrace.yaml)",
)
@click.option(
    "--host",
    default="127.0.0.1",
    envvar="REDTRACE_HOST",
    show_default=True,
    help="Bind host",
)
@click.option(
    "--port",
    default=8000,
    envvar="REDTRACE_PORT",
    show_default=True,
    type=click.IntRange(1, 65535),
    help="Bind port",
)
def start(config_path: Path | None, host: str, port: int):
    """Start the RedTrace Server and Dispatcher together."""
    try:
        raise SystemExit(run_startup(config=config_path, host=host, port=port))
    except StartupError as exc:
        raise click.ClickException(str(exc)) from exc


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
        if any(w.enabled and w.provider != "mock" for w in config.workers):
            raise RuntimeError(
                "provider Workers are scheduled by the DSH runtime; use `redtrace start`"
            )
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
