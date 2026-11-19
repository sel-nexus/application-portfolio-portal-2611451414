"""Verify history queries, strict authorization and CSV using the real shared Mongo pool."""

import csv
import io
from datetime import date, datetime, timedelta, timezone
import pytest
from fastapi import HTTPException
from app.core.security import authenticate_token
from app.repositories.identity import IdentityRepository
from app.repositories.audit import AuditRepository
from app.schemas.audit import AuditFilters
from app.services.audit import AuditService


async def login(client, db, local="admin", forced=False):
    """Issue a real session, optionally retaining the seeded forced-change state."""
    if local == "admin" and not forced:
        await db.users.update_one({"email": "admin@portfolio.local"}, {"$set": {"mustChangePassword": False}})
    response = await client.post("/api/v1/auth/login", json={"email": f"{local}@portfolio.local", "password": "PortalDemo123!"})
    assert response.status_code == 200
    return {"Authorization": "Bearer " + response.json()["token"]}


async def actor(db, application, headers):
    """Resolve current persisted identity for direct service tests."""
    return await authenticate_token(headers["Authorization"][7:], IdentityRepository(db), application.state.settings.JWT_SECRET)


async def test_history_boundaries_exact_filters_newest_paging_and_choices(client, db, application):
    """Check UTC edge milliseconds, tie sorting, empty pages and choice retention."""
    auth = await login(client, db)
    times = [datetime(2025, 2, 1, tzinfo=timezone.utc), datetime(2025, 2, 2, tzinfo=timezone.utc),
             datetime(2025, 2, 2, 23, 59, 59, 999000, tzinfo=timezone.utc), datetime(2025, 2, 3, tzinfo=timezone.utc)]
    inserted = await db.audit.insert_many([{"time": t, "person": "Historical actor", "action": "edit", "entityType": "application",
        "entityId": None, "summary": f"Boundary {n}", "passwordHash": "secret-hash", "token": "secret-token"} for n, t in enumerate(times)])
    filters = {"person": "Historical actor", "action": "edit", "from": "2025-02-02", "to": "2025-02-02", "page_size": 1}
    first = await client.get("/api/v1/audit", params=filters, headers=auth)
    assert first.status_code == 200
    assert first.json()["total"] == 2 and first.json()["items"][0]["summary"] == "Boundary 2"
    assert first.json()["items"][0]["id"] == str(inserted.inserted_ids[2])
    assert "Historical actor" in first.json()["persons"] and "edit" in first.json()["actions"]
    assert "secret-hash" not in first.text and "secret-token" not in first.text and "passwordHash" not in first.text
    second = await client.get("/api/v1/audit", params={**filters, "page": 2}, headers=auth)
    assert second.status_code == 200 and second.json()["items"][0]["summary"] == "Boundary 1"
    empty = await client.get("/api/v1/audit", params={**filters, "page": 3}, headers=auth)
    assert empty.status_code == 200 and empty.json()["items"] == [] and empty.json()["persons"] == first.json()["persons"]
    service = AuditService(AuditRepository(db)); identity = await actor(db, application, auth)
    for bounds, count in [(AuditFilters(person="Historical actor"), 4),
                          (AuditFilters(person="Historical actor", from_date=date(2025, 2, 2)), 3),
                          (AuditFilters(person="Historical actor", to_date=date(2025, 2, 2)), 3)]:
        result = await service.list(identity, bounds)
        assert result.total == count
    for params in [{"person": ".*"}, {"action": '{"$ne":null}'}, {"person": "<script>"}, {"action": "nonexistent"}]:
        result = await client.get("/api/v1/audit", params=params, headers=auth)
        assert result.status_code == 200 and result.json()["total"] == 0
    for page, size in [(0, 10), (1, 0), (1, 101)]:
        with pytest.raises(ValueError, match="Invalid pagination"):
            await service.list(identity, AuditFilters(), page, size)
    with pytest.raises(HTTPException) as error:
        await service.list(identity, AuditFilters(from_date=date(2025, 2, 3), to_date=date(2025, 2, 2)))
    assert error.value.status_code == 422


@pytest.mark.parametrize("suffix", ["", "/csv"])
@pytest.mark.parametrize("params", [{"from": "invalid"}, {"to": "2025-02-30"}, {"person": "x" * 201},
    {"action": "x" * 201}, {"from": "2025-03-03", "to": "2025-03-02"}])
async def test_invalid_filter_inputs_are_422(client, db, suffix, params):
    """Reject malformed dates, oversize filters and reversed intervals in both formats."""
    response = await client.get("/api/v1/audit" + suffix, params=params, headers=await login(client, db))
    assert response.status_code == 422 and "detail" in response.json()


@pytest.mark.parametrize("params", [{"page": 0}, {"page": "no"}, {"page_size": 0}, {"page_size": 101}])
async def test_invalid_api_paging(client, db, params):
    """Validate numeric paging before executing bounded history queries."""
    response = await client.get("/api/v1/audit", params=params, headers=await login(client, db))
    assert response.status_code == 422


@pytest.mark.parametrize("suffix", ["", "/csv"])
async def test_no_invalid_expired_revoked_inactive_and_forced_sessions(client, db, suffix):
    """Fail closed on invalid sessions and forced-change restrictions."""
    url = "/api/v1/audit" + suffix
    for auth in [{}, {"Authorization": "Bearer invalid"}]:
        response = await client.get(url, headers=auth)
        assert response.status_code == 401 and "detail" in response.json()
    forced = await login(client, db, forced=True)
    response = await client.get(url, headers=forced)
    assert response.status_code == 403 and "Change your initial password" in response.json()["detail"]
    auth = await login(client, db)
    user = await db.users.find_one({"email": "admin@portfolio.local"})
    await db.sessions.update_many({"userId": user["_id"]}, {"$set": {"expiresAt": datetime.now(timezone.utc) - timedelta(seconds=1)}})
    assert (await client.get(url, headers=auth)).status_code == 401
    auth = await login(client, db)
    await db.sessions.update_many({"userId": user["_id"]}, {"$set": {"revoked": True}})
    assert (await client.get(url, headers=auth)).status_code == 401
    auth = await login(client, db)
    await db.users.update_one({"_id": user["_id"]}, {"$set": {"status": "Inactive"}})
    assert (await client.get(url, headers=auth)).status_code == 401


@pytest.mark.parametrize("local", ["executive", "leader", "engineer", "readonly", "auditor"])
async def test_roles_cannot_gain_sensitive_access_by_configured_permissions(client, db, application, local):
    """Allow Auditor read-only history but never export or user/role administration."""
    auth = await login(client, db, local)
    identity = await actor(db, application, auth)
    await db.roles.update_one({"_id": identity["role"]["_id"]}, {"$set": {"permissions": ["view", "export", "administer"]}})
    read = await client.get("/api/v1/audit", headers=auth)
    assert read.status_code == (200 if local == "auditor" else 403)
    for path in ["/api/v1/audit/csv", "/api/v1/admin/users", "/api/v1/admin/roles"]:
        response = await client.get(path, headers=auth)
        assert response.status_code == 403 and "detail" in response.json()
    service = AuditService(AuditRepository(db)); identity = await actor(db, application, auth)
    with pytest.raises(HTTPException) as error:
        await service.export(identity, AuditFilters())
    assert error.value.status_code == 403
    if local != "auditor":
        with pytest.raises(HTTPException):
            await service.list(identity, AuditFilters())
    else:
        assert (await service.list(identity, AuditFilters())).total > 0
        await db.roles.update_one({"_id": identity["role"]["_id"]}, {"$set": {"permissions": ["export", "administer"]}})
        assert (await client.get("/api/v1/audit", headers=auth)).status_code == 403
    assert await db.audit.count_documents({"entityType": "audit", "action": "export"}) == 0


async def test_current_admin_permissions_rechecked_without_new_token(client, db):
    """Require administer for reads and both administer/export for CSV."""
    auth = await login(client, db)
    await db.roles.update_one({"name": "Administrator"}, {"$set": {"permissions": ["export", "view"]}})
    for suffix in ["", "/csv"]:
        assert (await client.get("/api/v1/audit" + suffix, headers=auth)).status_code == 403
    await db.roles.update_one({"name": "Administrator"}, {"$set": {"permissions": ["administer"]}})
    assert (await client.get("/api/v1/audit", headers=auth)).status_code == 200
    assert (await client.get("/api/v1/audit/csv", headers=auth)).status_code == 403


async def test_filtered_csv_all_pages_safe_cells_matches_table_and_self_audits(client, db, application):
    """Match every filtered row, neutralize formulas and requery the persisted export."""
    auth = await login(client, db)
    await db.audit.insert_many([{"time": datetime(2025, 1, 1, tzinfo=timezone.utc), "person": "=Équipe, quoted",
        "action": "+edit", "entityType": "@application", "entityId": None, "summary": f" -row {n:03}"} for n in range(101)])
    filters = {"person": "=Équipe, quoted", "action": "+edit", "from": "2025-01-01", "to": "2025-01-01"}
    collected = []
    for page in [1, 2]:
        response = await client.get("/api/v1/audit", params={**filters, "page": page, "page_size": 100}, headers=auth)
        assert response.status_code == 200
        collected.extend(response.json()["items"])
    response = await client.get("/api/v1/audit/csv", params={**filters, "page": 9, "page_size": 1}, headers=auth)
    assert response.status_code == 200 and response.headers["content-type"] == "text/csv; charset=utf-8"
    assert response.headers["content-disposition"] == 'attachment; filename="audit-log.csv"'
    parsed = list(csv.reader(io.StringIO(response.content.decode("utf-8"))))
    assert parsed == [["time", "person", "action", "entityType", "summary"]] + [
        [r["time"], "'" + r["person"], "'" + r["action"], "'" + r["entityType"], "'" + r["summary"]] for r in collected]
    event = await db.audit.find_one({"entityType": "audit", "action": "export"})
    assert event["summary"] == "Exported 101 matching audit rows." and event["entityId"] is None
    admin_user = await db.users.find_one({"email": "admin@portfolio.local"})
    assert event["person"] == admin_user["name"] and event["personId"] == admin_user["_id"]
    again = await client.get("/api/v1/audit", params={"action": "export"}, headers=await login(client, db))
    assert again.status_code == 200 and any(r["id"] == str(event["_id"]) for r in again.json()["items"])
    service = AuditService(AuditRepository(db))
    assert await service.export(await actor(db, application, auth), AuditFilters(person="missing")) == "time,person,action,entityType,summary\r\n"


async def test_prior_events_retained_after_new_signin_and_deactivation_no_credentials(client, db):
    """Expose earlier report/sign-in history without token, hash or request fields."""
    auth = await login(client, db, "auditor")
    exported = await client.get("/api/v1/reports/applications/csv", headers=auth)
    assert exported.status_code == 200
    failed = await client.post("/api/v1/auth/login", json={"email": "unknown@portfolio.local", "password": "NEVER-EXPOSE-THIS"})
    assert failed.status_code == 401
    await db.users.update_one({"email": "auditor@portfolio.local"}, {"$set": {"status": "Inactive"}})
    admin = await login(client, db)
    result = await client.get("/api/v1/audit", params={"page_size": 100}, headers=admin)
    assert result.status_code == 200
    assert any(r["entityType"] == "report" and r["action"] == "export" for r in result.json()["items"])
    assert "NEVER-EXPOSE-THIS" not in result.text and admin["Authorization"][7:] not in result.text
    assert "$2b$" not in result.text and "passwordHash" not in result.text
    again = await client.get("/api/v1/audit", params={"page_size": 100}, headers=await login(client, db))
    assert {r["id"] for r in result.json()["items"]} <= {r["id"] for r in again.json()["items"]}


async def test_export_write_failure_returns_safe_503_not_csv(client, db):
    """Enforce audit persistence with a real database validator failure."""
    auth = await login(client, db)
    await db.command({"collMod": "audit", "validator": {"entityType": {"$ne": "audit"}}, "validationLevel": "strict"})
    response = await client.get("/api/v1/audit/csv", headers=auth)
    assert response.status_code == 503 and response.json() == {"detail": "The service is unavailable. Please try again."}
    assert "content-disposition" not in response.headers
    assert await db.audit.count_documents({"entityType": "audit"}) == 0
