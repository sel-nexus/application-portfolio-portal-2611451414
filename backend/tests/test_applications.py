"""Exercise application services and HTTP security against isolated real MongoDB."""

import csv
import io
from typing import Any
import pytest
from bson import ObjectId
from fastapi import HTTPException
from app.repositories.applications import ApplicationRepository
from app.repositories.audit import AuditRepository
from app.schemas.applications import ApplicationPayload
from app.services.applications import ApplicationService, CSV_COLUMNS, safe_cell
from tests.test_portfolios import headers, identity

BASE = "/api/v1/applications"
FIELDS = {"name": "Lifecycle app", "description": "Persisted description", "productArea": "Commerce",
          "businessOwner": "Business", "technologyOwner": "Technology", "qualityOwner": "Quality",
          "criticality": "Critical", "tier": 4, "lifecycle": "Deprecated", "technologyStack": "Python React",
          "repositoryLink": "https://example.com/repo", "pipelineLink": "https://example.com/build",
          "healthScore": 0, "qualityScore": 100, "automationCoverage": 45, "unitTestCoverage": 80,
          "openDefects": 3, "openCriticalDefects": 2, "risk": "High"}


@pytest.fixture
async def payload(db: Any) -> dict[str, Any]:
    """Reference the seeded visible portfolio with all maintained fields."""
    return {**FIELDS, "portfolioId": str((await db.portfolios.find_one({"name": "Payments"}))["_id"])}


@pytest.fixture
def applications(db: Any) -> ApplicationService:
    """Use only the production real pooled Mongo repositories."""
    return ApplicationService(ApplicationRepository(db), AuditRepository(db))


async def test_service_lifecycle_and_export_requery_all_writes(db: Any, payload: dict, applications: ApplicationService) -> None:
    """Requery complete create/update/delete state and persisted audit events."""
    actor = await identity(db)
    created = await applications.create(actor, ApplicationPayload(**payload))
    oid = ObjectId(created["id"])
    stored = await db.applications.find_one({"_id": oid})
    assert isinstance(stored["portfolioId"], ObjectId)
    assert {key: created[key] for key in payload} == payload
    target = await db.portfolios.find_one({"name": "Customer Platform"})
    changed = {**payload, "portfolioId": str(target["_id"]), "name": "Changed app", "description": "Changed",
               "healthScore": 100, "qualityScore": 0, "repositoryLink": "", "pipelineLink": ""}
    await applications.update(actor, str(oid), ApplicationPayload(**changed))
    stored = await db.applications.find_one({"_id": oid})
    assert {key: str(stored[key]) if isinstance(stored[key], ObjectId) else stored[key] for key in changed} == changed
    assert (await applications.detail(actor, str(oid)))["portfolio"] == "Customer Platform"
    page = await applications.list(actor, {"search": "Changed"})
    assert page["total"] == 1 and page["items"][0]["id"] == str(oid)
    rows = list(csv.reader(io.StringIO(await applications.export(actor, {"search": "Changed"}))))
    assert rows[0] == [label for label, _ in CSV_COLUMNS] and rows[1][0] == "Changed app"
    await applications.delete(actor, str(oid))
    assert await db.applications.find_one({"_id": oid}) is None
    events = await db.audit.find({"entityType": "application", "personId": actor["user"]["_id"]}).to_list(None)
    assert {event["action"] for event in events} == {"create", "edit", "delete", "export"}
    assert all(event["time"] and event["summary"] and "password" not in str(event).lower() for event in events)


async def test_http_lifecycle_duplicates_and_csv(db: Any, client: Any, payload: dict) -> None:
    """Assert statuses, public body fields, filtered CSV bytes, and subsequent re-reads."""
    auth = await headers(client, db)
    created = await client.post(BASE, headers=auth, json=payload)
    assert created.status_code == 201
    row = created.json()
    assert {key: row[key] for key in payload} == payload
    for method, path in [("POST", BASE), ("PUT", BASE + "/" + row["id"])]:
        duplicate_payload = {**payload, "name": "payment gateway"}
        response = await client.request(method, path, headers=auth, json=duplicate_payload)
        assert response.status_code == 409 and response.json() == {"detail": {"name": "An application with this name already exists."}}
    changed = {**payload, "name": "Renamed app", "healthScore": 100}
    response = await client.put(BASE + "/" + row["id"], headers=auth, json=changed)
    assert response.status_code == 200 and response.json()["healthScore"] == 100
    response = await client.get(BASE + "/" + row["id"], headers=auth)
    assert response.status_code == 200 and response.json()["name"] == "Renamed app"
    query = {"search": "Renamed", "portfolioId": payload["portfolioId"], "criticality": "Critical", "risk": "High", "lifecycle": "Deprecated"}
    listing = await client.get(BASE, headers=auth, params={**query, "page_size": 1})
    assert listing.status_code == 200 and listing.json()["total"] == 1
    exported = await client.get(BASE + "/csv", headers=auth, params={**query, "page": 99})
    assert exported.status_code == 200 and "charset=utf-8" in exported.headers["content-type"]
    assert 'filename="applications.csv"' in exported.headers["content-disposition"]
    rows = list(csv.reader(io.StringIO(exported.text)))
    assert rows == [[label for label, _ in CSV_COLUMNS], [str(listing.json()["items"][0][key]) for _, key in CSV_COLUMNS]]
    response = await client.delete(BASE + "/" + row["id"], headers=auth)
    assert response.status_code == 204 and response.content == b""
    assert await db.applications.find_one({"_id": ObjectId(row["id"])}) is None


@pytest.mark.parametrize("role", ["admin", "leader", "engineer", "executive", "auditor", "readonly"])
async def test_role_matrix(db: Any, client: Any, payload: dict, role: str) -> None:
    """Enforce baseline create/edit/delete/export independently of hidden controls."""
    auth = await headers(client, db, role)
    app = await db.applications.find_one({"portfolioId": ObjectId(payload["portfolioId"])})
    path = f"{BASE}/{app['_id']}"
    response = await client.post(BASE, headers=auth, json=payload)
    assert response.status_code == (201 if role in ("admin", "leader", "engineer") else 403)
    response = await client.put(path, headers=auth, json={**payload, "name": "Role edit"})
    assert response.status_code == (200 if role in ("admin", "leader", "engineer") else 403)
    response = await client.get(BASE + "/csv", headers=auth)
    assert response.status_code == (403 if role == "readonly" else 200)
    response = await client.delete(path, headers=auth)
    assert response.status_code == (204 if role == "admin" else 403)
    if role != "admin":
        assert await db.applications.find_one({"_id": app["_id"]}) is not None


@pytest.mark.parametrize("method,path", [("GET", ""), ("GET", "/csv"), ("GET", "/missing"), ("POST", ""), ("PUT", "/missing"), ("DELETE", "/missing")])
async def test_no_bearer_and_forced_password(db: Any, client: Any, payload: dict, method: str, path: str) -> None:
    """Refuse every application endpoint without bearer and during forced change."""
    kwargs = {"json": payload} if method in ("POST", "PUT") else {}
    response = await client.request(method, BASE + path, **kwargs)
    assert response.status_code == 401 and response.json()["detail"] == "Please sign in."
    response = await client.request(method, BASE + path, headers=await headers(client, db, forced=True), **kwargs)
    assert response.status_code == 403 and response.json()["detail"] == "Change your initial password before continuing."


@pytest.mark.parametrize("method", ["GET", "PUT", "DELETE"])
async def test_hidden_missing_and_invalid_records(db: Any, client: Any, payload: dict, method: str) -> None:
    """Return identical exact unavailable messages without hidden record fields."""
    auth = await headers(client, db, "engineer")
    hidden = await db.applications.find_one({"portfolioId": {"$ne": ObjectId(payload["portfolioId"])}})
    for oid in (str(hidden["_id"]), str(ObjectId()), "$where"):
        response = await client.request(method, BASE + "/" + oid, headers=auth,
                                        **({"json": payload} if method == "PUT" else {}))
        assert response.status_code == 404 and response.json() == {"detail": "This record is not available."}
        assert hidden["name"] not in response.text


async def test_moves_missing_targets_scopes_options_and_literal_queries(db: Any, client: Any, payload: dict) -> None:
    """Block inaccessible targets and prove filters and exports do not disclose hidden rows."""
    auth = await headers(client, db, "engineer")
    created = (await client.post(BASE, headers=auth, json=payload)).json()
    hidden = await db.portfolios.find_one({"name": "Data & Analytics"})
    for target in (str(hidden["_id"]), str(ObjectId())):
        for method, path in [("POST", BASE), ("PUT", BASE + "/" + created["id"])]:
            response = await client.request(method, path, headers=auth, json={**payload, "portfolioId": target})
            assert response.status_code == 404 and response.json() == {"detail": "This record is not available."}
    assert (await db.applications.find_one({"_id": ObjectId(created["id"])}))["portfolioId"] == ObjectId(payload["portfolioId"])
    result = await client.get(BASE, headers=auth, params={"page_size": 1, "page": 2})
    assert result.status_code == 200 and len(result.json()["items"]) == 1
    assert [row["id"] for row in result.json()["portfolios"]] == [payload["portfolioId"]]
    for query in ({"search": ".*"}, {"search": '{"$ne":null}'}, {"portfolioId": str(hidden["_id"])}):
        for suffix in ("", "/csv"):
            response = await client.get(BASE + suffix, headers=auth, params=query)
            assert response.status_code == 200
            assert response.json()["total"] == 0 if not suffix else len(list(csv.reader(io.StringIO(response.text)))) == 1
    await db.users.update_one({"email": "engineer@portfolio.local"}, {"$set": {"portfolioAccess": []}})
    assert (await client.get(BASE, headers=auth)).json()["total"] == 11
    leader = await headers(client, db, "leader")
    await db.users.update_one({"email": "leader@portfolio.local"}, {"$set": {"portfolioAccess": []}})
    empty = (await client.get(BASE, headers=leader)).json()
    assert empty["items"] == empty["portfolios"] == empty["criticalities"] == empty["risks"] == empty["lifecycles"] == []


INVALID = [("name", ""), ("name", "x" * 201), ("name", {"$ne": ""}), ("description", "x" * 5001),
           ("portfolioId", ""), ("portfolioId", {"$ne": None}), ("tier", True), ("tier", "1"), ("tier", 1.2), ("tier", 0), ("tier", 5),
           ("criticality", "unknown"), ("risk", "Critical"), ("lifecycle", "Archived"),
           ("repositoryLink", "not-url"), ("pipelineLink", "javascript:alert(1)"), ("unexpected", 1)]
INVALID += [(key, value) for key in ("healthScore", "qualityScore", "automationCoverage", "unitTestCoverage")
            for value in (-1, 101, "50", True, 2.5)]
INVALID += [(key, value) for key in ("openDefects", "openCriticalDefects") for value in (-1, True, "1", 1.5)]
INVALID += [("openCriticalDefects", 4)]


@pytest.mark.parametrize("key,value", INVALID)
async def test_validation_refuses_create_and_edit_without_writes(db: Any, client: Any, payload: dict, key: str, value: Any) -> None:
    """Reject all PRD type, range, enum, URL and unknown-field failures inline."""
    auth = await headers(client, db)
    app = await db.applications.find_one({})
    for method, path in [("POST", BASE), ("PUT", f"{BASE}/{app['_id']}")]:
        response = await client.request(method, path, headers=auth, json={**payload, key: value})
        assert response.status_code == 422
        assert any(error["loc"][-1] == key for error in response.json()["detail"])
    assert await db.applications.count_documents({}) == 10
    assert (await db.applications.find_one({"_id": app["_id"]}))["name"] == app["name"]


@pytest.mark.parametrize("key", ["name", "portfolioId"])
@pytest.mark.parametrize("method", ["POST", "PUT"])
async def test_missing_required_fields(db: Any, client: Any, payload: dict, key: str, method: str) -> None:
    """Reject each omitted identity on create/edit without application or audit writes."""
    auth = await headers(client, db)
    before = await db.applications.find({}).sort("_id", 1).to_list(None)
    audit = await db.audit.find({}).sort("_id", 1).to_list(None)
    assert before
    path = BASE if method == "POST" else f"{BASE}/{before[0]['_id']}"
    del payload[key]
    response = await client.request(method, path, headers=auth, json=payload)
    assert response.status_code == 422 and response.json()["detail"][0]["loc"][-1] == key
    assert response.json()["detail"][0]["loc"] == ["body", key]
    assert await db.applications.count_documents({}) == len(before)
    assert await db.applications.find({}).sort("_id", 1).to_list(None) == before
    assert await db.audit.count_documents({}) == len(audit)
    assert await db.audit.find({}).sort("_id", 1).to_list(None) == audit


@pytest.mark.parametrize("query", [{"page": 0}, {"page_size": 101}, {"page": "oops"}, {"risk": "$ne"},
                                  {"criticality": "unknown"}, {"lifecycle": "unknown"}, {"search": "x" * 201}])
async def test_invalid_list_and_csv_queries(db: Any, client: Any, query: dict) -> None:
    """Refuse invalid typed and oversized query parameters on applicable endpoints."""
    auth = await headers(client, db)
    response = await client.get(BASE, headers=auth, params=query)
    assert response.status_code == 422 and isinstance(response.json()["detail"], list)
    if not any(key in query for key in ("page", "page_size")):
        response = await client.get(BASE + "/csv", headers=auth, params=query)
        assert response.status_code == 422


async def test_service_negative_branches(db: Any, payload: dict, applications: ApplicationService) -> None:
    """Cover every service denial, duplicate, missing-result and concurrent-removal branch."""
    admin = await identity(db)
    engineer = await identity(db, "engineer")
    executive = await identity(db, "executive")
    executive["role"]["permissions"] = ["view", "create", "edit", "delete", "export"]
    created = await applications.create(admin, ApplicationPayload(**payload))
    for operation in ("create", "update", "delete"):
        with pytest.raises(HTTPException) as denied:
            if operation == "create":
                await applications.create(executive, ApplicationPayload(**payload))
            elif operation == "update":
                await applications.update(executive, created["id"], ApplicationPayload(**payload))
            else:
                await applications.delete(executive, created["id"])
        assert denied.value.status_code == 403
    for operation in ("create", "update"):
        with pytest.raises(HTTPException) as conflict:
            duplicate = ApplicationPayload(**{**payload, "name": "PAYMENT GATEWAY"})
            if operation == "create": await applications.create(admin, duplicate)
            else: await applications.update(admin, created["id"], duplicate)
        assert conflict.value.status_code == 409
    with pytest.raises(HTTPException) as missing:
        await applications.target(admin, "edit", str(ObjectId()))
    assert missing.value.status_code == 404
    with pytest.raises(HTTPException) as missing:
        await applications.detail(admin, str(ObjectId()))
    assert missing.value.status_code == 404
    with pytest.raises(ValueError): await applications.list(admin, {}, page_size=101)
    engineer["role"]["permissions"] = []
    for call in (applications.list(engineer, {}), applications.export(engineer, {})):
        with pytest.raises(HTTPException) as denied: await call
        assert denied.value.status_code == 403
    readonly = await identity(db, "readonly")
    readonly["role"]["permissions"] = ["view", "export"]
    with pytest.raises(HTTPException) as denied: await applications.export(readonly, {})
    assert denied.value.status_code == 403
    class RemovedAfterRead(ApplicationService):
        """Simulate real concurrent removal without replacing database operations."""
        async def detail(self, actor: dict, target: str) -> dict:
            """Authorize and read normally before deleting the actual test row."""
            result = await super().detail(actor, target)
            await self.repository.delete(ObjectId(target))
            return result
    racing = RemovedAfterRead(ApplicationRepository(db), AuditRepository(db))
    for operation in ("update", "delete"):
        row = await applications.create(admin, ApplicationPayload(**{**payload, "name": operation}))
        with pytest.raises(HTTPException) as missing:
            if operation == "update": await racing.update(admin, row["id"], ApplicationPayload(**payload))
            else: await racing.delete(admin, row["id"])
        assert missing.value.status_code == 404


async def test_csv_all_matching_utf8_safe_cells_and_audit(db: Any, client: Any, payload: dict) -> None:
    """Export more than one page, neutralize formulas and persist a matching count event."""
    auth = await headers(client, db)
    for name in ("=SUM(1)", "+formula", "-formula", "@formula", "Résumé app"):
        response = await client.post(BASE, headers=auth, json={**payload, "name": name})
        assert response.status_code == 201
    response = await client.get(BASE + "/csv", headers=auth, params={"portfolioId": payload["portfolioId"], "page_size": 1})
    assert response.status_code == 200 and "Résumé" in response.content.decode("utf-8")
    rows = list(csv.reader(io.StringIO(response.text)))
    expected = await db.applications.count_documents({"portfolioId": ObjectId(payload["portfolioId"])})
    assert len(rows) == expected + 1
    assert all("'" + formula in [row[0] for row in rows] for formula in ("=SUM(1)", "+formula", "-formula", "@formula"))
    assert await db.audit.find_one({"action": "export", "summary": f"Exported {expected} matching applications."})
    for value in (" =formula", "\ttext", "\rtext", "\ntext"):
        assert safe_cell(value) == "'" + value
    assert safe_cell(100) == "100"


@pytest.mark.parametrize("text", ["<script>alert(1)</script>", "<svg onload=alert(1)>", "../../secret", r"..\..\secret"])
async def test_dangerous_text_refused_without_mutation(db: Any, client: Any, payload: dict, text: str) -> None:
    """Reject markup and traversal on text and links without creating or editing rows."""
    auth = await headers(client, db)
    before = await db.applications.find({}).sort("_id", 1).to_list(None)
    audit = await db.audit.find({}).sort("_id", 1).to_list(None)
    fields = ("name", "description", "productArea", "businessOwner", "technologyOwner", "qualityOwner",
              "technologyStack", "repositoryLink", "pipelineLink")
    for field in fields:
        # Links also reject dangerous text embedded inside otherwise valid HTTP URLs.
        value = "https://example.com/" + text if field.endswith("Link") else text
        for method, path in [("POST", BASE), ("PUT", f"{BASE}/{before[0]['_id']}")]:
            response = await client.request(method, path, headers=auth, json={**payload, field: value})
            assert response.status_code == 422
            assert any(error["loc"] == ["body", field] for error in response.json()["detail"])
            assert await db.applications.find({}).sort("_id", 1).to_list(None) == before
            assert await db.audit.find({}).sort("_id", 1).to_list(None) == audit


async def test_valid_plain_text_and_urls_remain_unchanged(db: Any, client: Any, payload: dict) -> None:
    """Preserve names, multiline descriptions, technology punctuation and normal URLs."""
    auth = await headers(client, db)
    valid = {**payload, "name": "O'Brien & Sons (C++)", "businessOwner": "D'Arcy",
             "description": "Revenue & analytics: 2 < 3, 5 > 4.\nSecond line; v1.2...",
             "productArea": "R&D / Commerce", "technologyOwner": "Anne-Marie", "qualityOwner": "Zoë",
             "technologyStack": "C++, C#, .NET 8 / Python; Node.js",
             "repositoryLink": "https://example.com/team/repo?ref=main&lang=C%2B%2B#readme",
             "pipelineLink": "http://build.example.com/job/app/"}
    created = await client.post(BASE, headers=auth, json=valid)
    assert created.status_code == 201
    edited = await client.put(f"{BASE}/{created.json()['id']}", headers=auth, json=valid)
    assert edited.status_code == 200
    stored = await db.applications.find_one({"_id": ObjectId(created.json()["id"])})
    assert {key: str(stored[key]) if isinstance(stored[key], ObjectId) else stored[key] for key in valid} == valid
