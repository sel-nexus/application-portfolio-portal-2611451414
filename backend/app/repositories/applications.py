"""Persist referenced application documents through the lifespan-owned Mongo pool."""

import re
from typing import Any
from bson import ObjectId
from app.repositories.base import MongoRepository, serialize
from app.repositories.portfolios import NAME_COLLATION


class ApplicationRepository(MongoRepository):
    """Keep filtering, paging, joining and uniqueness in the real database."""

    async def ensure_indexes(self) -> None:
        """Add case-insensitive uniqueness and indexes for each list filter."""
        await self.db.applications.create_index("name", name="application_name_ci", unique=True, collation=NAME_COLLATION)
        for field in ("portfolioId", "criticality", "risk", "lifecycle"):
            await self.db.applications.create_index([(field, 1), ("name", 1)])

    def query(self, scope: list[ObjectId] | None, search: str = "", portfolio_id: ObjectId | None = None,
              criticality: str | None = None, risk: str | None = None, lifecycle: str | None = None) -> dict[str, Any]:
        """Build literal filters without accepting operator objects or regex programs."""
        query: dict[str, Any] = {} if scope is None else {"portfolioId": {"$in": scope}}
        if portfolio_id is not None:
            query["portfolioId"] = portfolio_id if scope is None or portfolio_id in scope else {"$in": []}
        if search:
            query["name"] = {"$regex": re.escape(search), "$options": "i"}
        for field, value in (("criticality", criticality), ("risk", risk), ("lifecycle", lifecycle)):
            if value is not None:
                query[field] = value
        return query

    async def portfolios(self, scope: list[ObjectId] | None) -> list[dict[str, str]]:
        """Read available choices including visible portfolios with no applications."""
        query = {} if scope is None else {"_id": {"$in": scope}}
        rows = await self.db.portfolios.find(query, {"name": 1}).sort("name", 1).to_list(None)
        return [serialize(row) for row in rows]

    async def portfolio_exists(self, portfolio_id: ObjectId) -> bool:
        """Check a reference without loading unrelated portfolio details."""
        return await self.db.portfolios.find_one({"_id": portfolio_id}, {"_id": 1}) is not None

    async def decorate(self, row: dict[str, Any]) -> dict[str, Any]:
        """Resolve the current portfolio name instead of storing a stale duplicate."""
        portfolio = await self.db.portfolios.find_one({"_id": ObjectId(row["portfolioId"])}, {"name": 1})
        return {**row, "portfolio": portfolio["name"] if portfolio else "Not available"}

    async def filtered(self, scope: list[ObjectId] | None, filters: dict[str, Any], page: int,
                       page_size: int) -> dict[str, Any]:
        """Read paged rows and scope-safe classification and portfolio choices."""
        result = await self.page("applications", self.query(scope, **filters), page, page_size)
        result["items"] = [await self.decorate(row) for row in result["items"]]
        scoped = self.query(scope)
        result["portfolios"] = await self.portfolios(scope)
        for output, field in (("criticalities", "criticality"), ("risks", "risk"), ("lifecycles", "lifecycle")):
            result[output] = sorted(await self.db.applications.distinct(field, scoped))
        return result

    async def matching(self, scope: list[ObjectId] | None, filters: dict[str, Any]) -> list[dict[str, Any]]:
        """Read all filtered export rows, ignoring list paging but retaining scope."""
        rows = await self.db.applications.find(self.query(scope, **filters)).sort([("name", 1), ("_id", 1)]).to_list(None)
        return [await self.decorate(serialize(row)) for row in rows]

    async def detail(self, application_id: ObjectId, scope: list[ObjectId] | None) -> dict[str, Any] | None:
        """Apply visibility in Mongo before reading any stored application fields."""
        row = await self.db.applications.find_one({**self.query(scope), "_id": application_id})
        return await self.decorate(serialize(row)) if row else None

    async def create(self, fields: dict[str, Any]) -> ObjectId:
        """Insert validated fields with an ObjectId portfolio reference."""
        return (await self.db.applications.insert_one(fields)).inserted_id

    async def update(self, application_id: ObjectId, fields: dict[str, Any]) -> bool:
        """Update only maintained fields and report concurrent removal."""
        return (await self.db.applications.update_one({"_id": application_id}, {"$set": fields})).matched_count == 1

    async def delete(self, application_id: ObjectId) -> bool:
        """Remove a stored row and distinguish concurrent removal."""
        return (await self.db.applications.delete_one({"_id": application_id})).deleted_count == 1
