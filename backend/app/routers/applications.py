"""Expose validated application CRUD, scoped choices, and audited CSV downloads."""

from typing import Annotated, Any
from fastapi import APIRouter, Depends, Query, Response
from pymongo.asynchronous.database import AsyncDatabase
from app.core.database import get_database
from app.core.security import get_current_user
from app.repositories.base import object_id
from app.repositories.applications import ApplicationRepository
from app.repositories.audit import AuditRepository
from app.schemas.applications import ApplicationDetail, ApplicationPage, ApplicationPayload, Criticality, Lifecycle, Risk
from app.services.applications import ApplicationService

router = APIRouter(prefix="/api/v1/applications", tags=["Applications"])
Identity = Annotated[dict[str, Any], Depends(get_current_user)]


def get_service(db: Annotated[AsyncDatabase, Depends(get_database)]) -> ApplicationService:
    """Bind feature and audit repositories to the shared request database."""
    return ApplicationService(ApplicationRepository(db), AuditRepository(db))


def get_filters(search: Annotated[str, Query(max_length=200)] = "",
                portfolioId: Annotated[str | None, Query()] = None,
                criticality: Annotated[Criticality | None, Query()] = None,
                risk: Annotated[Risk | None, Query()] = None,
                lifecycle: Annotated[Lifecycle | None, Query()] = None) -> dict[str, Any]:
    """Share exactly the same literal filtering contract between list and CSV."""
    return {"search": search, "portfolio_id": object_id(portfolioId) if portfolioId is not None else None,
            "criticality": criticality, "risk": risk, "lifecycle": lifecycle}


Service = Annotated[ApplicationService, Depends(get_service)]
Filters = Annotated[dict[str, Any], Depends(get_filters)]


@router.get("", response_model=ApplicationPage, summary="List permitted applications")
async def list_applications(identity: Identity, service: Service, filters: Filters,
                            page: Annotated[int, Query(ge=1)] = 1,
                            page_size: Annotated[int, Query(ge=1, le=100)] = 10) -> dict[str, Any]:
    """Return a bounded filtered page and scope-safe choices."""
    return await service.list(identity, filters, page, page_size)


@router.get("/csv", summary="Download matching applications")
async def export_applications(identity: Identity, service: Service, filters: Filters) -> Response:
    """Download all matches with the same columns, UTF-8 encoding, and persisted audit."""
    return Response(await service.export(identity, filters), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": 'attachment; filename="applications.csv"'})


@router.get("/{application_id}", response_model=ApplicationDetail, summary="Read application detail")
async def detail_application(application_id: str, identity: Identity, service: Service) -> dict[str, Any]:
    """Read complete permitted facts without leaking hidden fields."""
    return await service.detail(identity, application_id)


@router.post("", response_model=ApplicationDetail, status_code=201, summary="Create application")
async def create_application(payload: ApplicationPayload, identity: Identity, service: Service) -> dict[str, Any]:
    """Persist validated fields for an authorized maintainer."""
    return await service.create(identity, payload)


@router.put("/{application_id}", response_model=ApplicationDetail, summary="Edit application")
async def update_application(application_id: str, payload: ApplicationPayload, identity: Identity, service: Service) -> dict[str, Any]:
    """Check current and target portfolio authority before saving."""
    return await service.update(identity, application_id, payload)


@router.delete("/{application_id}", status_code=204, summary="Delete application")
async def delete_application(application_id: str, identity: Identity, service: Service) -> Response:
    """Delete only with administrator authority and a persisted audit event."""
    await service.delete(identity, application_id)
    return Response(status_code=204)
