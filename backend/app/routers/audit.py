"""Expose bounded audit history and Administrator-only filtered CSV."""

from datetime import date
from typing import Annotated, Any
from fastapi import APIRouter, Depends, Query, Response
from pymongo.asynchronous.database import AsyncDatabase
from app.core.database import get_database
from app.core.security import get_current_user
from app.repositories.audit import AuditRepository
from app.schemas.audit import AuditFilters, AuditPage
from app.services.audit import AuditService

router = APIRouter(prefix="/api/v1/audit", tags=["Audit"])
Identity = Annotated[dict[str, Any], Depends(get_current_user)]


def get_service(db: Annotated[AsyncDatabase, Depends(get_database)]) -> AuditService:
    """Bind inspection and export to the shared persisted audit repository."""
    return AuditService(AuditRepository(db))


def get_filters(person: Annotated[str | None, Query(max_length=200)] = None,
                action: Annotated[str | None, Query(max_length=200)] = None,
                from_date: Annotated[date | None, Query(alias="from")] = None,
                to_date: Annotated[date | None, Query(alias="to")] = None) -> AuditFilters:
    """Parse literal history filters without accepting Mongo operators."""
    return AuditFilters(person=person, action=action, from_date=from_date, to_date=to_date)


Service = Annotated[AuditService, Depends(get_service)]
Filters = Annotated[AuditFilters, Depends(get_filters)]


@router.get("", response_model=AuditPage, summary="Inspect audit history")
async def history(identity: Identity, service: Service, filters: Filters,
                  page: Annotated[int, Query(ge=1)] = 1,
                  page_size: Annotated[int, Query(ge=1, le=100)] = 10) -> AuditPage:
    """Return newest matching history only after current role checks."""
    return await service.list(identity, filters, page, page_size)


@router.get("/csv", summary="Download filtered audit CSV")
async def export_csv(identity: Identity, service: Service, filters: Filters) -> Response:
    """Return UTF-8 CSV only after Administrator authorization and audit persistence."""
    return Response(await service.export(identity, filters), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": 'attachment; filename="audit-log.csv"'})
