"""Define the public read-only dashboard contract without stored account fields."""

from pydantic import BaseModel
from app.schemas.applications import Risk


class DashboardMetrics(BaseModel):
    """Expose the seven integer stored-value calculations."""

    enterpriseQualityScore: int = 0
    applicationHealth: int = 0
    automationMaturity: int = 0
    openCriticalDefects: int = 0
    applicationsAtRisk: int = 0
    totalApplications: int = 0
    totalPortfolios: int = 0


class DashboardLink(BaseModel):
    """Expose only the identifier and display name needed for navigation."""

    id: str
    name: str


class PortfolioQuality(DashboardLink):
    """Describe a portfolio's filtered integer quality percentage."""

    qualityScore: int


class PortfolioRisk(DashboardLink):
    """Group matching High-risk application links under their portfolio."""

    applications: list[DashboardLink]


class DashboardResponse(BaseModel):
    """Return consistent metrics, breakdowns, and scope-safe filter choices."""

    metrics: DashboardMetrics
    portfolioQuality: list[PortfolioQuality]
    applicationsAtRisk: list[PortfolioRisk]
    portfolios: list[DashboardLink]
    productAreas: list[str]
    risks: list[Risk]
