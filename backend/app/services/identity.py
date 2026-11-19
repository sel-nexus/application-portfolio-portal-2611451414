"""Coordinate identity validation, persisted sessions, profile edits, and safe auditing."""

from datetime import datetime, timedelta, timezone
from typing import Any
from fastapi import HTTPException
from app.core.security import create_token, hash_password, verify_password
from app.repositories.audit import AuditRepository
from app.repositories.identity import IdentityRepository
from app.schemas.auth import AuthResponse, LoginRequest, PasswordRequest, ProfileRequest, PublicUser


class IdentityService:
    """Apply account policies using real repositories and an injected signing key."""

    def __init__(self, repository: IdentityRepository, audit: AuditRepository, secret: str) -> None:
        """Retain persistence boundaries and the per-app signing key."""
        self.repository, self.audit, self.secret = repository, audit, secret

    async def public_user(self, user: dict[str, Any]) -> PublicUser:
        """Build an explicit allowlist response from current role and assignments."""
        role = await self.repository.role(user["roleId"])
        if not role:
            raise HTTPException(401, "Please sign in.")
        return PublicUser(id=user["_id"], name=user["name"], email=user["email"], role=role["name"],
            permissions=role["permissions"], portfolioAccess=user["portfolioAccess"],
            portfolioNames=await self.repository.portfolio_names(user["portfolioAccess"]),
            status=user["status"], managerName=user["managerName"], vendor=user["vendor"],
            mustChangePassword=user["mustChangePassword"], defaultLanding=user["defaultLanding"],
            lastSignIn=user.get("lastSignIn"))

    async def issue_session(self, user: dict[str, Any]) -> AuthResponse:
        """Persist an eight-hour session and return its signed bearer token."""
        public = await self.public_user(user)
        expires = datetime.now(timezone.utc) + timedelta(hours=8)
        session_id = await self.repository.create_session(user, expires)
        return AuthResponse(token=create_token(user["_id"], session_id, self.secret, expires), user=public)

    async def login(self, payload: LoginRequest) -> AuthResponse:
        """Audit all credential failures and open only active, valid accounts."""
        user = await self.repository.user_by_email(payload.email)
        if not user or not await verify_password(payload.password, user["passwordHash"]):
            await self.audit.write(user, "sign-in failure", "user", user["_id"] if user else None, "Sign-in refused: incorrect credentials.")
            raise HTTPException(401, "Email or password is incorrect.")
        if user["status"] != "Active":
            await self.audit.write(user, "sign-in failure", "user", user["_id"], "Sign-in refused: inactive account.")
            raise HTTPException(403, "This account is inactive.")
        user = await self.repository.update(user["_id"], {"lastSignIn": datetime.now(timezone.utc)})
        result = await self.issue_session(user)
        await self.audit.write(user, "sign-in success", "user", user["_id"], "Signed in successfully.")
        return result

    async def logout(self, identity: dict[str, Any]) -> None:
        """Revoke the current server session and preserve a sign-out audit event."""
        await self.repository.revoke(identity["session"]["_id"])
        await self.audit.write(identity["user"], "sign-out", "user", identity["user"]["_id"], "Signed out.")

    async def profile(self, identity: dict[str, Any], payload: ProfileRequest) -> PublicUser:
        """Persist only the landing preference, including during forced change."""
        user = await self.repository.update(identity["user"]["_id"], payload.model_dump())
        await self.audit.write(user, "edit", "user", user["_id"], "Updated default landing page.")
        return await self.public_user(user)

    async def password(self, identity: dict[str, Any], payload: PasswordRequest) -> AuthResponse:
        """Verify current password and confirmation, revoke old sessions, and replace.

        Notes:
            Credential version invalidates old sessions atomically on standalone MongoDB.
        """
        user = identity["user"]
        if not await verify_password(payload.currentPassword, user["passwordHash"]):
            raise HTTPException(422, {"currentPassword": "Current password is incorrect."})
        if payload.newPassword != payload.confirmation:
            raise HTTPException(422, {"confirmation": "Passwords do not match."})
        updated = await self.repository.change_password(user, await hash_password(payload.newPassword))
        if not updated:
            raise HTTPException(409, "Your password changed in another session. Please sign in again.")
        await self.repository.revoke_all(user["_id"])
        result = await self.issue_session(updated)
        await self.audit.write(updated, "edit", "user", user["_id"], "Changed password.")
        return result
