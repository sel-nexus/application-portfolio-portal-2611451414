"""Verify identity service branches and HTTP security against isolated real MongoDB."""

from datetime import datetime, timedelta, timezone
from bson import ObjectId
from fastapi import HTTPException
from jose import jwt
from pymongo.errors import DuplicateKeyError
import pytest
from app.core.security import allowed_portfolios, authenticate_token, create_token, hash_password, require_permission, verify_password
from app.core.seed import DEMO_ACCOUNTS, DEMO_PASSWORD, ROLE_PERMISSIONS, seed_database
from app.repositories.identity import IdentityRepository
from app.schemas.auth import LoginRequest, PasswordRequest, ProfileRequest


def bearer(token: str) -> dict[str, str]:
    """Wrap a token in the shared HTTP authorization contract."""
    return {"Authorization": f"Bearer {token}"}


@pytest.mark.parametrize("role,local,name,manager,vendor", DEMO_ACCOUNTS)
async def test_all_seeded_accounts_login_and_expose_no_secrets(client, db, role, local, name, manager, vendor):
    """Check every role's exact initial landing, scope, facts, and stored session."""
    response = await client.post("/api/v1/auth/login", json={"email": f" {local.upper()}@portfolio.local ", "password": DEMO_PASSWORD})
    assert response.status_code == 200
    body = response.json()
    public = body["user"]
    assert public["role"] == role and public["name"] == name
    assert public["permissions"] == ROLE_PERMISSIONS[role]
    assert public["managerName"] == manager and public["vendor"] == vendor
    assert public["defaultLanding"] == ("Dashboard" if role in ("Administrator", "Executive") else "Applications")
    assert public["mustChangePassword"] == (role == "Administrator")
    assert len(public["portfolioAccess"]) == (2 if role == "Portfolio Leader" else 1 if role == "Engineer" else 0)
    assert set(public) == {"id", "name", "email", "role", "permissions", "portfolioAccess", "portfolioNames",
                           "status", "managerName", "vendor", "mustChangePassword", "defaultLanding", "lastSignIn"}
    assert "passwordHash" not in response.text and DEMO_PASSWORD not in response.text
    claims = jwt.get_unverified_claims(body["token"])
    assert claims["sub"] == public["id"] and 28790 <= claims["exp"] - claims["iat"] <= 28800
    persisted = await db.sessions.find_one({"_id": ObjectId(claims["jti"])})
    assert persisted["userId"] == ObjectId(public["id"])
    me = await client.get("/api/v1/auth/me", headers=bearer(body["token"]))
    assert me.status_code == 200 and me.json() == public
    assert me.headers["cache-control"] == "no-store"
    assert await db.audit.count_documents({"action": "sign-in success", "summary": "Signed in successfully."}) == 1


@pytest.mark.parametrize("email,password,status,message", [
    ("missing@portfolio.local", DEMO_PASSWORD, 401, "Email or password is incorrect."),
    ("engineer@portfolio.local", "wrong", 401, "Email or password is incorrect."),
    ("engineer@portfolio.local", DEMO_PASSWORD, 403, "This account is inactive."),
])
async def test_login_failures_are_refused_and_audited(client, db, email, password, status, message):
    """Persist useful failure history without credential leakage or issued sessions."""
    if status == 403:
        await db.users.update_one({"email": email}, {"$set": {"status": "Inactive"}})
    response = await client.post("/api/v1/auth/login", json={"email": email, "password": password})
    assert response.status_code == status and response.json()["detail"] == message
    rows = await db.audit.find({"action": "sign-in failure"}).to_list(None)
    assert len(rows) == 1 and "password" not in rows[0]["summary"]
    assert await db.sessions.count_documents({}) == 0


@pytest.mark.parametrize("payload", [
    {}, {"email": "engineer@portfolio.local"}, {"password": DEMO_PASSWORD},
    {"email": "", "password": DEMO_PASSWORD}, {"email": "invalid", "password": DEMO_PASSWORD},
    {"email": {"$ne": None}, "password": DEMO_PASSWORD}, {"email": "engineer@portfolio.local", "password": ""},
    {"email": "engineer@portfolio.local", "password": "é" * 37},
    {"email": "engineer@portfolio.local", "password": DEMO_PASSWORD, "role": "Administrator"},
])
async def test_login_rejects_invalid_missing_and_oversized_fields(client, payload):
    """Reject malformed payloads and query operators before repository access."""
    assert (await client.post("/api/v1/auth/login", json=payload)).status_code == 422


async def test_health_and_unauthenticated_identity_endpoints(client):
    """Keep liveness public while all personal operations require a bearer."""
    response = await client.get("/api/health")
    assert response.status_code == 200 and response.json() == {"status": "ok"}
    for method, path, payload in [("GET", "/auth/me", None), ("POST", "/auth/logout", None),
        ("PUT", "/profile", {"defaultLanding": "Dashboard"}),
        ("POST", "/profile/password", {"currentPassword": "x", "newPassword": "y", "confirmation": "y"})]:
        assert (await client.request(method, f"/api/v1{path}", json=payload)).status_code == 401


@pytest.mark.parametrize("mode", ["forged", "expired", "revoked", "missing-session", "wrong-user", "inactive", "missing-user", "missing-role", "version", "malformed", "missing-claims", "invalid-id"])
async def test_invalid_jwt_and_current_identity_changes_are_rejected(client, db, application, mode):
    """Fail closed for signature, claims, persisted revocation, and current account changes."""
    response = await client.post("/api/v1/auth/login", json={"email": "engineer@portfolio.local", "password": DEMO_PASSWORD})
    token = response.json()["token"]
    claims = jwt.get_unverified_claims(token)
    user_id, session_id = ObjectId(claims["sub"]), ObjectId(claims["jti"])
    secret = application.state.settings.JWT_SECRET
    if mode == "forged": token = jwt.encode(claims, "a-different-signing-secret", algorithm="HS256")
    elif mode == "expired": token = create_token(user_id, session_id, secret, datetime.now(timezone.utc) - timedelta(seconds=2))
    elif mode == "revoked": await db.sessions.update_one({"_id": session_id}, {"$set": {"revoked": True}})
    elif mode == "missing-session": await db.sessions.delete_one({"_id": session_id})
    elif mode == "wrong-user": await db.sessions.update_one({"_id": session_id}, {"$set": {"userId": ObjectId()}})
    elif mode == "inactive": await db.users.update_one({"_id": user_id}, {"$set": {"status": "Inactive"}})
    elif mode == "missing-user": await db.users.delete_one({"_id": user_id})
    elif mode == "missing-role": await db.roles.delete_one({"_id": (await db.users.find_one({"_id": user_id}))["roleId"]})
    elif mode == "version": await db.users.update_one({"_id": user_id}, {"$inc": {"authVersion": 1}})
    elif mode == "malformed": token = "not-a-jwt"
    elif mode == "missing-claims": token = jwt.encode({"sub": str(user_id)}, secret, algorithm="HS256")
    else: token = jwt.encode({"sub": "invalid", "jti": str(session_id), "exp": claims["exp"]}, secret, algorithm="HS256")
    assert (await client.get("/api/v1/auth/me", headers=bearer(token))).status_code == 401


async def test_persisted_expiry_enforced_before_ttl_removal(client, db, engineer_headers):
    """Do not rely on asynchronous TTL cleanup to deny an expired persisted session."""
    await db.sessions.update_many({}, {"$set": {"expiresAt": datetime.now(timezone.utc) - timedelta(seconds=1)}})
    assert (await client.get("/api/v1/auth/me", headers=engineer_headers)).status_code == 401


async def test_landing_persists_across_me_and_new_login(client, db, engineer_headers):
    """Save a preference through the service and requery authoritative Mongo state."""
    response = await client.put("/api/v1/profile", headers=engineer_headers, json={"defaultLanding": "Dashboard"})
    assert response.status_code == 200 and response.json()["defaultLanding"] == "Dashboard"
    assert (await db.users.find_one({"email": "engineer@portfolio.local"}))["defaultLanding"] == "Dashboard"
    assert (await client.get("/api/v1/auth/me", headers=engineer_headers)).json()["defaultLanding"] == "Dashboard"
    relogin = await client.post("/api/v1/auth/login", json={"email": "engineer@portfolio.local", "password": DEMO_PASSWORD})
    assert relogin.status_code == 200 and relogin.json()["user"]["defaultLanding"] == "Dashboard"
    for payload in [{"defaultLanding": "Unknown"}, {"defaultLanding": "Applications", "role": "Administrator"}, {}]:
        assert (await client.put("/api/v1/profile", headers=engineer_headers, json=payload)).status_code == 422


@pytest.mark.parametrize("payload,field,message", [
    ({"currentPassword": "wrong", "newPassword": "new", "confirmation": "new"}, "currentPassword", "Current password is incorrect."),
    ({"currentPassword": DEMO_PASSWORD, "newPassword": "new", "confirmation": "different"}, "confirmation", "Passwords do not match."),
])
async def test_password_service_refuses_proof_and_confirmation_without_mutating(client, db, engineer_headers, payload, field, message):
    """Retain prior credentials and sessions after rejected password changes."""
    old = await db.users.find_one({"email": "engineer@portfolio.local"})
    response = await client.post("/api/v1/profile/password", headers=engineer_headers, json=payload)
    assert response.status_code == 422 and response.json()["detail"][field] == message
    assert (await db.users.find_one({"_id": old["_id"]}))["passwordHash"] == old["passwordHash"]
    assert (await client.get("/api/v1/auth/me", headers=engineer_headers)).status_code == 200


@pytest.mark.parametrize("field,value", [("currentPassword", ""), ("newPassword", ""), ("confirmation", ""),
    ("currentPassword", "é" * 37), ("newPassword", "é" * 37), ("confirmation", "é" * 37)])
async def test_password_payload_boundaries(client, engineer_headers, field, value):
    """Validate every password field independently before service execution."""
    payload = {"currentPassword": DEMO_PASSWORD, "newPassword": "new", "confirmation": "new"}
    payload[field] = value
    assert (await client.post("/api/v1/profile/password", headers=engineer_headers, json=payload)).status_code == 422


async def test_forced_password_change_revokes_all_and_replaces_current_session(client, db, application):
    """Restrict initial administrator actions and atomically invalidate previous bearer versions."""
    login = {"email": "admin@portfolio.local", "password": DEMO_PASSWORD}
    first = (await client.post("/api/v1/auth/login", json=login)).json()
    other = (await client.post("/api/v1/auth/login", json=login)).json()
    identity = await authenticate_token(first["token"], IdentityRepository(db), application.state.settings.JWT_SECRET)
    with pytest.raises(HTTPException) as denied: require_permission(identity, "view")
    assert denied.value.status_code == 403
    assert (await client.put("/api/v1/profile", headers=bearer(first["token"]), json={"defaultLanding": "Applications"})).status_code == 200
    changed = await client.post("/api/v1/profile/password", headers=bearer(first["token"]),
        json={"currentPassword": DEMO_PASSWORD, "newPassword": "é" * 36, "confirmation": "é" * 36})
    assert changed.status_code == 200
    body = changed.json()
    assert body["token"] != first["token"] and body["user"]["mustChangePassword"] is False
    assert body["user"]["defaultLanding"] == "Applications"
    for token in [first["token"], other["token"]]:
        assert (await client.get("/api/v1/auth/me", headers=bearer(token))).status_code == 401
    assert (await client.get("/api/v1/auth/me", headers=bearer(body["token"]))).status_code == 200
    user = await db.users.find_one({"email": login["email"]})
    assert await verify_password("é" * 36, user["passwordHash"])
    assert user["authVersion"] == 1 and user["passwordHash"] != DEMO_PASSWORD
    assert (await client.post("/api/v1/auth/login", json=login)).status_code == 401
    assert await db.audit.count_documents({"summary": "Changed password."}) == 1
    identity = await authenticate_token(body["token"], IdentityRepository(db), application.state.settings.JWT_SECRET)
    require_permission(identity, "view")


async def test_service_password_conflict_and_missing_role_branches(service, db, application):
    """Exercise stale verified identity and a removed role directly without repository mocks."""
    session = await service.login(LoginRequest(email="engineer@portfolio.local", password=DEMO_PASSWORD))
    identity = await authenticate_token(session.token, IdentityRepository(db), application.state.settings.JWT_SECRET)
    await db.users.update_one({"_id": identity["user"]["_id"]}, {"$set": {"passwordHash": await hash_password("changed elsewhere")}})
    with pytest.raises(HTTPException) as conflict:
        await service.password(identity, PasswordRequest(currentPassword=DEMO_PASSWORD, newPassword="new", confirmation="new"))
    assert conflict.value.status_code == 409
    await db.roles.delete_one({"_id": identity["user"]["roleId"]})
    with pytest.raises(HTTPException) as missing:
        await service.public_user(identity["user"])
    assert missing.value.status_code == 401


async def test_current_roles_permissions_and_scopes_rechecked(service, db, application):
    """Use current Mongo role and scope instead of stale permissions in a bearer."""
    session = await service.login(LoginRequest(email="engineer@portfolio.local", password=DEMO_PASSWORD))
    repo = IdentityRepository(db)
    identity = await authenticate_token(session.token, repo, application.state.settings.JWT_SECRET)
    require_permission(identity, "edit", identity["user"]["portfolioAccess"][0])
    with pytest.raises(HTTPException) as hidden: require_permission(identity, "edit", ObjectId())
    assert hidden.value.status_code == 404 and hidden.value.detail == "This record is not available."
    await db.roles.update_one({"_id": identity["role"]["_id"]}, {"$set": {"permissions": ["view", "administer", "delete"]}})
    fresh = await authenticate_token(session.token, repo, application.state.settings.JWT_SECRET)
    assert (await service.public_user(fresh["user"])).permissions == ["view", "administer", "delete"]
    with pytest.raises(HTTPException) as denied: require_permission(fresh, "edit")
    assert denied.value.status_code == 403
    with pytest.raises(HTTPException) as admin: require_permission(fresh, "administer", administrator_only=True)
    assert admin.value.status_code == 403
    await db.users.update_one({"_id": fresh["user"]["_id"]}, {"$set": {"portfolioAccess": []}})
    fresh = await authenticate_token(session.token, repo, application.state.settings.JWT_SECRET)
    assert allowed_portfolios(fresh) is None
    leader = await service.login(LoginRequest(email="leader@portfolio.local", password=DEMO_PASSWORD))
    lead = await authenticate_token(leader.token, repo, application.state.settings.JWT_SECRET)
    await db.users.update_one({"_id": lead["user"]["_id"]}, {"$set": {"portfolioAccess": []}})
    lead = await authenticate_token(leader.token, repo, application.state.settings.JWT_SECRET)
    assert allowed_portfolios(lead) == []
    with pytest.raises(HTTPException) as unavailable: require_permission(lead, "view", ObjectId())
    assert unavailable.value.status_code == 404


async def test_logout_revokes_server_and_second_logout_fails(client, db, engineer_headers):
    """Invalidate server access, not merely device storage, and retain safe history."""
    response = await client.post("/api/v1/auth/logout", headers=engineer_headers)
    assert response.status_code == 204 and response.content == b""
    assert (await db.sessions.find_one({}))["revoked"] is True
    assert (await client.get("/api/v1/auth/me", headers=engineer_headers)).status_code == 401
    assert (await client.post("/api/v1/auth/logout", headers=engineer_headers)).status_code == 401
    assert await db.audit.count_documents({"action": "sign-out"}) == 1


async def test_hash_helpers_reject_truncation_and_corrupt_hashes():
    """Cover byte boundaries and fail-closed stored-hash verification."""
    stored = await hash_password("a" * 72)
    assert await verify_password("a" * 72, stored)
    assert not await verify_password("b", stored)
    assert not await verify_password("a" * 73, stored)
    assert not await verify_password("", stored)
    assert not await verify_password("valid", "corrupt-hash")
    for value in ["", "é" * 37]:
        with pytest.raises(ValueError): await hash_password(value)


async def test_seed_baseline_is_complete_idempotent_and_does_not_reset_edits(db):
    """Check all required persisted diversity and references before later features exist."""
    assert await db.roles.count_documents({}) == 6 and await db.users.count_documents({}) == 6
    assert await db.portfolios.count_documents({"status": "Active"}) == 3
    apps = await db.applications.find({}).to_list(None)
    assert len(apps) == 10 and {a["tier"] for a in apps} == {1, 2, 3, 4}
    assert {a["lifecycle"] for a in apps} == {"Active", "Deprecated", "Retired"}
    assert {a["criticality"] for a in apps} == {"Low", "Medium", "High", "Critical"}
    assert sum(a["risk"] == "High" for a in apps) >= 2
    assert sum(bool(a["repositoryLink"] and a["pipelineLink"]) for a in apps) >= 5
    ids = {p["_id"] for p in await db.portfolios.find({}).to_list(None)}
    assert all(a["portfolioId"] in ids and a["openCriticalDefects"] <= a["openDefects"] for a in apps)
    assert all(all(0 <= a[key] <= 100 for key in ["healthScore", "qualityScore", "automationCoverage", "unitTestCoverage"]) for a in apps)
    assert await db.users.count_documents({"lastSignIn": {"$exists": True}}) == 6
    before = await db.audit.count_documents({})
    await db.users.update_one({"email": "admin@portfolio.local"}, {"$set": {"defaultLanding": "Applications", "mustChangePassword": False}})
    await seed_database(db)
    assert await db.users.count_documents({}) == 6 and await db.applications.count_documents({}) == 10
    assert await db.audit.count_documents({}) == before
    assert (await db.users.find_one({"email": "admin@portfolio.local"}))["mustChangePassword"] is False
    with pytest.raises(DuplicateKeyError):
        await db.users.insert_one({"email": "admin@portfolio.local"})
