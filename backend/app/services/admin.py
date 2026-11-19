"""Maintain accounts and configurable stable roles with conservative authorization."""

from typing import Any, get_args
from bson import ObjectId
from fastapi import HTTPException
from pymongo.errors import DuplicateKeyError
from app.core.security import hash_password, require_permission
from app.repositories.base import object_id
from app.repositories.identity import IdentityRepository
from app.repositories.audit import AuditRepository
from app.schemas.auth import RoleName, PublicUser
from app.schemas.admin import UserPayload, UserCreate, RolePayload, PublicRole
from app.services.identity import IdentityService


class AdminService:
    """Require Administrator and live administer permission for every operation.

    Notes:
        No last-administrator restriction is inferred; configured permissions
        remain editable and may remove the acting administrator's future access.
    """

    def __init__(self, repository: IdentityRepository, audit: AuditRepository) -> None:
        """Reuse identity persistence and secret-free public account serialization."""
        self.repository = repository
        self.audit = audit
        self.identity_service = IdentityService(repository, audit, "")

    async def users(self, identity: dict[str, Any], page: int = 1, page_size: int = 10) -> dict[str, Any]:
        """Return a bounded account page after sensitive-area authorization."""
        require_permission(identity, "administer", administrator_only=True)
        result = await self.repository.admin_users(page, page_size)
        result["items"] = [await self.identity_service.public_user(user) for user in result["items"]]
        return result

    async def fields(self, payload: UserPayload) -> dict[str, Any]:
        """Resolve stable roles and refuse missing portfolio assignments."""
        role = await self.repository.role_by_name(payload.role)
        if not role:
            raise HTTPException(422, {"role": "Select an existing role."})
        ids = [ObjectId(value) for value in payload.portfolioAccess]
        if not await self.repository.portfolios_exist(ids):
            raise HTTPException(422, {"portfolioAccess": "Select existing portfolios."})
        fields = payload.model_dump(exclude={"role", "initialPassword"})
        fields.update(roleId=role["_id"], portfolioAccess=ids)
        return fields

    async def create(self, identity: dict[str, Any], payload: UserCreate) -> PublicUser:
        """Create and audit a unique account, returning only persisted public facts."""
        require_permission(identity, "administer", administrator_only=True)
        fields = await self.fields(payload)
        fields.update(passwordHash=await hash_password(payload.initialPassword), authVersion=0,
                      mustChangePassword=False, lastSignIn=None,
                      defaultLanding="Dashboard" if payload.role in ("Administrator", "Executive") else "Applications")
        try:
            saved = await self.repository.create_user(fields)
        except DuplicateKeyError as exc:
            raise HTTPException(409, {"email": "A user with this email already exists."}) from exc
        await self.audit.write(identity["user"], "create", "user", saved["_id"], "Created user account.")
        return await self.identity_service.public_user(saved)

    async def update(self, identity: dict[str, Any], user_id: str, payload: UserPayload) -> PublicUser:
        """Edit account facts; deactivate without deleting history and revoke sessions."""
        require_permission(identity, "administer", administrator_only=True)
        oid = object_id(user_id)
        previous = await self.repository.user_by_id(oid)
        if not previous:
            raise HTTPException(404, "This record is not available.")
        fields = await self.fields(payload)
        try:
            saved = await self.repository.admin_update_user(oid, fields)
        except DuplicateKeyError as exc:
            raise HTTPException(409, {"email": "A user with this email already exists."}) from exc
        if not saved:
            raise HTTPException(404, "This record is not available.")
        if saved["status"] == "Inactive":
            await self.repository.revoke_all(oid)
        await self.audit.write(identity["user"], "edit", "user", oid,
                               "Deactivated user account." if saved["status"] == "Inactive" else "Updated user account.")
        if previous["roleId"] != saved["roleId"]:
            await self.audit.write(identity["user"], "role change", "user", oid, "Changed user role.")
        return await self.identity_service.public_user(saved)

    async def roles(self, identity: dict[str, Any]) -> list[PublicRole]:
        """Return exactly the supported stored role configurations, not UI constants."""
        require_permission(identity, "administer", administrator_only=True)
        return [PublicRole(id=row["_id"], **{key: row[key] for key in ("name", "description", "permissions")})
                for row in await self.repository.admin_roles(list(get_args(RoleName)))]

    async def update_role(self, identity: dict[str, Any], role_id: str, payload: RolePayload) -> PublicRole:
        """Persist role configuration and audit description and permission changes."""
        require_permission(identity, "administer", administrator_only=True)
        oid = object_id(role_id)
        previous = await self.repository.role(oid)
        if not previous or previous["name"] not in get_args(RoleName):
            raise HTTPException(404, "This record is not available.")
        saved = await self.repository.admin_update_role(oid, payload.model_dump())
        if not saved:
            raise HTTPException(404, "This record is not available.")
        await self.audit.write(identity["user"], "edit", "role", oid, "Updated role configuration.")
        if set(previous["permissions"]) != set(saved["permissions"]):
            await self.audit.write(identity["user"], "permission change", "role", oid, "Changed role permissions.")
        return PublicRole(id=saved["_id"], name=saved["name"], description=saved["description"], permissions=saved["permissions"])
