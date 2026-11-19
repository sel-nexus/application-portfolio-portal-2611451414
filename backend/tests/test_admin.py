"""Verify real Mongo administration, authorization, persistence and safe audit events."""

from datetime import datetime, timedelta, timezone
from typing import Any
from bson import ObjectId
import pytest
from fastapi import HTTPException
from app.core.security import authenticate_token, create_token, verify_password
from app.repositories.identity import IdentityRepository
from app.repositories.audit import AuditRepository
from app.services.admin import AdminService
from app.schemas.admin import UserCreate, UserPayload, RolePayload


@pytest.fixture
async def admin_headers(client, db) -> dict[str, str]:
    """Authenticate a test administrator after clearing the seeded forced-change flag."""
    await db.users.update_one({"email": "admin@portfolio.local"}, {"$set": {"mustChangePassword": False}})
    response = await client.post('/api/v1/auth/login', json={'email': 'admin@portfolio.local', 'password': 'PortalDemo123!'})
    assert response.status_code == 200
    return {'Authorization': 'Bearer ' + response.json()['token']}


@pytest.fixture
async def payload(db) -> dict[str, Any]:
    """Use a real existing portfolio assignment in full account maintenance."""
    portfolio = await db.portfolios.find_one({'name': 'Payments'})
    return dict(name='New Person', email='new@portfolio.local', role='Engineer', portfolioAccess=[str(portfolio['_id'])],
                status='Active', managerName='Manager', vendor=True, initialPassword='Initial123!')


@pytest.fixture
async def admin_service(db) -> AdminService:
    """Construct the actual service against the same pooled test database."""
    return AdminService(IdentityRepository(db), AuditRepository(db))


@pytest.fixture
async def identity(admin_headers, db, application) -> dict[str, Any]:
    """Resolve current identity through production token validation."""
    return await authenticate_token(admin_headers['Authorization'][7:], IdentityRepository(db), application.state.settings.JWT_SECRET)


async def test_create_edit_deactivate_requery_profile_history_and_sessions(client, db, admin_headers, payload):
    """Verify all maintained facts, hashing, role auditing and irreversible old-session revocation."""
    response = await client.post('/api/v1/admin/users', headers=admin_headers, json=payload)
    assert response.status_code == 201
    public = response.json()
    assert public['managerName'] == 'Manager' and public['vendor'] is True
    assert public['portfolioNames'] == ['Payments'] and public['lastSignIn'] is None
    assert 'passwordHash' not in public and 'initialPassword' not in public
    oid = ObjectId(public['id'])
    saved = await db.users.find_one({'_id': oid})
    assert await verify_password(payload['initialPassword'], saved['passwordHash'])
    login = await client.post('/api/v1/auth/login', json={'email': payload['email'], 'password': payload['initialPassword']})
    assert login.status_code == 200
    old_headers = {'Authorization': 'Bearer ' + login.json()['token']}
    edit = {key: value for key, value in payload.items() if key != 'initialPassword'}
    edit.update(name='Changed Person', email='changed@portfolio.local', managerName='Changed Manager', vendor=False, role='Executive', portfolioAccess=[])
    response = await client.put('/api/v1/admin/users/' + public['id'], headers=admin_headers, json=edit)
    assert response.status_code == 200 and response.json()['role'] == 'Executive'
    profile = await client.get('/api/v1/auth/me', headers=old_headers)
    assert profile.status_code == 200
    assert all(profile.json()[key] == value for key, value in edit.items())
    edit['status'] = 'Inactive'
    response = await client.put('/api/v1/admin/users/' + public['id'], headers=admin_headers, json=edit)
    assert response.status_code == 200 and response.json()['status'] == 'Inactive'
    assert (await client.get('/api/v1/auth/me', headers=old_headers)).status_code == 401
    assert await db.sessions.count_documents({'userId': oid, 'revoked': False}) == 0
    inactive = await client.post('/api/v1/auth/login', json={'email': edit['email'], 'password': payload['initialPassword']})
    assert inactive.status_code == 403 and inactive.json()['detail'] == 'This account is inactive.'
    edit['status'] = 'Active'
    assert (await client.put('/api/v1/admin/users/' + public['id'], headers=admin_headers, json=edit)).status_code == 200
    assert (await client.get('/api/v1/auth/me', headers=old_headers)).status_code == 401
    rows = (await client.get('/api/v1/admin/users', headers=admin_headers)).json()['items']
    assert next(row for row in rows if row['id'] == public['id'])['name'] == edit['name']
    events = await db.audit.find({'entityId': oid}).to_list(None)
    assert {'create', 'edit', 'role change', 'sign-in success', 'sign-in failure'} <= {event['action'] for event in events}
    for event in events:
        assert event['person'] and event['time'] and event['entityType'] == 'user'
        assert payload['initialPassword'] not in str(event) and saved['passwordHash'] not in str(event)
        assert login.json()['token'] not in str(event)


async def test_roles_persist_description_permissions_live_and_sensitive_restrictions(client, db, admin_headers, engineer_headers):
    """Role changes immediately affect existing tokens without enabling non-admin sensitive access."""
    result = await client.get('/api/v1/admin/roles', headers=admin_headers)
    assert result.status_code == 200
    roles = result.json()
    assert {row['name'] for row in roles} == {'Administrator', 'Executive', 'Portfolio Leader', 'Engineer', 'Auditor', 'Read Only'}
    engineer = next(row for row in roles if row['name'] == 'Engineer')
    change = {'description': 'Updated duties', 'permissions': ['view', 'delete', 'administer']}
    result = await client.put('/api/v1/admin/roles/' + engineer['id'], headers=admin_headers, json=change)
    assert result.status_code == 200 and result.json()['name'] == 'Engineer'
    assert (await db.roles.find_one({'_id': ObjectId(engineer['id'])}))['permissions'] == change['permissions']
    assert (await client.get('/api/v1/auth/me', headers=engineer_headers)).json()['permissions'] == change['permissions']
    assert (await client.get('/api/v1/admin/users', headers=engineer_headers)).status_code == 403
    application = await db.applications.find_one({'portfolioId': (await db.users.find_one({'email': 'engineer@portfolio.local'}))['portfolioAccess'][0]})
    assert (await client.delete('/api/v1/applications/' + str(application['_id']), headers=engineer_headers)).status_code == 403
    assert await db.audit.count_documents({'entityId': ObjectId(engineer['id']), 'action': 'permission change'}) == 1
    reread = (await client.get('/api/v1/admin/roles', headers=admin_headers)).json()
    assert next(row for row in reread if row['id'] == engineer['id'])['description'] == change['description']
    administrator = next(row for row in roles if row['name'] == 'Administrator')
    assert (await client.put('/api/v1/admin/roles/' + administrator['id'], headers=admin_headers,
                             json={'description': 'Restricted', 'permissions': ['view']})).status_code == 200
    denied = await client.get('/api/v1/admin/roles', headers=admin_headers)
    assert denied.status_code == 403 and denied.json()['detail'] == 'You do not have access to administration.'


@pytest.mark.parametrize('method,path', [('GET','users'), ('POST','users'), ('PUT','users/000000000000000000000001'),
                                        ('GET','roles'), ('PUT','roles/000000000000000000000001')])
async def test_all_endpoints_no_token_wrong_role_forced_and_missing_administer(client, db, admin_headers, payload, method, path):
    """Require bearer, ordinary-password session, Administrator role and current permission everywhere."""
    body = payload if method == 'POST' else {key: value for key, value in payload.items() if key != 'initialPassword'}
    if path.startswith('roles'): body = {'description': '', 'permissions': ['view']}
    kwargs = {'json': body} if method != 'GET' else {}
    url = '/api/v1/admin/' + path
    assert (await client.request(method, url, **kwargs)).status_code == 401
    for email in ['executive', 'leader', 'engineer', 'auditor', 'readonly']:
        login = await client.post('/api/v1/auth/login', json={'email': email+'@portfolio.local', 'password': 'PortalDemo123!'})
        headers = {'Authorization': 'Bearer '+login.json()['token']}
        assert (await client.request(method, url, headers=headers, **kwargs)).status_code == 403
    await db.users.update_one({'email': 'admin@portfolio.local'}, {'$set': {'mustChangePassword': True}})
    assert (await client.request(method, url, headers=admin_headers, **kwargs)).status_code == 403
    await db.users.update_one({'email': 'admin@portfolio.local'}, {'$set': {'mustChangePassword': False}})
    await db.roles.update_one({'name': 'Administrator'}, {'$set': {'permissions': ['view']}})
    assert (await client.request(method, url, headers=admin_headers, **kwargs)).status_code == 403


@pytest.mark.parametrize('key,value', [('name',' '), ('name','x'*201), ('name','bad\nname'), ('email','bad'), ('email','x'*255),
    ('email',{'$ne':None}), ('role','Operator'), ('portfolioAccess',['bad']), ('portfolioAccess',[str(ObjectId())]),
    ('status','Deleted'), ('vendor','yes'), ('managerName','x'*201), ('initialPassword',''), ('initialPassword','é'*37),
    ('passwordHash','secret'), ('roleId',str(ObjectId()))])
async def test_user_validation_rejects_bad_fields_without_mutation(client, db, admin_headers, payload, key, value):
    """Reject malformed, operator, unknown, oversized and credential-bearing requests."""
    payload[key] = value
    before = await db.users.count_documents({})
    response = await client.post('/api/v1/admin/users', headers=admin_headers, json=payload)
    assert response.status_code == 422
    assert await db.users.count_documents({}) == before


@pytest.mark.parametrize('key', ['name','email','role','portfolioAccess','status','managerName','vendor','initialPassword'])
async def test_create_each_missing_required_field(client, admin_headers, payload, key):
    """Refuse incomplete account creation one required field at a time."""
    payload.pop(key)
    assert (await client.post('/api/v1/admin/users', headers=admin_headers, json=payload)).status_code == 422


@pytest.mark.parametrize('key', ['name', 'email', 'role', 'portfolioAccess', 'status', 'managerName', 'vendor'])
async def test_update_each_missing_required_field_preserves_state(
    client: Any, db: Any, admin_headers: dict[str, str], payload: dict[str, Any], key: str,
) -> None:
    """Identify each omitted maintenance field without changing accounts, sessions or history."""
    created = await client.post('/api/v1/admin/users', headers=admin_headers, json=payload)
    assert created.status_code == 201
    login = await client.post('/api/v1/auth/login', json={'email': payload['email'], 'password': payload['initialPassword']})
    assert login.status_code == 200
    edit = {field: value for field, value in payload.items() if field != 'initialPassword'}
    edit.update(name='Rejected edit', role='Executive', status='Inactive', managerName='Changed manager', vendor=False)
    edit.pop(key)
    before = {name: await db[name].find({}).sort('_id', 1).to_list(None) for name in ('users', 'sessions', 'audit')}
    assert any(row['userId'] == ObjectId(created.json()['id']) and not row['revoked'] for row in before['sessions'])

    response = await client.put('/api/v1/admin/users/' + created.json()['id'], headers=admin_headers, json=edit)

    assert response.status_code == 422
    errors = response.json()['detail']
    assert any(error['loc'] == ['body', key] and error['type'] == 'missing' for error in errors)
    for name, rows in before.items():
        assert await db[name].find({}).sort('_id', 1).to_list(None) == rows


@pytest.mark.parametrize('key,value', [
    ('name', 123), ('email', {'$ne': None}), ('role', ['Engineer']),
    ('portfolioAccess', {'$ne': None}), ('portfolioAccess', [123]),
    ('status', 123), ('managerName', ['Manager']), ('vendor', 'false'), ('vendor', 0),
    ('name', None), ('email', None), ('role', None), ('portfolioAccess', None),
    ('status', None), ('managerName', None), ('vendor', None),
])
async def test_update_each_invalid_field_type_preserves_state(
    client: Any, db: Any, admin_headers: dict[str, str], payload: dict[str, Any], key: str, value: Any,
) -> None:
    """Reject invalid maintenance types at the affected field without any write or revocation."""
    created = await client.post('/api/v1/admin/users', headers=admin_headers, json=payload)
    assert created.status_code == 201
    login = await client.post('/api/v1/auth/login', json={'email': payload['email'], 'password': payload['initialPassword']})
    assert login.status_code == 200
    edit = {field: item for field, item in payload.items() if field != 'initialPassword'}
    edit.update(name='Rejected edit', role='Executive', status='Inactive', managerName='Changed manager', vendor=False)
    edit[key] = value
    before = {name: await db[name].find({}).sort('_id', 1).to_list(None) for name in ('users', 'sessions', 'audit')}
    assert any(row['userId'] == ObjectId(created.json()['id']) and not row['revoked'] for row in before['sessions'])

    response = await client.put('/api/v1/admin/users/' + created.json()['id'], headers=admin_headers, json=edit)

    assert response.status_code == 422
    errors = response.json()['detail']
    assert any(error['loc'][:2] == ['body', key] for error in errors)
    for name, rows in before.items():
        assert await db[name].find({}).sort('_id', 1).to_list(None) == rows


async def test_duplicate_create_edit_and_create_only_password(client, db, admin_headers, payload):
    """Normalize email uniqueness and preserve credentials/profile during edits."""
    first = await client.post('/api/v1/admin/users', headers=admin_headers, json=payload)
    assert first.status_code == 201
    payload['email'] = ' NEW@PORTFOLIO.LOCAL '
    duplicate = await client.post('/api/v1/admin/users', headers=admin_headers, json=payload)
    assert duplicate.status_code == 409 and 'email' in duplicate.json()['detail']
    edit = {key:value for key,value in payload.items() if key != 'initialPassword'}
    oid = first.json()['id']
    assert (await client.put('/api/v1/admin/users/'+oid, headers=admin_headers, json=payload)).status_code == 422
    edit['email'] = 'engineer@portfolio.local'
    assert (await client.put('/api/v1/admin/users/'+oid, headers=admin_headers, json=edit)).status_code == 409
    assert (await db.users.find_one({'_id': ObjectId(oid)}))['email'] == 'new@portfolio.local'
    payload['email'] = 'short@portfolio.local'; payload['initialPassword'] = 'x'
    assert (await client.post('/api/v1/admin/users', headers=admin_headers, json=payload)).status_code == 201
    payload['email'] = 'max@portfolio.local'; payload['initialPassword'] = 'é'*36
    assert (await client.post('/api/v1/admin/users', headers=admin_headers, json=payload)).status_code == 201


@pytest.mark.parametrize('path,body', [('users',None), ('roles',None)])
@pytest.mark.parametrize('identifier', ['bad', '000000000000000000000001'])
async def test_edit_bad_missing_ids(client, admin_headers, payload, path, body, identifier):
    """Return unavailable record rather than a BSON conversion error."""
    body = {'description':'', 'permissions':[]} if path == 'roles' else {k:v for k,v in payload.items() if k!='initialPassword'}
    response = await client.put(f'/api/v1/admin/{path}/{identifier}', headers=admin_headers, json=body)
    assert response.status_code == 404 and response.json()['detail'] == 'This record is not available.'


@pytest.mark.parametrize('body', [{'description':'', 'permissions':['operate']}, {'description':'', 'permissions':['view','view']},
    {'description':'', 'permissions':{'$ne':None}}, {'description':'x'*5001,'permissions':[]},
    {'description':'', 'permissions':[], 'name':'Renamed'}, {'permissions':[]}, {'description':''}])
async def test_role_validation(client, db, admin_headers, body):
    """Keep names fixed and reject unsupported configuration without changing state."""
    role = await db.roles.find_one({'name':'Engineer'})
    response = await client.put('/api/v1/admin/roles/'+str(role['_id']), headers=admin_headers, json=body)
    assert response.status_code == 422
    assert await db.roles.find_one({'_id':role['_id']}) == role


async def test_paging_empty_bounds_no_secret(client, admin_headers):
    """Return stable disjoint pages and bounded empty results without hashes."""
    first = await client.get('/api/v1/admin/users?page=1&page_size=2', headers=admin_headers)
    second = await client.get('/api/v1/admin/users?page=2&page_size=2', headers=admin_headers)
    assert first.status_code == second.status_code == 200
    assert first.json()['total'] == 6 and len(first.json()['items']) == 2
    assert not ({row['id'] for row in first.json()['items']} & {row['id'] for row in second.json()['items']})
    assert 'passwordHash' not in first.text and 'authVersion' not in first.text
    empty = await client.get('/api/v1/admin/users?page=100', headers=admin_headers)
    assert empty.status_code == 200 and empty.json()['items'] == []
    for query in ['page=0','page_size=0','page_size=101','page=bad']:
        assert (await client.get('/api/v1/admin/users?'+query,headers=admin_headers)).status_code == 422


async def test_service_branches_missing_role_portfolio_and_empty_permissions(admin_service, identity, db, payload):
    """Exercise direct service rules using actual repository reads and writes."""
    result = await admin_service.users(identity, 100, 10)
    assert result['items'] == []
    with pytest.raises(ValueError): await admin_service.users(identity, 0)
    role = await db.roles.find_one({'name':'Engineer'})
    await db.roles.delete_one({'_id':role['_id']})
    with pytest.raises(HTTPException) as error: await admin_service.fields(UserCreate(**payload))
    assert error.value.status_code == 422
    await db.roles.insert_one(role)
    payload['portfolioAccess'] = [str(ObjectId())]
    with pytest.raises(HTTPException) as error: await admin_service.create(identity, UserCreate(**payload))
    assert error.value.status_code == 422
    saved = await admin_service.update_role(identity, str(role['_id']), RolePayload(description='',permissions=[]))
    assert saved.permissions == []
    assert len(await admin_service.roles(identity)) == 6
    extra = await db.roles.insert_one({'name':'Operator','description':'','permissions':[]})
    assert len(await admin_service.roles(identity)) == 6
    with pytest.raises(HTTPException) as error: await admin_service.update_role(identity,str(extra.inserted_id),RolePayload(description='',permissions=[]))
    assert error.value.status_code == 404

async def test_current_actor_role_change_is_enforced_on_existing_token(client, db, admin_headers, payload):
    """Demoting the acting administrator revokes sensitive authority without token replacement."""
    actor = await db.users.find_one({'email':'admin@portfolio.local'})
    edit = {key:value for key,value in payload.items() if key!='initialPassword'}
    edit.update(name=actor['name'], email=actor['email'], role='Executive')
    result = await client.put('/api/v1/admin/users/'+str(actor['_id']),headers=admin_headers,json=edit)
    assert result.status_code == 200 and result.json()['role'] == 'Executive'
    denied = await client.get('/api/v1/admin/users',headers=admin_headers)
    assert denied.status_code == 403
    assert (await client.get('/api/v1/auth/me',headers=admin_headers)).json()['role'] == 'Executive'


async def test_expired_bearer_is_rejected(client, db, application, admin_headers):
    """Reject an expired signed administrator token before exposing any account facts."""
    user = await db.users.find_one({'email':'admin@portfolio.local'})
    token = create_token(user['_id'], ObjectId(), application.state.settings.JWT_SECRET, datetime.now(timezone.utc)-timedelta(seconds=1))
    result = await client.get('/api/v1/admin/users',headers={'Authorization':'Bearer '+token})
    assert result.status_code == 401
    assert 'items' not in result.json()


async def test_direct_service_create_edit_and_unchanged_permissions_audit(admin_service, identity, payload, db):
    """Exercise service writes and verify description-only edits do not claim permission changes."""
    created = await admin_service.create(identity, UserCreate(**payload))
    edit = {key:value for key,value in payload.items() if key!='initialPassword'}
    edit['managerName'] = 'Service Manager'
    saved = await admin_service.update(identity,created.id,UserPayload(**edit))
    assert saved.managerName == 'Service Manager'
    assert (await db.users.find_one({'_id':ObjectId(saved.id)}))['managerName'] == 'Service Manager'
    role = await db.roles.find_one({'name':'Engineer'})
    await admin_service.update_role(identity,str(role['_id']),RolePayload(description='Description only',permissions=role['permissions']))
    assert await db.audit.count_documents({'entityId':role['_id'],'action':'permission change'}) == 0
    payload['email'] = 'inactive-create@portfolio.local'; payload['status'] = 'Inactive'
    inactive = await admin_service.create(identity,UserCreate(**payload))
    assert inactive.status == 'Inactive'


async def test_update_user_removed_after_initial_read_returns_exact_404_without_audit(
    client: Any, db: Any, admin_service: AdminService, identity: dict[str, Any], payload: dict[str, Any],
) -> None:
    """Delete a real account between the service read and real update, retaining sessions and history."""
    created = await admin_service.create(identity, UserCreate(**payload))
    oid = ObjectId(created.id)
    login = await client.post('/api/v1/auth/login', json={'email': payload['email'], 'password': payload['initialPassword']})
    assert login.status_code == 200
    before_audit = await db.audit.find({}).sort('_id', 1).to_list(None)
    before_sessions = await db.sessions.find({}).sort('_id', 1).to_list(None)
    assert any(row['userId'] == oid and not row['revoked'] for row in before_sessions)
    other_users = await db.users.find({'_id': {'$ne': oid}}).sort('_id', 1).to_list(None)

    class RemovedAfterRead(IdentityRepository):
        """Coordinate real deletion after reading the target; inherit the production update."""

        async def user_by_id(self, user_id: ObjectId) -> dict[str, Any] | None:
            """Return the real initial document only after its deletion has completed."""
            previous = await super().user_by_id(user_id)
            assert user_id == oid and previous is not None
            assert (await self.db.users.delete_one({'_id': user_id})).deleted_count == 1
            return previous

    racing = AdminService(RemovedAfterRead(db), AuditRepository(db))
    edit = {key: value for key, value in payload.items() if key != 'initialPassword'}
    edit.update(status='Inactive', role='Executive')
    with pytest.raises(HTTPException) as missing:
        await racing.update(identity, created.id, UserPayload(**edit))

    assert missing.value.status_code == 404
    assert missing.value.detail == 'This record is not available.'
    assert await db.users.find_one({'_id': oid}) is None
    assert await db.users.find({}).sort('_id', 1).to_list(None) == other_users
    assert await db.sessions.find({}).sort('_id', 1).to_list(None) == before_sessions
    assert await db.audit.find({}).sort('_id', 1).to_list(None) == before_audit
    assert await db.audit.count_documents({'entityId': oid, 'action': {'$in': ['edit', 'role change']}}) == 0


async def test_update_role_removed_after_initial_read_returns_exact_404_without_audit(
    db: Any, identity: dict[str, Any],
) -> None:
    """Delete a real supported role after the initial read and let Mongo return no saved document."""
    role = await db.roles.find_one({'name': 'Engineer'})
    oid = role['_id']
    before_audit = await db.audit.find({}).sort('_id', 1).to_list(None)
    before_users = await db.users.find({}).sort('_id', 1).to_list(None)
    before_sessions = await db.sessions.find({}).sort('_id', 1).to_list(None)
    other_roles = await db.roles.find({'_id': {'$ne': oid}}).sort('_id', 1).to_list(None)

    class RemovedAfterRead(IdentityRepository):
        """Coordinate real role deletion while leaving the production update unchanged."""

        async def role(self, role_id: ObjectId) -> dict[str, Any] | None:
            """Read the existing supported role, then delete it before returning to the service."""
            previous = await super().role(role_id)
            assert role_id == oid and previous is not None
            assert (await self.db.roles.delete_one({'_id': role_id})).deleted_count == 1
            return previous

    racing = AdminService(RemovedAfterRead(db), AuditRepository(db))
    assert role['permissions'] != ['view']
    with pytest.raises(HTTPException) as missing:
        await racing.update_role(identity, str(oid), RolePayload(description='Rejected change', permissions=['view']))

    assert missing.value.status_code == 404
    assert missing.value.detail == 'This record is not available.'
    assert await db.roles.find_one({'_id': oid}) is None
    assert await db.roles.find({}).sort('_id', 1).to_list(None) == other_roles
    assert await db.users.find({}).sort('_id', 1).to_list(None) == before_users
    assert await db.sessions.find({}).sort('_id', 1).to_list(None) == before_sessions
    assert await db.audit.find({}).sort('_id', 1).to_list(None) == before_audit
    assert await db.audit.count_documents({'entityId': oid, 'action': {'$in': ['edit', 'permission change']}}) == 0
