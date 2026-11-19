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

    async def admin_users(self, page: int, page_size: int) -> dict[str, Any]:
        """Read a bounded account page without retrieving stored password hashes."""
        if page < 1 or not 1 <= page_size <= 100:
            raise ValueError("Invalid pagination")
        rows = await self.db.users.find({}, {"passwordHash": 0}).sort([("name", 1), ("_id", 1)]).skip((page - 1) * page_size).limit(page_size).to_list(None)
        return {"items": rows, "total": await self.db.users.count_documents({}), "page": page, "page_size": page_size}

    async def admin_roles(self, names: list[str]) -> list[dict[str, Any]]:
        """Read only the six supported persisted role configurations."""
        return await self.db.roles.find({"name": {"$in": names}}).sort("name", 1).limit(6).to_list(None)

    async def role_by_name(self, name: str) -> dict[str, Any] | None:
        """Resolve a validated stable role name to its persisted reference."""
        return await self.db.roles.find_one({"name": name})

    async def portfolios_exist(self, ids: list[ObjectId]) -> bool:
        """Confirm that every validated assignment references an existing portfolio."""
        return await self.db.portfolios.count_documents({"_id": {"$in": ids}}) == len(ids)

    async def create_user(self, fields: dict[str, Any]) -> dict[str, Any]:
        """Insert validated account fields then requery the persisted document."""
        result = await self.db.users.insert_one(fields)
        return await self.user_by_id(result.inserted_id)

    async def admin_update_user(self, user_id: ObjectId, fields: dict[str, Any]) -> dict[str, Any] | None:
        """Save account facts and advance credential version on deactivation.

        Notes:
            The single-document version change keeps old sessions invalid even
            if reactivation occurs before session revocation finishes.
        """
        update = {"$set": fields}
        if fields["status"] == "Inactive":
            update["$inc"] = {"authVersion": 1}
        return await self.db.users.find_one_and_update({"_id": user_id}, update, return_document=ReturnDocument.AFTER)

    async def admin_update_role(self, role_id: ObjectId, fields: dict[str, Any]) -> dict[str, Any] | None:
        """Persist description and permissions without modifying the role name."""
        return await self.db.roles.find_one_and_update({"_id": role_id}, {"$set": fields}, return_document=ReturnDocument.AFTER)
