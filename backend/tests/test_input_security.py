"""Verify administered text boundaries and the shared plain-text policy."""

from typing import Any
import pytest
from app.schemas.text import plain_text
from tests.test_portfolios import headers


@pytest.mark.parametrize("text", ["<script>alert(1)</script>", "</ScRiPt>", "<img src=x onerror=alert(1)>",
                                  "<iframe src=https://example.com>", "<!-- markup -->", "<?xml version='1.0'?>",
                                  "&lt;script&gt;alert(1)&lt;/script&gt;", "%3Cscript%3Ealert(1)%3C/script%3E",
                                  "../../secret", r"..\..\secret", "See /srv/../secret", "See ../secret",
                                  "https://example.com/../secret", "https://example.com/%2e%2e%2fsecret"])
def test_plain_text_rejects_markup_and_traversal(text: str) -> None:
    """Reject raw and encoded markup or parent-directory path components."""
    with pytest.raises(ValueError):
        plain_text(text)


@pytest.mark.parametrize("text", ["", "O'Brien & Sons (C++)", "C#, .NET / Python", "2 < 3; 5 > 4",
                                  "First line.\nSecond line...", "' OR 1=1 --", '{"$ne":null}', ".*",
                                  "=SUM(1)", "+formula", "-formula", "@formula",
                                  "https://example.com/team/repo?a=1&b=2#readme"])
def test_plain_text_preserves_safe_content(text: str) -> None:
    """Leave permitted punctuation, descriptions and URLs unchanged."""
    assert plain_text(text) == text


@pytest.mark.parametrize("text", ["<script>alert(1)</script>", "<img src=x onerror=alert(1)>", "../../secret", r"..\..\secret"])
async def test_admin_dangerous_text_refused_without_mutation(db: Any, client: Any, text: str) -> None:
    """Reject unsafe user facts and role descriptions without account or audit changes."""
    auth = await headers(client, db)
    users = await db.users.find({}).sort("_id", 1).to_list(None)
    roles = await db.roles.find({}).sort("_id", 1).to_list(None)
    audit = await db.audit.find({}).sort("_id", 1).to_list(None)
    sessions = await db.sessions.find({}).sort("_id", 1).to_list(None)
    valid = dict(name="New Person", email="new@portfolio.local", role="Engineer", portfolioAccess=[],
                 status="Active", managerName="Manager", vendor=False)
    for field in ("name", "managerName", "email"):
        value = text + "@portfolio.local" if field == "email" else text
        for method, path in [("POST", "/api/v1/admin/users"), ("PUT", f"/api/v1/admin/users/{users[0]['_id']}")]:
            payload = {**valid, field: value}
            if method == "POST":
                payload["initialPassword"] = "Initial123!"
            response = await client.request(method, path, headers=auth, json=payload)
            assert response.status_code == 422
            assert any(error["loc"] == ["body", field] for error in response.json()["detail"])
    response = await client.put(f"/api/v1/admin/roles/{roles[0]['_id']}", headers=auth,
                                json={"description": text, "permissions": ["view"]})
    assert response.status_code == 422
    assert any(error["loc"] == ["body", "description"] for error in response.json()["detail"])
    assert await db.users.find({}).sort("_id", 1).to_list(None) == users
    assert await db.roles.find({}).sort("_id", 1).to_list(None) == roles
    assert await db.audit.find({}).sort("_id", 1).to_list(None) == audit
    assert await db.sessions.find({}).sort("_id", 1).to_list(None) == sessions


async def test_admin_safe_names_descriptions_and_password_policy(db: Any, client: Any) -> None:
    """Preserve punctuation and descriptive text without imposing a new password policy."""
    auth = await headers(client, db)
    payload = dict(name="O'Brien & Sons", email="o'brien@portfolio.local", role="Engineer", portfolioAccess=[],
                   status="Active", managerName="Anne-Marie (R&D)", vendor=True)
    created = await client.post("/api/v1/admin/users", headers=auth,
                                json={**payload, "initialPassword": "<script>../../password"})
    assert created.status_code == 201
    edited = await client.put(f"/api/v1/admin/users/{created.json()['id']}", headers=auth, json=payload)
    assert edited.status_code == 200
    stored = await db.users.find_one({"email": payload["email"]})
    assert all(stored[key] == payload[key] for key in ("name", "email", "managerName", "vendor", "status"))
    role = await db.roles.find_one({"name": "Engineer"})
    description = "Maintain C++ & .NET applications; 2 < 3.\nOwners' responsibilities."
    response = await client.put(f"/api/v1/admin/roles/{role['_id']}", headers=auth,
                                json={"description": description, "permissions": ["view", "create", "edit", "export"]})
    assert response.status_code == 200
    assert (await db.roles.find_one({"_id": role["_id"]}))["description"] == description
