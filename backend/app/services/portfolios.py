"""Enforce scoped portfolio lifecycle rules and persist credential-free audit events."""

from typing import Any
from fastapi import HTTPException
from pymongo.errors import DuplicateKeyError
from app.core.security import allowed_portfolios, require_permission
from app.repositories.base import object_id
from app.repositories.audit import AuditRepository
from app.repositories.portfolios import PortfolioRepository
from app.schemas.portfolios import PortfolioPayload


class PortfolioService:
    """Apply release role restrictions in addition to configurable permissions."""

    def __init__(self, repository: PortfolioRepository, audit: AuditRepository) -> None:
        """Retain the shared inventory and audit repositories."""
        self.repository = repository
        self.audit = audit

    async def list(self, identity: dict[str, Any], search: str = "", status: str | None = None,
                   product_area: str | None = None, page: int = 1, page_size: int = 10) -> dict[str, Any]:
        """Read a permitted page and options after forced-password and view checks."""
        require_permission(identity, "view")
        return await self.repository.filtered(allowed_portfolios(identity), search, status, product_area, page, page_size)

    async def detail(self, identity: dict[str, Any], portfolio_id: str) -> dict[str, Any]:
        """Refuse missing and inaccessible identifiers with the same exact message."""
        require_permission(identity, "view")
        oid = object_id(portfolio_id)
        require_permission(identity, "view", oid)
        row = await self.repository.detail(oid)
        if row is None:
            raise HTTPException(404, "This record is not available.")
        return row

    async def create(self, identity: dict[str, Any], payload: PortfolioPayload) -> dict[str, Any]:
        """Allow administrator creation only and return the re-read persisted detail."""
        require_permission(identity, "create", administrator_only=True)
        try:
            oid = await self.repository.create(payload.model_dump())
        except DuplicateKeyError as exc:
            raise HTTPException(409, {"name": "A portfolio with this name already exists."}) from exc
        await self.audit.write(identity["user"], "create", "portfolio", oid, "Created portfolio.")
        return await self.detail(identity, str(oid))

    async def update(self, identity: dict[str, Any], portfolio_id: str, payload: PortfolioPayload) -> dict[str, Any]:
        """Allow only administrators or assigned leaders to edit a visible portfolio."""
        await self.detail(identity, portfolio_id)
        oid = object_id(portfolio_id)
        require_permission(identity, "edit", oid)
        if identity["role"]["name"] not in ("Administrator", "Portfolio Leader"):
            raise HTTPException(403, "You do not have permission for this action.")
        try:
            saved = await self.repository.update(oid, payload.model_dump())
        except DuplicateKeyError as exc:
            raise HTTPException(409, {"name": "A portfolio with this name already exists."}) from exc
        if not saved:
            raise HTTPException(404, "This record is not available.")
        await self.audit.write(identity["user"], "edit", "portfolio", oid, "Updated portfolio.")
        return await self.detail(identity, portfolio_id)

    async def delete(self, identity: dict[str, Any], portfolio_id: str) -> None:
        """Refuse occupied portfolios; audit only successfully removed empty records."""
        await self.detail(identity, portfolio_id)
        oid = object_id(portfolio_id)
        require_permission(identity, "delete", oid, administrator_only=True)
        if await self.repository.occupied(oid):
            raise HTTPException(409, "This portfolio contains applications. Move or delete them before deleting the portfolio.")
        if not await self.repository.delete(oid):
            raise HTTPException(404, "This record is not available.")
        await self.audit.write(identity["user"], "delete", "portfolio", oid, "Deleted empty portfolio.")
