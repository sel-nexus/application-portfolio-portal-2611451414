"""Aggregate scoped stored inventory through the existing pooled Mongo database."""

from typing import Any
from bson import ObjectId
from app.repositories.base import MongoRepository, serialize


class DashboardRepository(MongoRepository):
    """Keep dashboard filtering, joining, and sums in MongoDB rather than memory."""

    async def aggregate(self, scope: list[ObjectId] | None, portfolio_id: ObjectId | None,
                        product_area: str | None, risk: str | None) -> dict[str, Any]:
        """Read one filtered facet and choices limited to existing permitted portfolios.

        Notes:
            Unfiltered totals include scoped empty portfolios. Filtered breakdowns
            include only portfolios represented by matching applications.
        """
        portfolio_query = {} if scope is None else {"_id": {"$in": scope}}
        portfolios = await self.db.portfolios.find(portfolio_query, {"name": 1}).sort("name", 1).to_list(None)
        visible_ids = [row["_id"] for row in portfolios]
        scoped = {"portfolioId": {"$in": visible_ids}}
        query: dict[str, Any] = dict(scoped)
        if portfolio_id is not None:
            query["portfolioId"] = portfolio_id if portfolio_id in visible_ids else {"$in": []}
        if product_area is not None:
            query["productArea"] = product_area
        if risk is not None:
            query["risk"] = risk
        cursor = await self.db.applications.aggregate([
            {"$match": query},
            {"$facet": {
                "totals": [{"$group": {
                    "_id": None, "count": {"$sum": 1},
                    "qualitySum": {"$sum": "$qualityScore"},
                    "healthSum": {"$sum": "$healthScore"},
                    "automationSum": {"$sum": "$automationCoverage"},
                    "critical": {"$sum": "$openCriticalDefects"},
                    "high": {"$sum": {"$cond": [{"$eq": ["$risk", "High"]}, 1, 0]}},
                }}],
                "quality": [{"$group": {"_id": "$portfolioId", "count": {"$sum": 1},
                                         "qualitySum": {"$sum": "$qualityScore"}}}],
                "risk": [
                    {"$match": {"risk": "High"}},
                    {"$sort": {"name": 1, "_id": 1}},
                    {"$group": {"_id": "$portfolioId", "applications": {"$push": {
                        "id": {"$toString": "$_id"}, "name": "$name"}}}},
                ],
            }},
        ])
        result = (await cursor.to_list(None))[0]
        result["portfolios"] = [serialize(row) for row in portfolios]
        result["productAreas"] = sorted(await self.db.applications.distinct("productArea", scoped))
        result["risks"] = sorted(await self.db.applications.distinct("risk", scoped))
        return result
