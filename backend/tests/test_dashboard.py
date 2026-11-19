"""Verify dashboard formulas and permission boundaries against isolated real MongoDB."""

from datetime import datetime, timedelta, timezone
import pytest
from bson import ObjectId
from fastapi import HTTPException
from app.core.security import authenticate_token
from app.repositories.identity import IdentityRepository
from app.repositories.dashboard import DashboardRepository
from app.services.dashboard import DashboardService, rounded_average


async def login(client, local="executive") -> dict[str, str]:
    """Obtain a real persisted bearer through the authentication endpoint."""
    response = await client.post("/api/v1/auth/login", json={"email": f"{local}@portfolio.local", "password": "PortalDemo123!"})
    assert response.status_code == 200
    return {"Authorization": f"Bearer {response.json()['token']}"}


def expected(quality, health, automation, defects, high, apps, portfolios) -> dict[str, int]:
    """Name independently supplied expected values without calling production formulas."""
    return dict(enterpriseQualityScore=quality, applicationHealth=health, automationMaturity=automation,
                openCriticalDefects=defects, applicationsAtRisk=high, totalApplications=apps, totalPortfolios=portfolios)


@pytest.mark.parametrize("total,count,result", [(0, 0, 0), (1, 2, 1), (161, 2, 81), (160, 2, 80), (100, 1, 100), (1, 3, 0)])
def test_average_rounds_half_up_and_empty_to_zero(total, count, result):
    """Cover ties, boundaries, non-ties, and division by zero."""
    assert rounded_average(total, count) == result


async def test_seeded_metrics_and_linked_breakdowns_are_independent(client, db):
    """Assert fixed sums: quality 761, health 760, automation 618, critical defects 11."""
    headers = await login(client)
    response = await client.get("/api/v1/dashboard", headers=headers)
    assert response.status_code == 200
    data = response.json()
    assert data["metrics"] == expected(76, 76, 62, 11, 3, 10, 3)
    assert [(row["name"], row["qualityScore"]) for row in data["portfolioQuality"]] == [
        ("Customer Platform", 83), ("Data & Analytics", 75), ("Payments", 72)]
    assert [(row["name"], [app["name"] for app in row["applications"]]) for row in data["applicationsAtRisk"]] == [
        ("Data & Analytics", ["Batch Data Loader"]), ("Payments", ["Fraud Signals", "Payment Gateway"])]
    for row in data["portfolioQuality"]:
        assert (await client.get(f"/api/v1/portfolios/{row['id']}", headers=headers)).status_code == 200
    for row in data["applicationsAtRisk"]:
        for app in row["applications"]:
            detail = await client.get(f"/api/v1/applications/{app['id']}", headers=headers)
            assert detail.status_code == 200
            assert detail.json()["risk"] == "High"
    assert await db.applications.count_documents({}) == 10


@pytest.mark.parametrize("filters,metrics,quality,risk_names", [
    ({"productArea": "Commerce"}, (72, 69, 56, 8, 2, 4, 1), [("Payments", 72)], ["Fraud Signals", "Payment Gateway"]),
    ({"risk": "High"}, (68, 62, 50, 9, 3, 3, 2), [("Data & Analytics", 59), ("Payments", 72)], ["Batch Data Loader", "Fraud Signals", "Payment Gateway"]),
    ({"productArea": "Commerce", "risk": "Medium"}, (72, 72, 53, 1, 0, 2, 1), [("Payments", 72)], []),
    ({"productArea": "Customer", "risk": "High"}, (0, 0, 0, 0, 0, 0, 0), [], []),
])
async def test_filters_apply_to_every_tile_and_breakdown(client, filters, metrics, quality, risk_names):
    """Compare literal independent expectations for single and combined filters."""
    response = await client.get("/api/v1/dashboard", params=filters, headers=await login(client))
    assert response.status_code == 200
    data = response.json()
    assert data["metrics"] == expected(*metrics)
    assert [(row["name"], row["qualityScore"]) for row in data["portfolioQuality"]] == quality
    assert [app["name"] for row in data["applicationsAtRisk"] for app in row["applications"]] == risk_names


async def test_three_filters_use_application_product_area_and_persisted_edits(client, db):
    """Distinguish application area from portfolio area and recompute after stored edits."""
    payments = await db.portfolios.find_one({"name": "Payments"})
    await db.applications.update_one({"name": "Payment Gateway"}, {"$set": {"productArea": "Special", "qualityScore": 81}})
    params = {"portfolioId": str(payments["_id"]), "productArea": "Special", "risk": "High"}
    headers = await login(client)
    response = await client.get("/api/v1/dashboard", params=params, headers=headers)
    assert response.status_code == 200
    data = response.json()
    assert data["metrics"] == expected(81, 72, 64, 3, 1, 1, 1)
    assert data["portfolioQuality"] == [{"id": str(payments["_id"]), "name": "Payments", "qualityScore": 81}]
    assert [app["name"] for row in data["applicationsAtRisk"] for app in row["applications"]] == ["Payment Gateway"]
    assert "Special" in data["productAreas"]
    params["portfolioId"] = str((await db.portfolios.find_one({"name": "Customer Platform"}))["_id"])
    empty = await client.get("/api/v1/dashboard", params=params, headers=headers)
    assert empty.status_code == 200
    assert empty.json()["metrics"] == expected(0, 0, 0, 0, 0, 0, 0)


async def test_empty_portfolios_count_only_when_unfiltered_and_scoped(client, db):
    """Include a permitted empty portfolio in totals but not represented filtered bars."""
    empty_id = (await db.portfolios.insert_one({"name": "Empty", "productArea": "Empty Area"})).inserted_id
    await db.users.update_one({"email": "engineer@portfolio.local"}, {"$push": {"portfolioAccess": empty_id}})
    headers = await login(client, "engineer")
    data = (await client.get("/api/v1/dashboard", headers=headers)).json()
    assert data["metrics"] == expected(72, 69, 56, 8, 2, 4, 2)
    assert [row["name"] for row in data["portfolios"]] == ["Empty", "Payments"]
    filtered = await client.get("/api/v1/dashboard", params={"portfolioId": str(empty_id)}, headers=headers)
    assert filtered.status_code == 200
    assert filtered.json()["metrics"] == expected(0, 0, 0, 0, 0, 0, 0)
    assert filtered.json()["portfolioQuality"] == []
    assert filtered.json()["applicationsAtRisk"] == []
    await db.applications.delete_many({})
    empty = await client.get("/api/v1/dashboard", headers=headers)
    assert empty.status_code == 200
    assert empty.json()["metrics"] == expected(0, 0, 0, 0, 0, 0, 2)
    assert empty.json()["productAreas"] == []
    assert empty.json()["risks"] == []


async def test_hidden_options_aggregates_and_forged_filter_do_not_leak(client, db):
    """Refuse disclosure through totals, choices, breakdowns, or hidden identifiers."""
    hidden = await db.portfolios.find_one({"name": "Data & Analytics"})
    await db.applications.update_one({"name": "Batch Data Loader"}, {"$set": {"productArea": "Secret", "qualityScore": 100}})
    headers = await login(client, "engineer")
    data = (await client.get("/api/v1/dashboard", headers=headers)).json()
    assert data["metrics"] == expected(72, 69, 56, 8, 2, 4, 1)
    assert data["productAreas"] == ["Commerce"]
    assert data["risks"] == ["High", "Medium"]
    assert "Secret" not in str(data) and "Data & Analytics" not in str(data)
    for oid in [str(hidden["_id"]), str(ObjectId())]:
        response = await client.get("/api/v1/dashboard", params={"portfolioId": oid}, headers=headers)
        assert response.status_code == 200
        assert response.json()["metrics"] == expected(0, 0, 0, 0, 0, 0, 0)
        assert response.json()["portfolioQuality"] == []
        assert response.json()["applicationsAtRisk"] == []
    await db.users.update_one({"email": "engineer@portfolio.local"}, {"$set": {"portfolioAccess": []}})
    assert (await client.get("/api/v1/dashboard", headers=headers)).json()["metrics"]["totalApplications"] == 10
    leader = await login(client, "leader")
    await db.users.update_one({"email": "leader@portfolio.local"}, {"$set": {"portfolioAccess": []}})
    response = await client.get("/api/v1/dashboard", headers=leader)
    assert response.status_code == 200
    assert response.json()["metrics"] == expected(0, 0, 0, 0, 0, 0, 0)
    assert response.json()["portfolios"] == response.json()["productAreas"] == response.json()["risks"] == []


@pytest.mark.parametrize("local,total,portfolios", [("admin", 10, 3), ("executive", 10, 3), ("leader", 7, 2), ("engineer", 4, 1), ("auditor", 10, 3), ("readonly", 10, 3)])
async def test_every_view_role_reads_without_mutation(client, db, local, total, portfolios):
    """Allow all six current view roles while offering no dashboard write endpoint."""
    if local == "admin":
        await db.users.update_one({"email": "admin@portfolio.local"}, {"$set": {"mustChangePassword": False}})
    headers = await login(client, local)
    before = await db.audit.count_documents({})
    response = await client.get("/api/v1/dashboard", headers=headers)
    assert response.status_code == 200
    assert response.json()["metrics"]["totalApplications"] == total
    assert response.json()["metrics"]["totalPortfolios"] == portfolios
    for method in [client.post, client.put, client.delete]:
        assert (await method("/api/v1/dashboard", headers=headers)).status_code == 405
    assert await db.audit.count_documents({}) == before


@pytest.mark.parametrize("params", [{"risk": "Critical"}, {"portfolioId": "invalid"}, {"portfolioId": ""}, {"productArea": "x" * 201}])
async def test_invalid_filters_return_validation_errors(client, params):
    """Reject malformed identifiers, classifications, and oversized strings."""
    response = await client.get("/api/v1/dashboard", params=params, headers=await login(client))
    assert response.status_code == 422
    assert "detail" in response.json()


async def test_operator_input_is_literal_and_returns_zero(client):
    """Never interpret product-area strings as Mongo operators or regular expressions."""
    response = await client.get("/api/v1/dashboard", params={"productArea": '{"$ne":null}'}, headers=await login(client))
    assert response.status_code == 200
    assert response.json()["metrics"] == expected(0, 0, 0, 0, 0, 0, 0)


async def test_no_invalid_expired_revoked_and_inactive_sessions_are_denied(client, db):
    """Check the live session boundary rather than overriding authentication."""
    for headers in [{}, {"Authorization": "Bearer invalid"}]:
        response = await client.get("/api/v1/dashboard", headers=headers)
        assert response.status_code == 401
        assert "detail" in response.json()
    headers = await login(client)
    await db.sessions.update_many({}, {"$set": {"expiresAt": datetime.now(timezone.utc) - timedelta(seconds=1)}})
    assert (await client.get("/api/v1/dashboard", headers=headers)).status_code == 401
    headers = await login(client)
    await client.post("/api/v1/auth/logout", headers=headers)
    assert (await client.get("/api/v1/dashboard", headers=headers)).status_code == 401
    headers = await login(client)
    await db.users.update_one({"email": "executive@portfolio.local"}, {"$set": {"status": "Inactive"}})
    assert (await client.get("/api/v1/dashboard", headers=headers)).status_code == 401


async def test_forced_password_and_current_permission_are_checked_each_request(client, db):
    """Block forced sessions and immediately honor changed view permissions."""
    admin = await login(client, "admin")
    response = await client.get("/api/v1/dashboard", headers=admin)
    assert response.status_code == 403
    assert response.json()["detail"] == "Change your initial password before continuing."
    headers = await login(client)
    assert (await client.get("/api/v1/dashboard", headers=headers)).status_code == 200
    await db.roles.update_one({"name": "Executive"}, {"$set": {"permissions": []}})
    response = await client.get("/api/v1/dashboard", headers=headers)
    assert response.status_code == 403
    assert response.json()["detail"] == "You do not have permission for this action."


async def test_service_reads_real_repository_and_fails_closed(client, db, application):
    """Exercise the service directly with real current identity and stored Mongo data."""
    headers = await login(client)
    identity = await authenticate_token(headers["Authorization"][7:], IdentityRepository(db), application.state.settings.JWT_SECRET)
    service = DashboardService(DashboardRepository(db))
    assert (await service.read(identity)).metrics.model_dump() == expected(76, 76, 62, 11, 3, 10, 3)
    assert (await service.read(identity, risk="Low")).metrics.model_dump() == expected(84, 87, 73, 0, 0, 4, 2)
    identity["role"]["permissions"] = []
    with pytest.raises(HTTPException) as denied:
        await service.read(identity)
    assert denied.value.status_code == 403
