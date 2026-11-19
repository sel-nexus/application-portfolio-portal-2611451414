"""Verify report tables, CSV integrity and current authorization on real MongoDB."""

import csv
import io
from datetime import datetime, timedelta, timezone
from typing import Any
import pytest
from bson import ObjectId
from fastapi import HTTPException
from app.core.security import authenticate_token
from app.repositories.identity import IdentityRepository
from app.repositories.applications import ApplicationRepository
from app.repositories.portfolios import PortfolioRepository
from app.repositories.audit import AuditRepository
from app.services.reports import ReportService

APP_HEADERS = ["Name", "Portfolio", "Criticality", "Tier", "Lifecycle", "Health", "Automation %", "Open Critical Defects", "Risk"]
PORT_HEADERS = ["Name", "Owner", "Product Area", "Applications", "Quality Score", "Status"]
APP_FIELDS = ["name", "portfolio", "criticality", "tier", "lifecycle", "healthScore", "automationCoverage", "openCriticalDefects", "risk"]
PORT_FIELDS = ["name", "owner", "productArea", "applicationCount", "qualityScore", "status"]
PATHS = ["applications", "portfolios", "applications/csv", "portfolios/csv"]


async def login(client: Any, local: str = "executive") -> dict[str, str]:
    """Issue a persisted session through the real sign-in endpoint."""
    response = await client.post("/api/v1/auth/login", json={"email": f"{local}@portfolio.local", "password": "PortalDemo123!"})
    assert response.status_code == 200
    return {"Authorization": f"Bearer {response.json()['token']}"}


def reports(db: Any) -> ReportService:
    """Construct real repositories sharing the fixture's lifespan-owned pool."""
    return ReportService(ApplicationRepository(db), PortfolioRepository(db), AuditRepository(db))


async def identity(db: Any, application: Any, headers: dict[str, str]) -> dict[str, Any]:
    """Resolve current stored permission and scope instead of inventing a test identity."""
    return await authenticate_token(headers["Authorization"][7:], IdentityRepository(db), application.state.settings.JWT_SECRET)


@pytest.mark.parametrize("kind,fields,headers", [("applications", APP_FIELDS, APP_HEADERS), ("portfolios", PORT_FIELDS, PORT_HEADERS)])
async def test_tables_and_csv_match_all_stored_rows_and_audit(client, db, kind, fields, headers):
    """Check exact CSV columns, values, encoding, attachment and persisted export facts."""
    auth = await login(client)
    table = await client.get(f"/api/v1/reports/{kind}", headers=auth, params={"page_size": 100})
    assert table.status_code == 200
    rows = table.json()["items"]
    assert table.json()["total"] == (10 if kind == "applications" else 3)
    if kind == "portfolios":
        assert [(r["name"], r["applicationCount"], r["qualityScore"]) for r in rows] == [
            ("Customer Platform", 3, 83), ("Data & Analytics", 3, 75), ("Payments", 4, 72)]
    exported = await client.get(f"/api/v1/reports/{kind}/csv", headers=auth, params={"page": 2, "page_size": 1})
    assert exported.status_code == 200
    assert exported.headers["content-type"] == "text/csv; charset=utf-8"
    assert "attachment; filename=" in exported.headers["content-disposition"]
    parsed = list(csv.reader(io.StringIO(exported.content.decode("utf-8"))))
    assert parsed == [headers] + [[str(row[field]) for field in fields] for row in rows]
    event = await db.audit.find_one({"action": "export", "entityType": "report"})
    user = await db.users.find_one({"email": "executive@portfolio.local"})
    assert event["personId"] == user["_id"] and event["person"] == user["name"]
    assert event["entityId"] is None and event["time"].tzinfo is not None
    assert event["summary"] == f"Exported {len(rows)} matching {kind} report rows."
    assert "password" not in event["summary"].lower()
    again = await client.get(f"/api/v1/reports/{kind}", headers=await login(client), params={"page_size": 100})
    assert again.status_code == 200 and again.json()["items"] == rows
    assert await db.audit.count_documents({"action": "export", "entityType": "report"}) == 1


@pytest.mark.parametrize("kind", ["applications", "portfolios"])
async def test_service_pages_filters_empty_and_invalid_paging(db, application, client, kind):
    """Exercise service methods with real queries and reject invalid paging boundaries."""
    actor = await identity(db, application, await login(client))
    service = reports(db)
    filters = {} if kind == "applications" else {"search": "", "status": None, "product_area": None}
    method = service.application_report if kind == "applications" else service.portfolio_report
    first = await method(actor, filters, 1, 1)
    second = await method(actor, filters, 2, 1)
    assert first["items"][0]["id"] != second["items"][0]["id"]
    assert first["total"] == second["total"] == (10 if kind == "applications" else 3)
    assert (await method(actor, {**filters, "search": "no such inventory"}))["items"] == []
    assert list(csv.reader(io.StringIO(await service.export(actor, kind, {**filters, "search": "no such inventory"})))) == [APP_HEADERS if kind == "applications" else PORT_HEADERS]
    for page, size in [(0, 10), (1, 0), (1, 101)]:
        with pytest.raises(ValueError, match="Invalid pagination"):
            await method(actor, filters, page, size)
    with pytest.raises(ValueError, match="Unsupported report"):
        await service.export(actor, "unknown", filters)


@pytest.mark.parametrize("kind", ["applications", "portfolios"])
async def test_combined_filters_equal_inventory_and_csv(client, db, kind):
    """Exercise every optional filter with paging while exports include every match."""
    auth = await login(client)
    payments = await db.portfolios.find_one({"name": "Payments"})
    filters = {"search": "", "portfolioId": str(payments["_id"]), "criticality": "Critical", "risk": "High", "lifecycle": "Active"} if kind == "applications" else {
        "search": "pay", "status": "Active", "productArea": "Commerce"}
    table = await client.get(f"/api/v1/reports/{kind}", params={**filters, "page_size": 1, "page": 1}, headers=auth)
    inventory = await client.get(f"/api/v1/{kind}", params={**filters, "page_size": 1}, headers=auth)
    assert table.status_code == inventory.status_code == 200 and table.json() == inventory.json()
    export = await client.get(f"/api/v1/reports/{kind}/csv", params=filters, headers=auth)
    assert export.status_code == 200
    all_rows = await client.get(f"/api/v1/reports/{kind}", params={**filters, "page_size": 100}, headers=auth)
    assert all_rows.status_code == 200
    fields = APP_FIELDS if kind == "applications" else PORT_FIELDS
    assert list(csv.reader(io.StringIO(export.text)))[1:] == [[str(r[f]) for f in fields] for r in all_rows.json()["items"]]


@pytest.mark.parametrize("local,portfolios,apps", [("leader", 2, 7), ("engineer", 1, 4), ("auditor", 3, 10), ("readonly", 3, 10)])
async def test_scoped_tables_options_and_export(client, db, local, portfolios, apps):
    """Ensure classifications, choices, CSV and computed values never widen visibility."""
    auth = await login(client, local)
    p = await client.get("/api/v1/reports/portfolios", headers=auth)
    a = await client.get("/api/v1/reports/applications", headers=auth)
    assert p.status_code == a.status_code == 200
    assert p.json()["total"] == portfolios and a.json()["total"] == apps
    permitted = {r["id"] for r in p.json()["items"]}
    assert {r["id"] for r in a.json()["portfolios"]} == permitted
    assert {r["portfolioId"] for r in a.json()["items"]} <= permitted
    hidden = await db.portfolios.find_one({"_id": {"$nin": [ObjectId(v) for v in permitted]}})
    if hidden:
        for suffix in ["", "/csv"]:
            result = await client.get(f"/api/v1/reports/applications{suffix}", params={"portfolioId": str(hidden["_id"])}, headers=auth)
            assert result.status_code == 200
            assert result.json()["total"] == 0 if not suffix else list(csv.reader(io.StringIO(result.text))) == [APP_HEADERS]
        assert hidden["productArea"] not in p.json()["productAreas"]
    for kind in ["applications", "portfolios"]:
        result = await client.get(f"/api/v1/reports/{kind}/csv", headers=auth)
        assert result.status_code == (403 if local == "readonly" else 200)
        if local != "readonly":
            assert len(list(csv.reader(io.StringIO(result.text)))) == (apps if kind == "applications" else portfolios) + 1


@pytest.mark.parametrize("path", PATHS)
async def test_missing_invalid_expired_and_inactive_sessions_are_401(client, db, path):
    """Reject every report endpoint before returning any table or CSV data."""
    url = f"/api/v1/reports/{path}"
    for headers in [{}, {"Authorization": "Bearer invalid"}]:
        result = await client.get(url, headers=headers)
        assert result.status_code == 401 and "detail" in result.json()
    auth = await login(client)
    user = await db.users.find_one({"email": "executive@portfolio.local"})
    await db.sessions.update_many({"userId": user["_id"]}, {"$set": {"expiresAt": datetime.now(timezone.utc) - timedelta(seconds=1)}})
    assert (await client.get(url, headers=auth)).status_code == 401
    auth = await login(client)
    await db.users.update_one({"_id": user["_id"]}, {"$set": {"status": "Inactive"}})
    assert (await client.get(url, headers=auth)).status_code == 401


@pytest.mark.parametrize("path", PATHS)
async def test_current_permissions_forced_password_and_readonly_override(client, db, application, path):
    """Re-evaluate stored permissions and enforce the nonconfigurable Read Only export ban."""
    auth = await login(client)
    await db.roles.update_one({"name": "Executive"}, {"$set": {"permissions": ["export"]}})
    response = await client.get(f"/api/v1/reports/{path}", headers=auth)
    assert response.status_code == 403 and response.json()["detail"] == "You do not have permission for this action."
    actor = await identity(db, application, auth)
    service = reports(db)
    with pytest.raises(HTTPException) as denied:
        if path.endswith("csv"):
            await service.export(actor, path.split("/")[0], {})
        elif path == "applications":
            await service.application_report(actor, {})
        else:
            await service.portfolio_report(actor, {"search": "", "status": None, "product_area": None})
    assert denied.value.status_code == 403
    admin = await login(client, "admin")
    forced = await client.get(f"/api/v1/reports/{path}", headers=admin)
    assert forced.status_code == 403 and forced.json()["detail"] == "Change your initial password before continuing."
    if path.endswith("csv"):
        await db.roles.update_one({"name": "Executive"}, {"$set": {"permissions": ["view"]}})
        assert (await client.get(f"/api/v1/reports/{path}", headers=auth)).status_code == 403
        await db.roles.update_one({"name": "Read Only"}, {"$set": {"permissions": ["view", "export"]}})
        readonly = await login(client, "readonly")
        result = await client.get(f"/api/v1/reports/{path}", headers=readonly)
        assert result.status_code == 403
    assert await db.audit.count_documents({"action": "export", "entityType": "report"}) == 0


@pytest.mark.parametrize("kind,params,status", [
    ("applications", {"criticality": "Invalid"}, 422), ("applications", {"risk": "Critical"}, 422),
    ("applications", {"lifecycle": "Archived"}, 422), ("applications", {"portfolioId": "{\"$ne\":null}"}, 404),
    ("portfolios", {"status": "Invalid"}, 422), ("portfolios", {"productArea": "x" * 201}, 422),
    ("applications", {"search": "x" * 201}, 422), ("portfolios", {"search": "x" * 201}, 422)])
async def test_table_and_csv_invalid_filters(client, kind, params, status):
    """Use the same typed validation for the table and CSV filter contracts."""
    auth = await login(client)
    for suffix in ["", "/csv"]:
        result = await client.get(f"/api/v1/reports/{kind}{suffix}", params=params, headers=auth)
        assert result.status_code == status and "detail" in result.json()


@pytest.mark.parametrize("kind", ["applications", "portfolios"])
@pytest.mark.parametrize("params", [{"page": 0}, {"page": "no"}, {"page_size": 0}, {"page_size": 101}])
async def test_table_invalid_paging_422(client, kind, params):
    """Reject missing numeric validity and bounds on paged report endpoints."""
    result = await client.get(f"/api/v1/reports/{kind}", params=params, headers=await login(client))
    assert result.status_code == 422 and "detail" in result.json()


async def test_empty_leader_and_current_scope_requery(client, db):
    """Change assignments after login and observe fail-closed choices and exports."""
    auth = await login(client, "leader")
    await db.users.update_one({"email": "leader@portfolio.local"}, {"$set": {"portfolioAccess": []}})
    for kind in ["applications", "portfolios"]:
        result = await client.get(f"/api/v1/reports/{kind}", headers=auth)
        assert result.status_code == 200 and result.json()["items"] == [] and result.json()["total"] == 0
        assert result.json()["portfolios"] == [] if kind == "applications" else result.json()["productAreas"] == []
        export = await client.get(f"/api/v1/reports/{kind}/csv", headers=auth)
        assert export.status_code == 200 and len(list(csv.reader(io.StringIO(export.text)))) == 1


async def test_formula_unicode_quotes_newlines_and_literal_search(client, db):
    """Neutralize formulas in every text column while preserving valid UTF-8 CSV quoting."""
    auth = await login(client)
    payments = await db.portfolios.find_one({"name": "Payments"})
    await db.portfolios.update_one({"_id": payments["_id"]}, {"$set": {"name": "=SUM(1,2)", "owner": " +cmd", "productArea": "@équipe, \"quoted\"\nnext"}})
    app = await db.applications.find_one({"name": "Payment Gateway"})
    for value in ["=formula", "+formula", "-formula", "@formula", "  =formula", "\tformula", "\rformula", "\nformula", "Équipe, \"quoted\"\nnext"]:
        await db.applications.update_one({"_id": app["_id"]}, {"$set": {"name": value}})
        exported = await client.get("/api/v1/reports/applications/csv", params={"search": value}, headers=auth)
        assert exported.status_code == 200
        parsed = list(csv.reader(io.StringIO(exported.text)))
        expected = value if value.startswith("É") else "'" + value
        assert parsed[1][0] == expected and parsed[1][1] == "'=SUM(1,2)"
    exported = await client.get("/api/v1/reports/portfolios/csv", params={"search": "=SUM"}, headers=auth)
    assert exported.status_code == 200
    assert list(csv.reader(io.StringIO(exported.text)))[1][:3] == ["'=SUM(1,2)", "' +cmd", "'@équipe, \"quoted\"\nnext"]
    for kind in ["applications", "portfolios"]:
        for search in [".*", "{\"$ne\":null}", "<script>"]:
            result = await client.get(f"/api/v1/reports/{kind}", params={"search": search}, headers=auth)
            assert result.status_code == 200 and result.json()["total"] == 0


async def test_portfolio_export_spans_multiple_pages_and_empty_quality(client, db):
    """Prove the exporter does not stop at its first bounded database page."""
    await db.portfolios.insert_many([{"name": f"Report {n:03}", "owner": "Owner", "description": "", "productArea": "Bulk", "status": "Archived"} for n in range(101)])
    auth = await login(client)
    result = await client.get("/api/v1/reports/portfolios/csv", params={"productArea": "Bulk", "status": "Archived"}, headers=auth)
    assert result.status_code == 200
    rows = list(csv.reader(io.StringIO(result.text)))
    assert len(rows) == 102 and rows[1] == ["Report 000", "Owner", "Bulk", "0", "0", "Archived"]
    assert rows[-1][0] == "Report 100"
    assert (await db.audit.find_one({"action": "export", "entityType": "report"}))["summary"] == "Exported 101 matching portfolios report rows."


@pytest.mark.parametrize("kind", ["applications", "portfolios"])
async def test_export_audit_failure_returns_503_without_csv(client, db, kind):
    """Require successful real audit persistence before any CSV is returned."""
    auth = await login(client)
    await db.command({"collMod": "audit", "validator": {"action": {"$ne": "export"}}, "validationLevel": "strict"})
    result = await client.get(f"/api/v1/reports/{kind}/csv", headers=auth)
    assert result.status_code == 503
    assert result.json() == {"detail": "The service is unavailable. Please try again."}
    assert "content-disposition" not in result.headers
    assert await db.audit.count_documents({"action": "export", "entityType": "report"}) == 0


async def test_stored_updates_are_requeried_in_tables_and_exports(client, db):
    """Prove current stored metrics and referenced names replace previous report values."""
    auth = await login(client)
    before = await client.get("/api/v1/reports/portfolios", params={"search": "Payments"}, headers=auth)
    assert before.status_code == 200 and before.json()["items"][0]["qualityScore"] == 72
    await db.applications.update_many({"portfolioId": ObjectId(before.json()["items"][0]["id"])}, {"$set": {"qualityScore": 81, "healthScore": 100}})
    after = await client.get("/api/v1/reports/portfolios", params={"search": "Payments"}, headers=await login(client))
    assert after.status_code == 200 and after.json()["items"][0]["qualityScore"] == 81
    exported = await client.get("/api/v1/reports/portfolios/csv", params={"search": "Payments"}, headers=auth)
    assert exported.status_code == 200 and list(csv.reader(io.StringIO(exported.text)))[1][4] == "81"
    apps = await client.get("/api/v1/reports/applications", params={"portfolioId": before.json()["items"][0]["id"]}, headers=auth)
    assert apps.status_code == 200 and all(row["healthScore"] == 100 for row in apps.json()["items"])
