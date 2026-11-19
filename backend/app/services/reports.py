"""Produce scoped inventory reports and audit safe CSV downloads."""

import csv
import io
from typing import Any
from fastapi import HTTPException
from app.core.security import allowed_portfolios, require_permission
from app.repositories.applications import ApplicationRepository
from app.repositories.portfolios import PortfolioRepository
from app.repositories.audit import AuditRepository
from app.services.applications import CSV_COLUMNS, safe_cell

PORTFOLIO_COLUMNS = [("Name", "name"), ("Owner", "owner"), ("Product Area", "productArea"),
                     ("Applications", "applicationCount"), ("Quality Score", "qualityScore"), ("Status", "status")]


class ReportService:
    """Reuse the inventory query contracts and the lifespan-owned persistence pool."""

    def __init__(self, applications: ApplicationRepository, portfolios: PortfolioRepository,
                 audit: AuditRepository) -> None:
        """Retain existing repositories without creating another authoritative inventory."""
        self.applications = applications
        self.portfolios = portfolios
        self.audit = audit

    async def application_report(self, identity: dict[str, Any], filters: dict[str, Any],
                                 page: int = 1, page_size: int = 10) -> dict[str, Any]:
        """Return the current permitted application page and scope-safe choices."""
        require_permission(identity, "view")
        return await self.applications.filtered(allowed_portfolios(identity), filters, page, page_size)

    async def portfolio_report(self, identity: dict[str, Any], filters: dict[str, Any],
                               page: int = 1, page_size: int = 10) -> dict[str, Any]:
        """Return stored portfolio facts and computed counts and rounded quality."""
        require_permission(identity, "view")
        return await self.portfolios.filtered(allowed_portfolios(identity), **filters, page=page, page_size=page_size)

    async def export(self, identity: dict[str, Any], kind: str, filters: dict[str, Any]) -> str:
        """Export every matching permitted row, then persist the audit before returning.

        Raises:
            HTTPException: Current view/export permission or release role forbids export.
            ValueError: The report kind is not supported.
        """
        require_permission(identity, "view")
        require_permission(identity, "export")
        if identity["role"]["name"] == "Read Only":
            raise HTTPException(403, "You do not have permission for this action.")
        if kind == "applications":
            rows = await self.applications.matching(allowed_portfolios(identity), filters)
            columns = CSV_COLUMNS
        elif kind == "portfolios":
            rows = []
            page = 1
            while True:
                result = await self.portfolio_report(identity, filters, page, 100)
                rows.extend(result["items"])
                if page * 100 >= result["total"]:
                    break
                page += 1
            columns = PORTFOLIO_COLUMNS
        else:
            raise ValueError("Unsupported report")
        output = io.StringIO(newline="")
        writer = csv.writer(output)
        writer.writerow([label for label, _ in columns])
        writer.writerows([[safe_cell(row[field]) for _, field in columns] for row in rows])
        await self.audit.write(identity["user"], "export", "report", None,
                               f"Exported {len(rows)} matching {kind} report rows.")
        return output.getvalue()
