"""Persist portfolios and compute application summaries through the shared Mongo pool."""

import re
from typing import Any
from bson import ObjectId
from pymongo import ReturnDocument
from pymongo.collation import Collation
from app.repositories.base import MongoRepository, serialize

NAME_COLLATION = Collation(locale="en", strength=2)


class PortfolioRepository(MongoRepository):
    """Keep scoped queries, uniqueness, and stored-value aggregation in MongoDB."""

    async def ensure_indexes(self) -> None:
        """Add case-insensitive uniqueness without altering the existing exact-name index."""
        await self.db.portfolios.create_index("name", name="portfolio_name_ci", unique=True, collation=NAME_COLLATION)

    def scope_query(self, scope: list[ObjectId] | None) -> dict[str, Any]:
        """Construct a fail-closed identifier filter for explicit assignments."""
        return {} if scope is None else {"_id": {"$in": scope}}

    async def filtered(self, scope: list[ObjectId] | None, search: str, status: str | None,
                       product_area: str | None, page: int, page_size: int) -> dict[str, Any]:
        """Read one name-sorted page and options from the permitted scope, not the page."""
        scoped = self.scope_query(scope)
        query = dict(scoped)
        if search:
            query["name"] = {"$regex": re.escape(search), "$options": "i"}
        if status is not None:
            query["status"] = status
        if product_area is not None:
            query["productArea"] = product_area
        result = await self.page("portfolios", query, page, page_size)
        for row in result["items"]:
            row.update(await self.statistics(ObjectId(row["id"])))
        result["productAreas"] = sorted(await self.db.portfolios.distinct("productArea", scoped))
        result["statuses"] = sorted(await self.db.portfolios.distinct("status", scoped))
        return result

    async def statistics(self, portfolio_id: ObjectId) -> dict[str, int]:
        """Round the stored nonnegative average half-up, using zero for empty portfolios."""
        cursor = await self.db.applications.aggregate([
            {"$match": {"portfolioId": portfolio_id}},
            {"$group": {"_id": None, "count": {"$sum": 1}, "quality": {"$avg": "$qualityScore"}}},
        ])
        rows = await cursor.to_list(None)
        if not rows:
            return {"applicationCount": 0, "qualityScore": 0}
        return {"applicationCount": rows[0]["count"], "qualityScore": int(rows[0]["quality"] + 0.5)}

    async def detail(self, portfolio_id: ObjectId) -> dict[str, Any] | None:
        """Read public detail and its referenced applications; do not embed a second inventory."""
        row = await self.db.portfolios.find_one({"_id": portfolio_id})
        if row is None:
            return None
        result = serialize(row)
        result.update(await self.statistics(portfolio_id))
        applications = await self.db.applications.find({"portfolioId": portfolio_id}, {"name": 1}).sort("name", 1).to_list(None)
        result["applications"] = [serialize(app) for app in applications]
        return result

    async def create(self, fields: dict[str, Any]) -> ObjectId:
        """Insert validated maintenance fields under both unique name indexes."""
        return (await self.db.portfolios.insert_one(fields)).inserted_id

    async def update(self, portfolio_id: ObjectId, fields: dict[str, Any]) -> bool:
        """Replace maintained fields only, reporting concurrent removal as unavailable."""
        row = await self.db.portfolios.find_one_and_update({"_id": portfolio_id}, {"$set": fields}, return_document=ReturnDocument.AFTER)
        return row is not None

    async def occupied(self, portfolio_id: ObjectId) -> bool:
        """Check for any remaining application without loading its private fields."""
        return await self.db.applications.find_one({"portfolioId": portfolio_id}, {"_id": 1}) is not None

    async def delete(self, portfolio_id: ObjectId) -> bool:
        """Remove the portfolio and report whether the stored row still existed."""
        return (await self.db.portfolios.delete_one({"_id": portfolio_id})).deleted_count == 1
