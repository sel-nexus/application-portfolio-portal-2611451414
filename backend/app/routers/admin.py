"""Expose authenticated account and fixed-role administration."""

from typing import Annotated, Any
from fastapi import APIRouter, Depends, Query
from pymongo.asynchronous.database import AsyncDatabase
from app.core.database import get_database
from app.core.security import get_current_user
from app.repositories.identity import IdentityRepository
from app.repositories.audit import AuditRepository
from app.schemas.auth import PublicUser
from app.schemas.admin import UserPage, UserCreate, UserPayload, RolePayload, PublicRole
from app.services.admin import AdminService

router = APIRouter(prefix="/api/v1/admin", tags=["Administration"])
Identity = Annotated[dict[str, Any], Depends(get_current_user)]


def get_service(db: Annotated[AsyncDatabase, Depends(get_database)]) -> AdminService:
    """Bind administration to the existing lifespan-owned database pool."""
    return AdminService(IdentityRepository(db), AuditRepository(db))


Service = Annotated[AdminService, Depends(get_service)]


@router.get("/users", response_model=UserPage, summary="List administered users")
async def users(identity: Identity, service: Service, page: Annotated[int, Query(ge=1)] = 1,
                page_size: Annotated[int, Query(ge=1, le=100)] = 10) -> dict[str, Any]:
    """Return a validated bounded page of public account facts."""
    return await service.users(identity, page, page_size)


@router.post("/users", response_model=PublicUser, status_code=201, summary="Create user")
async def create_user(payload: UserCreate, identity: Identity, service: Service) -> PublicUser:
    """Create a unique administered account and audit the write."""
    return await service.create(identity, payload)


@router.put("/users/{user_id}", response_model=PublicUser, summary="Edit or deactivate user")
async def update_user(user_id: str, payload: UserPayload, identity: Identity, service: Service) -> PublicUser:
    """Save full account maintenance without accepting an initial password."""
    return await service.update(identity, user_id, payload)


@router.get("/roles", response_model=list[PublicRole], summary="List fixed roles")
async def roles(identity: Identity, service: Service) -> list[PublicRole]:
    """Read the six persisted descriptions and permission sets."""
    return await service.roles(identity)


@router.put("/roles/{role_id}", response_model=PublicRole, summary="Edit role configuration")
async def update_role(role_id: str, payload: RolePayload, identity: Identity, service: Service) -> PublicRole:
    """Save allowed configuration without permitting a role rename."""
    return await service.update_role(identity, role_id, payload)
