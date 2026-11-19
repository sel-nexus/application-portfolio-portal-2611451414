"""Apply current dashboard authorization and exact half-up integer calculations."""

from typing import Any
from bson import ObjectId
from app.core.security import allowed_portfolios, require_permission
from app.repositories.dashboard import DashboardRepository
from app.schemas.dashboard import DashboardMetrics, DashboardResponse, PortfolioQuality, PortfolioRisk


def rounded_average(total: int, count: int) -> int:
    """Round a nonnegative stored-value average half-up, returning zero if empty."""
    return (2 * total + count) // (2 * count) if count else 0


class DashboardService:
    """Produce read-only summaries from the current permitted Mongo inventory."""

    def __init__(self, repository: DashboardRepository) -> None:
        """Retain the pooled data-access boundary."""
        self.repository = repository

    async def read(self, identity: dict[str, Any], portfolio_id: ObjectId | None = None,
                   product_area: str | None = None, risk: str | None = None) -> DashboardResponse:
        """Refuse forced-password or missing-view access before reading any inventory."""
        require_permission(identity, "view")
        result = await self.repository.aggregate(allowed_portfolios(identity), portfolio_id, product_area, risk)
        totals = result["totals"][0] if result["totals"] else {}
        count = totals.get("count", 0)
        quality = {str(row["_id"]): row for row in result["quality"]}
        risks = {str(row["_id"]): row["applications"] for row in result["risk"]}
        unfiltered = portfolio_id is None and product_area is None and risk is None
        metrics = DashboardMetrics(
            enterpriseQualityScore=rounded_average(totals.get("qualitySum", 0), count),
            applicationHealth=rounded_average(totals.get("healthSum", 0), count),
            automationMaturity=rounded_average(totals.get("automationSum", 0), count),
            openCriticalDefects=totals.get("critical", 0), applicationsAtRisk=totals.get("high", 0),
            totalApplications=count,
            totalPortfolios=len(result["portfolios"]) if unfiltered else len(quality),
        )
        return DashboardResponse(
            metrics=metrics,
            portfolioQuality=[PortfolioQuality(**row, qualityScore=rounded_average(
                quality[row["id"]]["qualitySum"], quality[row["id"]]["count"]))
                for row in result["portfolios"] if row["id"] in quality],
            applicationsAtRisk=[PortfolioRisk(**row, applications=risks[row["id"]])
                for row in result["portfolios"] if row["id"] in risks],
            portfolios=result["portfolios"], productAreas=result["productAreas"], risks=result["risks"],
        )
