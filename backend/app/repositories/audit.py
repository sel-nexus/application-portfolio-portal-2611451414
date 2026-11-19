"""Persist bounded, credential-free audit history for identity and later features."""

from datetime import datetime, timezone
from typing import Any
from bson import ObjectId
from app.repositories.base import MongoRepository, serialize


class AuditRepository(MongoRepository):
    """Write traceable events and read filtered, paged history."""

    async def write(self, person: dict[str, Any] | None, action: str, entity_type: str,
                    entity_id: ObjectId | None, summary: str) -> None:
        """Persist a caller-authored safe summary without retaining request payloads."""
        await self.db.audit.insert_one({"time": datetime.now(timezone.utc),
            "personId": person["_id"] if person else None,
            "person": person["name"] if person else "Unknown person", "action": action,
            "entityType": entity_type, "entityId": entity_id, "summary": summary})

    async def filtered(self, query: dict[str, Any], page: int = 1, page_size: int = 10) -> dict[str, Any]:
        """Read a bounded audit page using an internally constructed filter."""
        if page < 1 or not 1 <= page_size <= 100:
            raise ValueError("Invalid pagination")
        projection = {key: 1 for key in ("time", "person", "action", "entityType", "entityId", "summary")}
        rows = await self.db.audit.find(query, projection).sort([("time", -1), ("_id", -1)]).skip(
            (page - 1) * page_size).limit(page_size).to_list(None)
        return {"items": [serialize(row) for row in rows], "total": await self.db.audit.count_documents(query),
                "page": page, "page_size": page_size}

    async def choices(self) -> dict[str, list[str]]:
        """Read actor snapshots and actions without exposing identity credentials."""
        return {"persons": sorted(await self.db.audit.distinct("person")),
                "actions": sorted(await self.db.audit.distinct("action"))}
