"""Create isolated real Mongo databases through the production application lifespan."""

from collections.abc import AsyncIterator
from uuid import uuid4
import os
import pytest
from httpx import ASGITransport, AsyncClient
from app.core.config import Settings
from app.main import create_app
from app.repositories.identity import IdentityRepository
from app.repositories.audit import AuditRepository
from app.services.identity import IdentityService


@pytest.fixture
async def application() -> AsyncIterator:
    """Seed a unique test-only database and remove only that database after the test."""
    settings = Settings(MONGODB_URI=os.environ.get("MONGODB_URI", "mongodb://127.0.0.1:27017"),
        MONGODB_DB=f"portal_test_{uuid4().hex}", JWT_SECRET="test-only-identity-signing-key-not-for-deployment", SEED_ON_STARTUP=True)
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        try:
            yield app
        finally:
            await app.state.db.client.drop_database(settings.MONGODB_DB)


@pytest.fixture
async def db(application):
    """Expose the same real pool used by in-process HTTP requests."""
    return application.state.db


@pytest.fixture
async def client(application) -> AsyncIterator[AsyncClient]:
    """Exercise the real ASGI routes, dependencies, and persistence without network mocks."""
    async with AsyncClient(transport=ASGITransport(app=application), base_url="http://test") as value:
        yield value


@pytest.fixture
def service(db, application) -> IdentityService:
    """Construct the real service with repository and audit persistence boundaries."""
    return IdentityService(IdentityRepository(db), AuditRepository(db), application.state.settings.JWT_SECRET)


@pytest.fixture
async def engineer_headers(client) -> dict[str, str]:
    """Return an ordinary seeded engineer bearer for later feature test slices."""
    response = await client.post("/api/v1/auth/login", json={"email": "engineer@portfolio.local", "password": "PortalDemo123!"})
    assert response.status_code == 200
    return {"Authorization": f"Bearer {response.json()['token']}"}
