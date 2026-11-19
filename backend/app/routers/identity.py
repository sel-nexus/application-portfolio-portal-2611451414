"""Expose the agreed authentication and personal-profile HTTP contracts."""

from typing import Annotated, Any
from fastapi import APIRouter, Depends, Request, Response
from app.core.database import get_database
from app.core.security import get_current_user
from app.repositories.audit import AuditRepository
from app.repositories.identity import IdentityRepository
from app.schemas.auth import AuthResponse, LoginRequest, PasswordRequest, ProfileRequest, PublicUser
from app.services.identity import IdentityService

router = APIRouter(prefix="/api/v1", tags=["Identity"])
CurrentIdentity = Annotated[dict[str, Any], Depends(get_current_user)]


def get_service(request: Request, db: Annotated[Any, Depends(get_database)]) -> IdentityService:
    """Inject the app-owned Mongo pool and signing configuration into the service."""
    return IdentityService(IdentityRepository(db), AuditRepository(db), request.app.state.settings.JWT_SECRET)

Service = Annotated[IdentityService, Depends(get_service)]


@router.post("/auth/login", response_model=AuthResponse, summary="Sign in with local credentials")
async def login(payload: LoginRequest, service: Service) -> AuthResponse:
    """Issue an eight-hour persisted bearer session for valid credentials."""
    return await service.login(payload)


@router.get("/auth/me", response_model=PublicUser, summary="Read current account")
async def me(identity: CurrentIdentity, service: Service) -> PublicUser:
    """Read fresh public profile facts for the current valid session."""
    return await service.public_user(identity["user"])


@router.post("/auth/logout", status_code=204, summary="Revoke current session")
async def logout(identity: CurrentIdentity, service: Service) -> Response:
    """Invalidate the server session before reporting successful sign-out."""
    await service.logout(identity)
    return Response(status_code=204)


@router.put("/profile", response_model=PublicUser, summary="Save landing preference")
async def profile(payload: ProfileRequest, identity: CurrentIdentity, service: Service) -> PublicUser:
    """Persist the caller's default landing without allowing identity or role edits."""
    return await service.profile(identity, payload)


@router.post("/profile/password", response_model=AuthResponse, summary="Change password and replace session")
async def password(payload: PasswordRequest, identity: CurrentIdentity, service: Service) -> AuthResponse:
    """Replace credentials and all previous sessions after validating proof."""
    return await service.password(identity, payload)
