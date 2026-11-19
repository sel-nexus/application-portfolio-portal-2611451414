"""Expose the read-only dashboard with validated literal filter parameters."""

from typing import Annotated, Any
from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Query
from pymongo.asynchronous.database import AsyncDatabase
from app.core.database import get_database
from app.core.security import get_current_user
from app.repositories.dashboard import DashboardRepository
from app.schemas.applications import Risk
from app.schemas.dashboard import DashboardResponse
from app.services.dashboard import DashboardService

router = APIRouter(prefix="/api/v1/dashboard", tags=["Dashboard"])


def get_service(db: Annotated[AsyncDatabase, Depends(get_database)]) -> DashboardService:
    """Bind the dashboard repository to the lifespan-owned request pool."""
    return DashboardService(DashboardRepository(db))


@router.get("", response_model=DashboardResponse, summary="Read permitted executive dashboard")
async def read_dashboard(
    identity: Annotated[dict[str, Any], Depends(get_current_user)],
    service: Annotated[DashboardService, Depends(get_service)],
    portfolioId: Annotated[str | None, Query(max_length=24)] = None,
    productArea: Annotated[str | None, Query(max_length=200)] = None,
    risk: Annotated[Risk | None, Query()] = None,
) -> DashboardResponse:
    """Return seven metrics and both breakdowns using the same three filters."""
    if portfolioId is not None and not ObjectId.is_valid(portfolioId):
        raise HTTPException(422, {"portfolioId": "Enter a valid portfolio identifier."})
    return await service.read(identity, ObjectId(portfolioId) if portfolioId is not None else None, productArea, risk)
