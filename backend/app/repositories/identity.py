"""Access persisted accounts, current roles, and revocable bearer sessions."""

from datetime import datetime
from typing import Any
from bson import ObjectId
from pymongo import ReturnDocument
from app.repositories.base import MongoRepository


class IdentityRepository(MongoRepository):
    """Keep all identity state in the shared MongoDB, including session revocation."""

    async def user_by_email(self, email: str) -> dict[str, Any] | None:
        """Find a normalized email using the unique account index."""
        return await self.db.users.find_one({"email": email})

    async def user_by_id(self, user_id: ObjectId) -> dict[str, Any] | None:
        """Read current account status, version, role, and portfolio assignments."""
        return await self.db.users.find_one({"_id": user_id})

    async def role(self, role_id: ObjectId) -> dict[str, Any] | None:
        """Read current role permissions rather than trusting token claims."""
        return await self.db.roles.find_one({"_id": role_id})

    async def portfolio_names(self, ids: list[ObjectId]) -> list[str]:
        """Resolve only the account's explicit assignments for profile display."""
        rows = await self.db.portfolios.find({"_id": {"$in": ids}}, {"name": 1}).sort("name", 1).limit(100).to_list(None)
        return [row["name"] for row in rows]

    async def create_session(self, user: dict[str, Any], expires: datetime) -> ObjectId:
        """Persist a session tied to the account's current credential version."""
        result = await self.db.sessions.insert_one({"userId": user["_id"], "expiresAt": expires,
            "authVersion": user.get("authVersion", 0), "revoked": False})
        return result.inserted_id

    async def session(self, session_id: ObjectId) -> dict[str, Any] | None:
        """Read a session even before Mongo's asynchronous TTL cleanup occurs."""
        return await self.db.sessions.find_one({"_id": session_id})

    async def revoke(self, session_id: ObjectId) -> None:
        """Invalidate one session immediately while retaining its expiry metadata."""
        await self.db.sessions.update_one({"_id": session_id}, {"$set": {"revoked": True}})

    async def revoke_all(self, user_id: ObjectId) -> None:
        """Invalidate every prior session following a credential change."""
        await self.db.sessions.update_many({"userId": user_id}, {"$set": {"revoked": True}})

    async def update(self, user_id: ObjectId, fields: dict[str, Any]) -> dict[str, Any]:
        """Save validated account fields and return the persisted account."""
        return await self.db.users.find_one_and_update({"_id": user_id}, {"$set": fields}, return_document=ReturnDocument.AFTER)

    async def change_password(self, user: dict[str, Any], password_hash: str) -> dict[str, Any] | None:
        """Atomically advance credential version only if the verified hash is unchanged."""
        return await self.db.users.find_one_and_update({"_id": user["_id"], "passwordHash": user["passwordHash"]},
            {"$set": {"passwordHash": password_hash, "mustChangePassword": False}, "$inc": {"authVersion": 1}},
            return_document=ReturnDocument.AFTER)
