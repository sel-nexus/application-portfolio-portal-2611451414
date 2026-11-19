"""Authorize persisted history inspection and filtered, self-auditing CSV."""

import csv
import io
from datetime import datetime, time, timezone
from typing import Any
from fastapi import HTTPException
from app.core.security import require_permission
from app.repositories.audit import AuditRepository
from app.schemas.audit import AuditFilters, AuditPage
from app.services.applications import safe_cell

CSV_FIELDS = ("time", "person", "action", "entityType", "summary")


def audit_query(filters: AuditFilters) -> dict[str, Any]:
    """Build literal equality filters with inclusive UTC whole-day bounds.

    Raises:
        HTTPException: The calendar interval is reversed.
    """
    if filters.from_date and filters.to_date and filters.from_date > filters.to_date:
        raise HTTPException(422, {"to": "To date must be on or after From date."})
    query: dict[str, Any] = {}
    for key in ("person", "action"):
        value = getattr(filters, key)
        if value:
            query[key] = value
    bounds = {}
    if filters.from_date:
        bounds["$gte"] = datetime.combine(filters.from_date, time.min, timezone.utc)
    if filters.to_date:
        bounds["$lte"] = datetime.combine(filters.to_date, time.max, timezone.utc)
    if bounds:
        query["time"] = bounds
    return query


class AuditService:
    """Keep audit access narrower than configurable inventory permissions."""

    def __init__(self, repository: AuditRepository) -> None:
        """Reuse prior events and the lifespan-owned database pool."""
        self.repository = repository

    def authorize(self, identity: dict[str, Any], export: bool = False) -> None:
        """Require Administrator administer, or Auditor view for inspection only."""
        if identity["role"]["name"] == "Auditor" and not export:
            require_permission(identity, "view")
        else:
            require_permission(identity, "administer", administrator_only=True)
        if export:
            require_permission(identity, "export", administrator_only=True)

    async def list(self, identity: dict[str, Any], filters: AuditFilters,
                   page: int = 1, page_size: int = 10) -> AuditPage:
        """Read newest matching event facts and history-derived filter choices."""
        self.authorize(identity)
        result = await self.repository.filtered(audit_query(filters), page, page_size)
        return AuditPage.model_validate({**result, **await self.repository.choices()})

    async def export(self, identity: dict[str, Any], filters: AuditFilters) -> str:
        """Export all matching facts before persisting this download's own event.

        Notes:
            The new export event appears on subsequent reads, not in its own CSV.
            Persistence failures propagate so no unaudited CSV is returned.
        """
        self.authorize(identity, export=True)
        query = audit_query(filters)
        rows = []
        page = 1
        while True:
            result = await self.repository.filtered(query, page, 100)
            rows.extend(result["items"])
            if page * 100 >= result["total"]:
                break
            page += 1
        output = io.StringIO(newline="")
        writer = csv.writer(output)
        writer.writerow(CSV_FIELDS)
        for row in rows:
            row["time"] = row["time"].astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
            writer.writerow([safe_cell(row[field]) for field in CSV_FIELDS])
        await self.repository.write(identity["user"], "export", "audit", None,
                                    f"Exported {len(rows)} matching audit rows.")
        return output.getvalue()
