"""Enforce application lifecycle authorization and audited, scoped CSV exports."""

import csv
import io
from typing import Any
from fastapi import HTTPException
from pymongo.errors import DuplicateKeyError
from app.core.security import allowed_portfolios, require_permission
from app.repositories.base import object_id
from app.repositories.applications import ApplicationRepository
from app.repositories.audit import AuditRepository
from app.schemas.applications import ApplicationPayload

CSV_COLUMNS = [("Name", "name"), ("Portfolio", "portfolio"), ("Criticality", "criticality"),
               ("Tier", "tier"), ("Lifecycle", "lifecycle"), ("Health", "healthScore"),
               ("Automation %", "automationCoverage"), ("Open Critical Defects", "openCriticalDefects"), ("Risk", "risk")]


def safe_cell(value: Any) -> str:
    """Neutralize spreadsheet formulas, including leading whitespace and controls."""
    text = str(value)
    return "'" + text if text.lstrip().startswith(("=", "+", "-", "@")) or text.startswith(("\t", "\r", "\n")) else text


class ApplicationService:
    """Apply current permission, role, forced-change, and portfolio boundaries."""

    def __init__(self, repository: ApplicationRepository, audit: AuditRepository) -> None:
        """Retain shared persistence boundaries without creating a new pool."""
        self.repository = repository
        self.audit = audit

    async def list(self, identity: dict[str, Any], filters: dict[str, Any], page: int = 1,
                   page_size: int = 10) -> dict[str, Any]:
        """Read only permitted records and options after current view checks."""
        require_permission(identity, "view")
        return await self.repository.filtered(allowed_portfolios(identity), filters, page, page_size)

    async def detail(self, identity: dict[str, Any], application_id: str) -> dict[str, Any]:
        """Return identical unavailable errors for missing and hidden records."""
        require_permission(identity, "view")
        row = await self.repository.detail(object_id(application_id), allowed_portfolios(identity))
        if row is None:
            raise HTTPException(404, "This record is not available.")
        return row

    async def target(self, identity: dict[str, Any], permission: str, portfolio_id: str) -> None:
        """Require maintenance role, matching permission, and an accessible existing target."""
        require_permission(identity, permission)
        if identity["role"]["name"] not in ("Administrator", "Portfolio Leader", "Engineer"):
            raise HTTPException(403, "You do not have permission for this action.")
        oid = object_id(portfolio_id)
        require_permission(identity, permission, oid)
        if not await self.repository.portfolio_exists(oid):
            raise HTTPException(404, "This record is not available.")

    async def create(self, identity: dict[str, Any], payload: ApplicationPayload) -> dict[str, Any]:
        """Persist every validated field, audit creation, and re-read the stored result."""
        require_permission(identity, "view")
        await self.target(identity, "create", payload.portfolioId)
        fields = {**payload.model_dump(), "portfolioId": object_id(payload.portfolioId)}
        try:
            oid = await self.repository.create(fields)
        except DuplicateKeyError as exc:
            raise HTTPException(409, {"name": "An application with this name already exists."}) from exc
        await self.audit.write(identity["user"], "create", "application", oid, "Created application.")
        return await self.detail(identity, str(oid))

    async def update(self, identity: dict[str, Any], application_id: str, payload: ApplicationPayload) -> dict[str, Any]:
        """Check existing and target scope before any move or maintained-field update."""
        existing = await self.detail(identity, application_id)
        await self.target(identity, "edit", existing["portfolioId"])
        await self.target(identity, "edit", payload.portfolioId)
        oid = object_id(application_id)
        fields = {**payload.model_dump(), "portfolioId": object_id(payload.portfolioId)}
        try:
            saved = await self.repository.update(oid, fields)
        except DuplicateKeyError as exc:
            raise HTTPException(409, {"name": "An application with this name already exists."}) from exc
        if not saved:
            raise HTTPException(404, "This record is not available.")
        await self.audit.write(identity["user"], "edit", "application", oid, "Updated application.")
        return await self.detail(identity, application_id)

    async def delete(self, identity: dict[str, Any], application_id: str) -> None:
        """Allow only authorized administrators to delete and audit an existing record."""
        existing = await self.detail(identity, application_id)
        require_permission(identity, "delete", object_id(existing["portfolioId"]), administrator_only=True)
        oid = object_id(application_id)
        if not await self.repository.delete(oid):
            raise HTTPException(404, "This record is not available.")
        await self.audit.write(identity["user"], "delete", "application", oid, "Deleted application.")

    async def export(self, identity: dict[str, Any], filters: dict[str, Any]) -> str:
        """Export all matching scoped rows and persist an event before returning UTF-8 CSV."""
        require_permission(identity, "view")
        require_permission(identity, "export")
        if identity["role"]["name"] == "Read Only":
            raise HTTPException(403, "You do not have permission for this action.")
        rows = await self.repository.matching(allowed_portfolios(identity), filters)
        output = io.StringIO(newline="")
        writer = csv.writer(output)
        writer.writerow([label for label, _ in CSV_COLUMNS])
        writer.writerows([[safe_cell(row[field]) for _, field in CSV_COLUMNS] for row in rows])
        await self.audit.write(identity["user"], "export", "application", None, f"Exported {len(rows)} matching applications.")
        return output.getvalue()
