"""Expose two authenticated report tables and matching audited CSV endpoints."""

from typing import Annotated, Any, Literal
from fastapi import APIRouter, Depends, Query, Response
from pymongo.asynchronous.database import AsyncDatabase
from app.core.database import get_database
from app.core.security import get_current_user
from app.repositories.applications import ApplicationRepository
from app.repositories.portfolios import PortfolioRepository
from app.repositories.audit import AuditRepository
from app.routers.applications import get_filters
from app.schemas.applications import ApplicationPage
from app.schemas.portfolios import PortfolioPage
from app.services.reports import ReportService

router = APIRouter(prefix="/api/v1/reports", tags=["Reports"])
Identity = Annotated[dict[str, Any], Depends(get_current_user)]


def get_service(db: Annotated[AsyncDatabase, Depends(get_database)]) -> ReportService:
    """Bind all report reads and audit writes to the existing shared database."""
    return ReportService(ApplicationRepository(db), PortfolioRepository(db), AuditRepository(db))


def portfolio_filters(search: Annotated[str, Query(max_length=200)] = "",
                      status: Annotated[Literal["Active", "Archived"] | None, Query()] = None,
                      productArea: Annotated[str | None, Query(max_length=200)] = None) -> dict[str, Any]:
    """Match inventory filters for both portfolio report formats."""
    return {"search": search, "status": status, "product_area": productArea}


Service = Annotated[ReportService, Depends(get_service)]
ApplicationFilters = Annotated[dict[str, Any], Depends(get_filters)]
PortfolioFilters = Annotated[dict[str, Any], Depends(portfolio_filters)]


@router.get("/applications", response_model=ApplicationPage, summary="Read application report")
async def applications(identity: Identity, service: Service, filters: ApplicationFilters,
                       page: Annotated[int, Query(ge=1)] = 1,
                       page_size: Annotated[int, Query(ge=1, le=100)] = 10) -> dict[str, Any]:
    """Read a bounded application report with current visibility."""
    return await service.application_report(identity, filters, page, page_size)


@router.get("/portfolios", response_model=PortfolioPage, summary="Read portfolio report")
async def portfolios(identity: Identity, service: Service, filters: PortfolioFilters,
                     page: Annotated[int, Query(ge=1)] = 1,
                     page_size: Annotated[int, Query(ge=1, le=100)] = 10) -> dict[str, Any]:
    """Read a bounded portfolio report with computed inventory values."""
    return await service.portfolio_report(identity, filters, page, page_size)


@router.get("/applications/csv", summary="Download application report CSV")
async def application_csv(identity: Identity, service: Service, filters: ApplicationFilters) -> Response:
    """Send UTF-8 CSV only after permission checks and successful audit persistence."""
    return Response(await service.export(identity, "applications", filters), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": 'attachment; filename="application-report.csv"'})


@router.get("/portfolios/csv", summary="Download portfolio report CSV")
async def portfolio_csv(identity: Identity, service: Service, filters: PortfolioFilters) -> Response:
    """Send all matching portfolio rows, not only the visible page."""
    return Response(await service.export(identity, "portfolios", filters), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": 'attachment; filename="portfolio-report.csv"'})
