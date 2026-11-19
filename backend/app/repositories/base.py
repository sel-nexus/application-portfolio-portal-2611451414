"""Provide bounded Mongo reads and safe identifier conversion for feature repositories."""

from typing import Any
from bson import ObjectId
from fastapi import HTTPException
from pymongo.asynchronous.database import AsyncDatabase


def object_id(value: str) -> ObjectId:
    """Convert an API identifier or refuse it without leaking record contents."""
    if not ObjectId.is_valid(value):
        raise HTTPException(404, "This record is not available.")
    return ObjectId(value)


def serialize(document: dict[str, Any]) -> dict[str, Any]:
    """Convert nested BSON identifiers to portable API fields."""
    result = {}
    for key, value in document.items():
        if isinstance(value, ObjectId):
            value = str(value)
        elif isinstance(value, dict):
            value = serialize(value)
        elif isinstance(value, list):
            value = [str(item) if isinstance(item, ObjectId) else item for item in value]
        result["id" if key == "_id" else key] = value
    return result


class MongoRepository:
    """Hold the shared pooled database and bound collection reads."""

    def __init__(self, db: AsyncDatabase) -> None:
        """Retain the lifespan-owned database without opening another connection."""
        self.db = db

    async def page(self, collection: str, query: dict[str, Any], page: int = 1,
                   page_size: int = 10, sort: str = "name") -> dict[str, Any]:
        """Return a stable bounded page with total count.

        Raises:
            ValueError: Paging lies outside the supported bounds.
        """
        if page < 1 or not 1 <= page_size <= 100:
            raise ValueError("Invalid pagination")
        coll = self.db[collection]
        rows = await coll.find(query).sort([(sort, 1), ("_id", 1)]).skip((page - 1) * page_size).limit(page_size).to_list(None)
        return {"items": [serialize(row) for row in rows], "total": await coll.count_documents(query),
                "page": page, "page_size": page_size}
