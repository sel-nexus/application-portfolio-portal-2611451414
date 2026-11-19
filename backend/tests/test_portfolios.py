"""Verify portfolio service branches and HTTP security against isolated real MongoDB."""

from typing import Any
from datetime import datetime, timedelta, timezone
import pytest
from bson import ObjectId
from fastapi import HTTPException
from pymongo.errors import DuplicateKeyError
from app.repositories.audit import AuditRepository
from app.repositories.portfolios import PortfolioRepository
from app.schemas.portfolios import PortfolioPayload
from app.services.portfolios import PortfolioService

PAYLOAD = {"name": "New portfolio", "owner": "Test Owner", "description": "Stored description", "productArea": "Test area", "status": "Archived"}
BASE = "/api/v1/portfolios"


async def headers(client: Any, db: Any, local: str = "admin", forced: bool = False) -> dict[str, str]:
    """Sign in a seeded account, clearing forced change only in this isolated fixture."""
    if local == "admin" and not forced:
        await db.users.update_one({"email": "admin@portfolio.local"}, {"$set": {"mustChangePassword": False}})
    response = await client.post("/api/v1/auth/login", json={"email": f"{local}@portfolio.local", "password": "PortalDemo123!"})
    assert response.status_code == 200
    return {"Authorization": f"Bearer {response.json()['token']}"}


async def identity(db: Any, local: str = "admin") -> dict[str, Any]:
    """Read current role and account for direct service checks with real persistence."""
    user = await db.users.find_one({"email": f"{local}@portfolio.local"})
    user["mustChangePassword"] = False
    return {"user": user, "role": await db.roles.find_one({"_id": user["roleId"]}), "session": {}}


@pytest.fixture
def portfolio_service(db: Any) -> PortfolioService:
    """Use production repositories without replacing MongoDB with mocks."""
    return PortfolioService(PortfolioRepository(db), AuditRepository(db))


async def test_service_lifecycle_requeries_every_field_and_audits(db: Any, portfolio_service: PortfolioService) -> None:
    """Create, update and delete with authoritative re-reads and safe persisted audit rows."""
    actor = await identity(db)
    created = await portfolio_service.create(actor, PortfolioPayload(**PAYLOAD))
    oid = ObjectId(created["id"])
    stored = await db.portfolios.find_one({"_id": oid})
    assert {key: stored[key] for key in PAYLOAD} == PAYLOAD
    assert created["applicationCount"] == created["qualityScore"] == 0
    assert created["applications"] == []
    updated = {**PAYLOAD, "name": "Renamed", "status": "Active", "owner": "Updated", "description": "Updated text", "productArea": "Changed"}
    await portfolio_service.update(actor, str(oid), PortfolioPayload(**updated))
    assert {key: (await db.portfolios.find_one({"_id": oid}))[key] for key in updated} == updated
    assert (await portfolio_service.detail(actor, str(oid)))["name"] == "Renamed"
    await portfolio_service.delete(actor, str(oid))
    assert await db.portfolios.find_one({"_id": oid}) is None
    events = await AuditRepository(db).filtered({"entityId": oid})
    assert [row["action"] for row in events["items"]] == ["delete", "edit", "create"]
    for row in events["items"]:
        assert row["personId"] == str(actor["user"]["_id"])
        assert row["entityType"] == "portfolio" and row["time"] and row["summary"]
        assert "password" not in str(row).lower() and "token" not in str(row).lower()


async def test_api_lifecycle_and_duplicate_create_update(db: Any, client: Any) -> None:
    """Exercise successful HTTP CRUD, duplicate mapping, and refresh-like reads."""
    auth = await headers(client, db)
    response = await client.post(BASE, headers=auth, json=PAYLOAD)
    assert response.status_code == 201
    created = response.json()
    assert {key: created[key] for key in PAYLOAD} == PAYLOAD
    assert created["applications"] == []
    duplicate = await client.post(BASE, headers=auth, json={**PAYLOAD, "name": " new PORTFOLIO "})
    assert duplicate.status_code == 409
    assert duplicate.json() == {"detail": {"name": "A portfolio with this name already exists."}}
    changed = {**PAYLOAD, "name": "Updated portfolio", "owner": "Changed owner"}
    response = await client.put(f"{BASE}/{created['id']}", headers=auth, json=changed)
    assert response.status_code == 200 and response.json()["owner"] == "Changed owner"
    read = await client.get(f"{BASE}/{created['id']}", headers=auth)
    assert read.status_code == 200 and read.json()["name"] == changed["name"]
    duplicate = await client.put(f"{BASE}/{created['id']}", headers=auth, json={**PAYLOAD, "name": "payments"})
    assert duplicate.status_code == 409 and "name" in duplicate.json()["detail"]
    assert (await db.portfolios.find_one({"_id": ObjectId(created["id"])}))["name"] == changed["name"]
    response = await client.delete(f"{BASE}/{created['id']}", headers=auth)
    assert response.status_code == 204 and response.content == b""
    assert (await client.get(f"{BASE}/{created['id']}", headers=auth)).status_code == 404


async def test_seed_counts_quality_full_detail_and_rounding(db: Any, client: Any, portfolio_service: PortfolioService) -> None:
    """Independently compute seed summaries and verify half-integer rounds upward."""
    auth = await headers(client, db, "executive")
    response = await client.get(BASE, headers=auth)
    assert response.status_code == 200 and response.json()["total"] == 3
    for row in response.json()["items"]:
        apps = await db.applications.find({"portfolioId": ObjectId(row["id"])}).to_list(None)
        assert row["applicationCount"] == len(apps)
        assert row["qualityScore"] == int(sum(app["qualityScore"] for app in apps) / len(apps) + .5)
        detail = await client.get(f"{BASE}/{row['id']}", headers=auth)
        assert detail.status_code == 200
        assert {app["name"] for app in detail.json()["applications"]} == {app["name"] for app in apps}
        assert detail.json()["description"] and detail.json()["owner"]
    oid = (await db.portfolios.insert_one(dict(PAYLOAD))).inserted_id
    await db.applications.insert_many([{"name": "Round A", "portfolioId": oid, "qualityScore": 80}, {"name": "Round B", "portfolioId": oid, "qualityScore": 81}])
    assert (await portfolio_service.detail(await identity(db), str(oid)))["qualityScore"] == 81


async def test_filters_paging_literal_search_and_scope_options(db: Any, client: Any) -> None:
    """Filter by all optional parameters, keep pages stable and prevent option leakage."""
    auth = await headers(client, db, "leader")
    response = await client.get(BASE, headers=auth, params={"page_size": 1, "page": 2})
    assert response.status_code == 200
    assert response.json()["total"] == 2 and response.json()["items"][0]["name"] == "Payments"
    assert response.json()["productAreas"] == ["Commerce", "Customer"]
    assert response.json()["statuses"] == ["Active"]
    response = await client.get(BASE, headers=auth, params={"search": "PAY", "status": "Active", "productArea": "Commerce"})
    assert response.status_code == 200 and response.json()["total"] == 1
    for params in [{"search": ".*"}, {"productArea": "Data"}, {"status": "Archived"}, {"page": 99}]:
        response = await client.get(BASE, headers=auth, params=params)
        assert response.status_code == 200 and response.json()["items"] == []
    await db.users.update_one({"email": "leader@portfolio.local"}, {"$set": {"portfolioAccess": []}})
    response = await client.get(BASE, headers=auth)
    assert response.status_code == 200
    assert response.json()["total"] == 0 and response.json()["productAreas"] == response.json()["statuses"] == []
    engineer = await headers(client, db, "engineer")
    assert (await client.get(BASE, headers=engineer)).json()["total"] == 1
    await db.users.update_one({"email": "engineer@portfolio.local"}, {"$set": {"portfolioAccess": []}})
    assert (await client.get(BASE, headers=engineer)).json()["total"] == 3


@pytest.mark.parametrize("local", ["executive", "leader", "engineer", "auditor", "readonly"])
async def test_role_matrix_for_mutations(db: Any, client: Any, local: str) -> None:
    """Reject nonadministrator create/delete and engineer edits despite edit permission."""
    auth = await headers(client, db, local)
    oid = str((await db.portfolios.find_one({"name": "Payments"}))["_id"])
    assert (await client.post(BASE, headers=auth, json=PAYLOAD)).status_code == 403
    assert (await client.delete(f"{BASE}/{oid}", headers=auth)).status_code == 403
    response = await client.put(f"{BASE}/{oid}", headers=auth, json={**PAYLOAD, "name": "Payments"})
    assert response.status_code == (200 if local == "leader" else 403)
    if local == "leader":
        assert (await db.portfolios.find_one({"_id": ObjectId(oid)}))["owner"] == PAYLOAD["owner"]
    assert await db.audit.count_documents({"action": "delete", "entityType": "portfolio"}) == 0


@pytest.mark.parametrize("method,path", [("GET", ""), ("GET", "/hidden"), ("POST", ""), ("PUT", "/hidden"), ("DELETE", "/hidden")])
async def test_no_token_and_forced_password_all_endpoints(db: Any, client: Any, method: str, path: str) -> None:
    """Refuse every protected operation without bearer or before forced password change."""
    kwargs = {"json": PAYLOAD} if method in ("POST", "PUT") else {}
    response = await client.request(method, BASE + path, **kwargs)
    assert response.status_code == 401
    auth = await headers(client, db, forced=True)
    response = await client.request(method, BASE + path, headers=auth, **kwargs)
    assert response.status_code == 403
    assert response.json()["detail"] == "Change your initial password before continuing."


@pytest.mark.parametrize("method", ["GET", "PUT", "DELETE"])
@pytest.mark.parametrize("target", ["hidden", "missing", "invalid"])
async def test_direct_hidden_missing_invalid_have_exact_404(db: Any, client: Any, method: str, target: str) -> None:
    """Avoid leaking hidden fields through direct reads or attempted mutations."""
    auth = await headers(client, db, "leader")
    hidden = await db.portfolios.find_one({"name": "Data & Analytics"})
    oid = str(hidden["_id"]) if target == "hidden" else str(ObjectId()) if target == "missing" else "$where"
    response = await client.request(method, f"{BASE}/{oid}", headers=auth, **({"json": PAYLOAD} if method == "PUT" else {}))
    assert response.status_code == 404
    assert response.json() == {"detail": "This record is not available."}
    assert hidden["name"] not in response.text


async def test_occupied_delete_and_database_unique_index(db: Any, client: Any) -> None:
    """Enforce occupied deletion without audit and index-level case-insensitive uniqueness."""
    auth = await headers(client, db)
    oid = (await db.portfolios.find_one({"name": "Payments"}))["_id"]
    response = await client.delete(f"{BASE}/{oid}", headers=auth)
    assert response.status_code == 409
    assert response.json()["detail"] == "This portfolio contains applications. Move or delete them before deleting the portfolio."
    assert await db.portfolios.find_one({"_id": oid}) is not None
    assert await db.audit.count_documents({"action": "delete", "entityId": oid}) == 0
    with pytest.raises(DuplicateKeyError):
        await db.portfolios.insert_one({**PAYLOAD, "name": "PAYMENTS"})
    await PortfolioRepository(db).ensure_indexes()


@pytest.mark.parametrize("payload", [{}, {**PAYLOAD, "name": " "}, {**PAYLOAD, "name": 5}, {**PAYLOAD, "name": {"$ne": ""}}, {**PAYLOAD, "name": "a" * 201}, {**PAYLOAD, "name": "bad\nname"}, {**PAYLOAD, "status": "Unknown"}, {**PAYLOAD, "owner": {"$gt": ""}}, {**PAYLOAD, "description": "a" * 5001}, {**PAYLOAD, "qualityScore": 100}])
async def test_invalid_writes_do_not_persist(db: Any, client: Any, payload: dict[str, Any]) -> None:
    """Reject missing, malformed, oversized, enum, operator and unknown-field input."""
    auth = await headers(client, db)
    before = await db.portfolios.count_documents({})
    oid = (await db.portfolios.find_one({"name": "Payments"}))["_id"]
    for method, path in [("POST", BASE), ("PUT", f"{BASE}/{oid}")]:
        response = await client.request(method, path, headers=auth, json=payload)
        assert response.status_code == 422 and isinstance(response.json()["detail"], list)
    assert await db.portfolios.count_documents({}) == before
    assert (await db.portfolios.find_one({"_id": oid}))["name"] == "Payments"


@pytest.mark.parametrize("params", [{"page": 0}, {"page": "oops"}, {"page_size": 0}, {"page_size": 101}, {"status": "$ne"}, {"search": "a" * 201}, {"productArea": "a" * 201}])
async def test_invalid_queries(db: Any, client: Any, params: dict[str, Any]) -> None:
    """Bound query inputs rather than interpolating arbitrary operators."""
    response = await client.get(BASE, headers=await headers(client, db), params=params)
    assert response.status_code == 422


@pytest.mark.parametrize("text", ["<script>alert(1)</script>", "<IMG src=x onerror=alert(1)>", "../../secret", r"..\..\secret"])
async def test_dangerous_text_refused_without_mutation(db: Any, client: Any, text: str) -> None:
    """Reject markup and traversal on every writable text field before persistence."""
    auth = await headers(client, db)
    before = await db.portfolios.find({}).sort("_id", 1).to_list(None)
    audit = await db.audit.find({}).sort("_id", 1).to_list(None)
    for field in ("name", "owner", "description", "productArea"):
        for method, path in [("POST", BASE), ("PUT", f"{BASE}/{before[0]['_id']}")]:
            response = await client.request(method, path, headers=auth, json={**PAYLOAD, field: text})
            assert response.status_code == 422
            assert any(error["loc"] == ["body", field] for error in response.json()["detail"])
            assert await db.portfolios.find({}).sort("_id", 1).to_list(None) == before
            assert await db.audit.find({}).sort("_id", 1).to_list(None) == audit


async def test_safe_security_metacharacters_are_literal_data(db: Any, client: Any) -> None:
    """Preserve safe punctuation and literal SQL, regex and Mongo-looking searches."""
    auth = await headers(client, db)
    for text in ["' OR 1=1 --", '{"$ne":null}', ".*", "O'Brien & Sons (C++)"]:
        response = await client.post(BASE, headers=auth, json={**PAYLOAD, "name": text})
        assert response.status_code == 201
        response = await client.get(BASE, headers=auth, params={"search": text})
        assert response.status_code == 200 and response.json()["total"] == 1
        assert response.json()["items"][0]["name"] == text
    for text in ["<script>alert(1)</script>", "../../secret"]:
        response = await client.get(BASE, headers=auth, params={"search": text})
        assert response.status_code == 200 and response.json()["total"] == 0


async def test_valid_plain_portfolio_text_remains_unchanged(db: Any, client: Any) -> None:
    """Preserve valid names, apostrophes, punctuation and multiline descriptions."""
    auth = await headers(client, db)
    valid = {**PAYLOAD, "name": "O'Brien & Sons (C++)", "owner": "Anne-Marie D'Arcy",
             "productArea": "R&D / Analytics", "description": "2 < 3; 5 > 4.\nRevenue & analytics..."}
    created = await client.post(BASE, headers=auth, json=valid)
    assert created.status_code == 201
    edited = await client.put(f"{BASE}/{created.json()['id']}", headers=auth, json=valid)
    assert edited.status_code == 200
    stored = await db.portfolios.find_one({"_id": ObjectId(created.json()["id"])})
    assert {key: stored[key] for key in valid} == valid


async def test_current_permissions_and_expired_session(db: Any, client: Any) -> None:
    """Recheck changed role permissions and persisted session expiration on each request."""
    auth = await headers(client, db, "executive")
    role = await db.roles.find_one({"name": "Executive"})
    await db.roles.update_one({"_id": role["_id"]}, {"$set": {"permissions": []}})
    assert (await client.get(BASE, headers=auth)).status_code == 403
    await db.roles.update_one({"_id": role["_id"]}, {"$set": {"permissions": ["view", "create", "edit", "delete"]}})
    assert (await client.post(BASE, headers=auth, json=PAYLOAD)).status_code == 403
    oid = (await db.portfolios.find_one({"name": "Payments"}))["_id"]
    assert (await client.put(f"{BASE}/{oid}", headers=auth, json=PAYLOAD)).status_code == 403
    assert (await client.delete(f"{BASE}/{oid}", headers=auth)).status_code == 403
    user = await db.users.find_one({"email": "executive@portfolio.local"})
    await db.sessions.update_many({"userId": user["_id"]}, {"$set": {"expiresAt": datetime.now(timezone.utc) - timedelta(seconds=1)}})
    assert (await client.get(BASE, headers=auth)).status_code == 401


async def test_service_failure_branches_real_repositories(db: Any, portfolio_service: PortfolioService) -> None:
    """Cover direct service denial, duplicates, empty scope and missing persistence results."""
    admin = await identity(db)
    leader = await identity(db, "leader")
    engineer = await identity(db, "engineer")
    oid = str((await db.portfolios.find_one({"name": "Payments"}))["_id"])
    with pytest.raises(HTTPException) as denied:
        await portfolio_service.create(leader, PortfolioPayload(**PAYLOAD))
    assert denied.value.status_code == 403
    with pytest.raises(HTTPException) as denied:
        await portfolio_service.update(engineer, oid, PortfolioPayload(**PAYLOAD))
    assert denied.value.status_code == 403
    with pytest.raises(HTTPException) as conflict:
        await portfolio_service.create(admin, PortfolioPayload(name="payments"))
    assert conflict.value.status_code == 409
    other = await portfolio_service.create(admin, PortfolioPayload(**PAYLOAD))
    with pytest.raises(HTTPException) as conflict:
        await portfolio_service.update(admin, other["id"], PortfolioPayload(name="payments"))
    assert conflict.value.status_code == 409
    with pytest.raises(HTTPException) as conflict:
        await portfolio_service.delete(admin, oid)
    assert conflict.value.status_code == 409
    with pytest.raises(HTTPException) as denied:
        await portfolio_service.delete(leader, oid)
    assert denied.value.status_code == 403
    with pytest.raises(HTTPException) as missing:
        await portfolio_service.detail(admin, str(ObjectId()))
    assert missing.value.status_code == 404
    leader["user"]["portfolioAccess"] = []
    assert (await portfolio_service.list(leader))["total"] == 0
    with pytest.raises(ValueError):
        await portfolio_service.list(admin, page_size=101)
    # Exercise real concurrent-removal return paths without mocking MongoDB.
    class RemovedAfterRead(PortfolioService):
        """Remove a test row after authorization to simulate concurrent deletion."""
        async def detail(self, actor: dict[str, Any], target: str) -> dict[str, Any]:
            """Authorize normally, then remove the row before the next persistence step."""
            result = await super().detail(actor, target)
            await self.repository.delete(ObjectId(target))
            return result
    racing = RemovedAfterRead(PortfolioRepository(db), AuditRepository(db))
    for operation in ("update", "delete"):
        created = await portfolio_service.create(admin, PortfolioPayload(name=f"Race {operation}"))
        with pytest.raises(HTTPException) as missing:
            if operation == "update":
                await racing.update(admin, created["id"], PortfolioPayload(name="Race changed"))
            else:
                await racing.delete(admin, created["id"])
        assert missing.value.status_code == 404
