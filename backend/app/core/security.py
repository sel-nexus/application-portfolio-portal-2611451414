"""Hash credentials off-thread and authenticate persisted, current bearer sessions."""

from datetime import datetime, timedelta, timezone
from typing import Annotated, Any
from bson import ObjectId
from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from starlette.concurrency import run_in_threadpool
from app.core.database import get_database
from app.repositories.identity import IdentityRepository

password_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
bearer = HTTPBearer(auto_error=False)


async def hash_password(password: str) -> str:
    """Hash a nonempty bounded password without blocking the event loop."""
    if not password or len(password.encode("utf-8")) > 72:
        raise ValueError("Password must contain 1–72 UTF-8 bytes")
    return await run_in_threadpool(password_context.hash, password)


async def verify_password(password: str, stored_hash: str) -> bool:
    """Fail closed on oversized input or an invalid stored bcrypt hash."""
    if not password or len(password.encode("utf-8")) > 72:
        return False
    try:
        return await run_in_threadpool(password_context.verify, password, stored_hash)
    except (ValueError, TypeError):
        return False


def create_token(user_id: ObjectId, session_id: ObjectId, secret: str, expires: datetime) -> str:
    """Sign only identity and session identifiers with a fixed HS256 algorithm."""
    return jwt.encode({"sub": str(user_id), "jti": str(session_id), "exp": expires,
                       "iat": datetime.now(timezone.utc)}, secret, algorithm="HS256")


async def authenticate_token(token: str, repository: IdentityRepository, secret: str) -> dict[str, Any]:
    """Recheck expiry, revocation, status, credential version, role, and scope.

    Raises:
        HTTPException: The token or persisted identity is no longer valid.
    """
    denied = HTTPException(401, "Your session has expired. Please sign in again.", headers={"WWW-Authenticate": "Bearer"})
    try:
        claims = jwt.decode(token, secret, algorithms=["HS256"], options={"require_exp": True, "require_sub": True, "require_jti": True})
        if not ObjectId.is_valid(claims["sub"]) or not ObjectId.is_valid(claims["jti"]):
            raise denied
    except (JWTError, KeyError, TypeError) as exc:
        raise denied from exc
    session = await repository.session(ObjectId(claims["jti"]))
    if not session or session["revoked"] or session["expiresAt"] <= datetime.now(timezone.utc):
        raise denied
    user = await repository.user_by_id(ObjectId(claims["sub"]))
    if not user or user["status"] != "Active" or session["userId"] != user["_id"] or session["authVersion"] != user.get("authVersion", 0):
        raise denied
    role = await repository.role(user["roleId"])
    if not role:
        raise denied
    return {"user": user, "role": role, "session": session}


async def get_current_user(request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
    db: Annotated[Any, Depends(get_database)]) -> dict[str, Any]:
    """Resolve current identity for profile operations and later protected services."""
    if not credentials:
        raise HTTPException(401, "Please sign in.", headers={"WWW-Authenticate": "Bearer"})
    return await authenticate_token(credentials.credentials, IdentityRepository(db), request.app.state.settings.JWT_SECRET)


def require_permission(identity: dict[str, Any], permission: str, portfolio_id: ObjectId | None = None,
                       administrator_only: bool = False) -> None:
    """Enforce current role and conservative portfolio scope for later slices."""
    if identity["user"]["mustChangePassword"]:
        raise HTTPException(403, "Change your initial password before continuing.")
    role = identity["role"]
    if permission not in role["permissions"] or (administrator_only and role["name"] != "Administrator"):
        raise HTTPException(403, "You do not have access to administration." if administrator_only else "You do not have permission for this action.")
    scope = allowed_portfolios(identity)
    if portfolio_id is not None and scope is not None and portfolio_id not in scope:
        raise HTTPException(404, "This record is not available.")


def allowed_portfolios(identity: dict[str, Any]) -> list[ObjectId] | None:
    """Return explicit restricted scope, or None for unrestricted portfolio access."""
    role = identity["role"]["name"]
    access = identity["user"]["portfolioAccess"]
    return access if role == "Portfolio Leader" or (role == "Engineer" and access) else None
