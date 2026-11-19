"""Bind the request database to the lifespan pool and create explicit indexes."""

from fastapi import Request
from pymongo.asynchronous.database import AsyncDatabase


def get_database(request: Request) -> AsyncDatabase:
    """Return the pool attached to this app instance, including isolated test apps."""
    return request.app.state.db


async def create_indexes(db: AsyncDatabase) -> None:
    """Create idempotent uniqueness, scope, ordering, and session expiry indexes."""
    for collection, field in [("users", "email"), ("roles", "name"), ("portfolios", "name"), ("applications", "name")]:
        await db[collection].create_index(field, unique=True)
    await db.sessions.create_index("expiresAt", expireAfterSeconds=0)
    await db.sessions.create_index("userId")
    await db.users.create_index([("status", 1), ("name", 1)])
    await db.portfolios.create_index([("status", 1), ("productArea", 1)])
    await db.applications.create_index([("portfolioId", 1), ("risk", 1), ("lifecycle", 1)])
    await db.audit.create_index([("time", -1), ("personId", 1), ("action", 1)])
