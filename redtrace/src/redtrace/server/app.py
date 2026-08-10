from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from redtrace import __version__
from redtrace.server import db
from redtrace.server.operations import (
    reconcile_interrupted_audit_runs,
    resume_pending_tasks,
)
from redtrace.server.routers import audit, blackboard, capabilities, export, hints, intents, operations, plugins, projects, settings, workers

STATIC_DIR = Path(__file__).parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.configure(db.DEFAULT_DB)
    reconcile_interrupted_audit_runs()
    resume_pending_tasks()
    yield


app = FastAPI(
    title="RedTrace",
    description="Fact-graph based collaborative exploration protocol",
    version=__version__,
    lifespan=lifespan,
)

app.include_router(settings.router)
app.include_router(projects.router)
app.include_router(hints.router)
app.include_router(intents.router)
app.include_router(export.router)
app.include_router(audit.router)
app.include_router(capabilities.router)
app.include_router(blackboard.router)
app.include_router(operations.router)
app.include_router(workers.router)
app.include_router(plugins.router)


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
