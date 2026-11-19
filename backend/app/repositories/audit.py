"""Persist bounded, credential-free audit history for identity and later features."""

from datetime import datetime, timezone
from typing import Any
from bson import ObjectId
from app.repositories.base import MongoRepository


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
        return await self.page("audit", query, page, page_size, "time")
