"""Expose authenticated portfolio CRUD with validated query and response contracts."""

from typing import Annotated, Any, Literal
from fastapi import APIRouter, Depends, Query, Response
from pymongo.asynchronous.database import AsyncDatabase
from app.core.database import get_database
from app.core.security import get_current_user
from app.repositories.audit import AuditRepository
from app.repositories.portfolios import PortfolioRepository
from app.schemas.portfolios import PortfolioDetail, PortfolioPage, PortfolioPayload
from app.services.portfolios import PortfolioService

router = APIRouter(prefix="/api/v1/portfolios", tags=["Portfolios"])
Identity = Annotated[dict[str, Any], Depends(get_current_user)]


def get_service(db: Annotated[AsyncDatabase, Depends(get_database)]) -> PortfolioService:
    """Bind inventory and audit operations to the request's lifespan-owned pool."""
    return PortfolioService(PortfolioRepository(db), AuditRepository(db))


Service = Annotated[PortfolioService, Depends(get_service)]


@router.get("", response_model=PortfolioPage, summary="List permitted portfolios")
async def list_portfolios(identity: Identity, service: Service,
    search: Annotated[str, Query(max_length=200)] = "",
    status: Annotated[Literal["Active", "Archived"] | None, Query()] = None,
    productArea: Annotated[str | None, Query(max_length=200)] = None,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 10) -> dict[str, Any]:
    """Return filtered rows, computed values, and scope-safe filter choices."""
    return await service.list(identity, search, status, productArea, page, page_size)


@router.get("/{portfolio_id}", response_model=PortfolioDetail, summary="Read portfolio detail")
async def detail_portfolio(portfolio_id: str, identity: Identity, service: Service) -> dict[str, Any]:
    """Return only a visible portfolio and its associated application names."""
    return await service.detail(identity, portfolio_id)


@router.post("", response_model=PortfolioDetail, status_code=201, summary="Create portfolio")
async def create_portfolio(payload: PortfolioPayload, identity: Identity, service: Service) -> dict[str, Any]:
    """Create an administrator-maintained portfolio and audit the persisted write."""
    return await service.create(identity, payload)


@router.put("/{portfolio_id}", response_model=PortfolioDetail, summary="Edit portfolio")
async def update_portfolio(portfolio_id: str, payload: PortfolioPayload, identity: Identity, service: Service) -> dict[str, Any]:
    """Persist permitted maintenance fields, including case-insensitive name checks."""
    return await service.update(identity, portfolio_id, payload)


@router.delete("/{portfolio_id}", status_code=204, summary="Delete empty portfolio")
async def delete_portfolio(portfolio_id: str, identity: Identity, service: Service) -> Response:
    """Remove an empty portfolio only for an authorized administrator."""
    await service.delete(identity, portfolio_id)
    return Response(status_code=204)
