"""Run the identity API with lifespan-managed Mongo persistence and safe errors."""

import logging
from contextlib import asynccontextmanager
from collections.abc import AsyncIterator
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.responses import Response as AnyResponse
from pymongo import AsyncMongoClient
from pymongo.errors import DuplicateKeyError, PyMongoError
from app.core.config import Settings
from app.core.database import create_indexes
from app.core.seed import seed_database
from app.routers.identity import router
from app.routers.portfolios import router as portfolios_router
from app.repositories.portfolios import PortfolioRepository
from app.repositories.applications import ApplicationRepository
from app.routers.applications import router as applications_router
from app.routers.dashboard import router as dashboard_router
from app.routers.reports import router as reports_router
from app.routers.admin import router as admin_router

logger = logging.getLogger(__name__)


def create_app(settings: Settings | None = None) -> FastAPI:
    """Build an independently configured API instance, without import-time I/O."""
    config = settings or Settings()

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        """Open one loop-owned pool, seed once, and always close resources."""
        config.validate_secret()
        client = AsyncMongoClient(config.MONGODB_URI, tz_aware=True, serverSelectionTimeoutMS=5000)
        application.state.db = client.get_database(config.MONGODB_DB)
        try:
            await client.admin.command("ping")
            await create_indexes(application.state.db)
            await PortfolioRepository(application.state.db).ensure_indexes()
            await ApplicationRepository(application.state.db).ensure_indexes()
            if config.SEED_ON_STARTUP:
                await seed_database(application.state.db)
            yield
        finally:
            await client.close()

    application = FastAPI(title="Application Portfolio Portal", version="1.0.0",
        description="Persisted enterprise identity and profile API.", lifespan=lifespan)
    application.state.settings = config
    application.add_middleware(CORSMiddleware, allow_origins=config.cors_origins,
        allow_credentials=False, allow_methods=["GET", "POST", "PUT", "DELETE"], allow_headers=["Authorization", "Content-Type"])
    application.include_router(router)
    application.include_router(portfolios_router)
    application.include_router(applications_router)
    application.include_router(dashboard_router)
    application.include_router(reports_router)
    application.include_router(admin_router)

    @application.middleware("http")
    async def no_store(request: Request, call_next) -> AnyResponse:
        """Prevent protected account or token responses from entering browser caches."""
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        return response

    @application.get("/api/health", tags=["Health"], summary="Process liveness")
    def health() -> dict[str, str]:
        """Report process liveness without querying databases or secrets."""
        return {"status": "ok"}

    @application.exception_handler(DuplicateKeyError)
    async def duplicate_error(request: Request, error: DuplicateKeyError) -> JSONResponse:
        """Map database uniqueness conflicts without exposing stored values."""
        return JSONResponse(status_code=409, content={"detail": "This record already exists."})

    @application.exception_handler(PyMongoError)
    async def database_error(request: Request, error: PyMongoError) -> JSONResponse:
        """Report persistence outages safely instead of pretending a write succeeded."""
        logger.error("Database operation failed: %s", type(error).__name__)
        return JSONResponse(status_code=503, content={"detail": "The service is unavailable. Please try again."})

    @application.exception_handler(Exception)
    async def unexpected_error(request: Request, error: Exception) -> JSONResponse:
        """Return a safe failure without logging credential-bearing payloads."""
        logger.error("Unexpected API failure: %s", type(error).__name__)
        return JSONResponse(status_code=500, content={"detail": "An unexpected error occurred."})

    return application


app = create_app()
