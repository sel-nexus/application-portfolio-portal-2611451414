"""Verify inventory, identity, reporting and audit crossings using real MongoDB."""

import csv
import io
from bson import ObjectId
import pytest


async def login(client, email="admin@portfolio.local"):
    """Authenticate through the public HTTP boundary without fixture bypasses."""
    response = await client.post('/api/v1/auth/login', json={'email': email, 'password': 'PortalDemo123!'})
    assert response.status_code == 200
    token = response.json()['token']
    headers = {'Authorization': 'Bearer ' + token}
    if response.json()['user']['mustChangePassword']:
        changed = await client.post('/api/v1/profile/password', headers=headers, json={
            'currentPassword': 'PortalDemo123!', 'newPassword': 'PortalDemo123!', 'confirmation': 'PortalDemo123!'})
        assert changed.status_code == 200
        headers = {'Authorization': 'Bearer ' + changed.json()['token']}
    return headers


def application_payload(portfolio_id):
    """Supply every inventory field with independently known metric values."""
    return dict(name='Crossing application', portfolioId=portfolio_id, description='Crossing description',
        productArea='Integration Area', businessOwner='Business', technologyOwner='Technology', qualityOwner='Quality',
        criticality='Critical', tier=1, lifecycle='Active', technologyStack='Python React',
        repositoryLink='https://example.com/repo', pipelineLink='https://example.com/pipeline',
        healthScore=70, qualityScore=81, automationCoverage=65, unitTestCoverage=90,
        openDefects=5, openCriticalDefects=2, risk='High')


async def test_inventory_dashboard_reports_audit_and_delete_chain(client, db):
    """Trace a complete create/edit/export/delete chain across five routers."""
    auth = await login(client)
    portfolio = await client.post('/api/v1/portfolios', headers=auth, json=dict(
        name='Crossing portfolio', owner='Owner', description='Persisted', productArea='Integration Area', status='Active'))
    assert portfolio.status_code == 201
    pid = portfolio.json()['id']
    payload = application_payload(pid)
    created = await client.post('/api/v1/applications', headers=auth, json=payload)
    assert created.status_code == 201
    aid = created.json()['id']
    detail = await client.get('/api/v1/portfolios/' + pid, headers=auth)
    assert detail.status_code == 200
    assert detail.json()['applicationCount'] == 1 and detail.json()['qualityScore'] == 81
    assert detail.json()['applications'] == [{'id': aid, 'name': payload['name']}]
    dashboard = await client.get('/api/v1/dashboard', headers=auth, params={'portfolioId': pid})
    assert dashboard.status_code == 200
    assert dashboard.json()['metrics'] == dict(enterpriseQualityScore=81, applicationHealth=70,
        automationMaturity=65, openCriticalDefects=2, applicationsAtRisk=1, totalApplications=1, totalPortfolios=1)
    payload.update(healthScore=90, qualityScore=60, risk='Low', description='Updated crossing')
    edited = await client.put('/api/v1/applications/' + aid, headers=auth, json=payload)
    assert edited.status_code == 200
    report = await client.get('/api/v1/reports/applications', headers=auth, params={'portfolioId': pid})
    assert report.status_code == 200 and report.json()['total'] == 1
    assert report.json()['items'][0]['description'] == 'Updated crossing'
    exported = await client.get('/api/v1/reports/applications/csv', headers=auth, params={'portfolioId': pid})
    assert exported.status_code == 200
    rows = list(csv.reader(io.StringIO(exported.text)))
    assert len(rows) == 2 and rows[1][0] == payload['name'] and rows[1][5] == '90'
    log = await client.get('/api/v1/audit', headers=auth, params={'action': 'export'})
    assert log.status_code == 200
    assert any(row['entityType'] == 'report' for row in log.json()['items'])
    occupied = await client.delete('/api/v1/portfolios/' + pid, headers=auth)
    assert occupied.status_code == 409
    assert await db.portfolios.find_one({'_id': ObjectId(pid)}) is not None
    assert (await client.delete('/api/v1/applications/' + aid, headers=auth)).status_code == 204
    assert (await client.delete('/api/v1/portfolios/' + pid, headers=auth)).status_code == 204
    assert await db.applications.find_one({'_id': ObjectId(aid)}) is None
    assert await db.portfolios.find_one({'_id': ObjectId(pid)}) is None
    assert (await client.get('/api/v1/applications/' + aid, headers=auth)).status_code == 404
    assert await db.audit.count_documents({'entityId': ObjectId(aid), 'action': 'delete'}) == 1


async def test_admin_scope_change_updates_inventory_dashboard_reports_and_sessions(client, db):
    """Apply live assignments and deactivation across every read boundary."""
    admin = await login(client)
    engineer = await login(client, 'engineer@portfolio.local')
    users = await client.get('/api/v1/admin/users', headers=admin)
    assert users.status_code == 200
    person = next(row for row in users.json()['items'] if row['role'] == 'Engineer')
    target = await db.portfolios.find_one({'name': 'Data & Analytics'})
    edit = {key: person[key] for key in ('name', 'email', 'role', 'portfolioAccess', 'status', 'managerName', 'vendor')}
    edit['portfolioAccess'] = [str(target['_id'])]
    saved = await client.put('/api/v1/admin/users/' + person['id'], headers=admin, json=edit)
    assert saved.status_code == 200
    inventory = await client.get('/api/v1/applications', headers=engineer)
    report = await client.get('/api/v1/reports/applications', headers=engineer)
    metrics = await client.get('/api/v1/dashboard', headers=engineer)
    assert inventory.status_code == report.status_code == metrics.status_code == 200
    assert {row['portfolioId'] for row in inventory.json()['items']} == {str(target['_id'])}
    assert report.json()['items'] == inventory.json()['items']
    assert metrics.json()['metrics']['totalApplications'] == inventory.json()['total']
    assert metrics.json()['metrics']['totalPortfolios'] == 1
    hidden = await db.applications.find_one({'portfolioId': {'$ne': target['_id']}})
    denied = await client.get('/api/v1/applications/' + str(hidden['_id']), headers=engineer)
    assert denied.status_code == 404 and denied.json()['detail'] == 'This record is not available.'
    edit['status'] = 'Inactive'
    assert (await client.put('/api/v1/admin/users/' + person['id'], headers=admin, json=edit)).status_code == 200
    for path in ('applications', 'dashboard', 'reports/applications', 'auth/me'):
        assert (await client.get('/api/v1/' + path, headers=engineer)).status_code == 401
    assert await db.sessions.count_documents({'userId': ObjectId(person['id']), 'revoked': False}) == 0
    assert await db.audit.count_documents({'entityId': ObjectId(person['id']), 'action': 'edit'}) == 2


async def test_role_permission_change_refuses_exports_and_audits_without_mutation(client, db):
    """Reevaluate configured authority through already issued tokens."""
    admin = await login(client)
    executive = await login(client, 'executive@portfolio.local')
    roles = await client.get('/api/v1/admin/roles', headers=admin)
    assert roles.status_code == 200
    role = next(row for row in roles.json() if row['name'] == 'Executive')
    changed = await client.put('/api/v1/admin/roles/' + role['id'], headers=admin,
        json={'description': 'Read without export', 'permissions': ['view']})
    assert changed.status_code == 200
    before = await db.audit.count_documents({'action': 'export'})
    for path in ('applications/csv', 'reports/applications/csv', 'reports/portfolios/csv'):
        assert (await client.get('/api/v1/' + path, headers=executive)).status_code == 403
    assert await db.audit.count_documents({'action': 'export'}) == before
    assert (await client.get('/api/v1/dashboard', headers=executive)).status_code == 200
    assert await db.audit.count_documents({'entityId': ObjectId(role['id']), 'action': 'permission change'}) == 1


async def test_failed_target_and_duplicate_do_not_corrupt_downstream_data(client, db):
    """Keep aggregate and report state unchanged after upstream rejected writes."""
    auth = await login(client)
    before = await client.get('/api/v1/dashboard', headers=auth)
    assert before.status_code == 200
    count = await db.applications.count_documents({})
    bad = application_payload(str(ObjectId()))
    missing = await client.post('/api/v1/applications', headers=auth, json=bad)
    assert missing.status_code == 404
    portfolio = await db.portfolios.find_one({'name': 'Payments'})
    bad['portfolioId'] = str(portfolio['_id'])
    bad['name'] = (await db.applications.find_one({}))['name']
    duplicate = await client.post('/api/v1/applications', headers=auth, json=bad)
    assert duplicate.status_code == 409
    after = await client.get('/api/v1/dashboard', headers=auth)
    assert after.status_code == 200 and after.json() == before.json()
    report = await client.get('/api/v1/reports/applications', headers=auth)
    assert report.status_code == 200 and report.json()['total'] == count
    assert await db.applications.count_documents({}) == count


async def test_application_move_updates_all_aggregates_and_denied_move_is_atomic(client, db):
    """Reconcile old and new portfolio data after moves and denied ownership changes."""
    admin = await login(client)
    ids = []
    for name in ('Move source', 'Move target'):
        result = await client.post('/api/v1/portfolios', headers=admin, json=dict(
            name=name, owner='Owner', description='Move test', productArea='Move Area', status='Active'))
        assert result.status_code == 201
        ids.append(result.json()['id'])
    payload = application_payload(ids[0])
    created = await client.post('/api/v1/applications', headers=admin, json=payload)
    assert created.status_code == 201
    aid = created.json()['id']
    payload['portfolioId'] = ids[1]
    moved = await client.put('/api/v1/applications/' + aid, headers=admin, json=payload)
    assert moved.status_code == 200 and moved.json()['portfolio'] == 'Move target'
    for index, pid in enumerate(ids):
        detail = await client.get('/api/v1/portfolios/' + pid, headers=admin)
        assert detail.status_code == 200
        assert detail.json()['applicationCount'] == index
        assert detail.json()['qualityScore'] == (81 if index else 0)
        assert detail.json()['applications'] == ([{'id': aid, 'name': payload['name']}] if index else [])
        dashboard = await client.get('/api/v1/dashboard', headers=admin, params={'portfolioId': pid})
        assert dashboard.status_code == 200
        assert dashboard.json()['metrics']['totalApplications'] == index
        assert dashboard.json()['metrics']['enterpriseQualityScore'] == (81 if index else 0)
        assert dashboard.json()['portfolioQuality'] == ([{'id': pid, 'name': 'Move target', 'qualityScore': 81}] if index else [])
    aggregate = await client.get('/api/v1/dashboard', headers=admin)
    assert aggregate.status_code == 200
    assert ids[0] not in {row['id'] for row in aggregate.json()['portfolioQuality']}
    assert ids[1] in {row['id'] for row in aggregate.json()['portfolioQuality']}
    app_report = await client.get('/api/v1/reports/applications', headers=admin, params={'search': payload['name']})
    assert app_report.status_code == 200 and app_report.json()['items'][0]['portfolioId'] == ids[1]
    port_report = await client.get('/api/v1/reports/portfolios', headers=admin, params={'search': 'Move '})
    assert port_report.status_code == 200
    assert [(row['name'], row['applicationCount'], row['qualityScore']) for row in port_report.json()['items']] == [
        ('Move source', 0, 0), ('Move target', 1, 81)]
    for kind, search in (('applications', payload['name']), ('portfolios', 'Move ')):
        exported = await client.get('/api/v1/reports/' + kind + '/csv', headers=admin, params={'search': search})
        assert exported.status_code == 200
        rows = list(csv.reader(io.StringIO(exported.text)))
        if kind == 'applications':
            assert len(rows) == 2 and rows[1][1] == 'Move target'
        else:
            assert rows[1][3:5] == ['0', '0'] and rows[2][3:5] == ['1', '81']
    engineer = await login(client, 'engineer@portfolio.local')
    engineer_user = await db.users.find_one({'email': 'engineer@portfolio.local'})
    edit = {key: engineer_user[key] for key in ('name', 'email', 'status', 'managerName', 'vendor')}
    edit.update(role='Engineer', portfolioAccess=[ids[1]])
    assert (await client.put('/api/v1/admin/users/' + str(engineer_user['_id']), headers=admin, json=edit)).status_code == 200
    before = await client.get('/api/v1/dashboard', headers=admin)
    payload['portfolioId'] = ids[0]
    denied = await client.put('/api/v1/applications/' + aid, headers=engineer, json=payload)
    assert denied.status_code == 404
    after = await client.get('/api/v1/dashboard', headers=admin)
    assert after.status_code == 200 and after.json() == before.json()
    assert (await db.applications.find_one({'_id': ObjectId(aid)}))['portfolioId'] == ObjectId(ids[1])
    assert await db.audit.count_documents({'entityId': ObjectId(aid), 'action': 'edit'}) == 1
    assert (await client.delete('/api/v1/portfolios/' + ids[0], headers=admin)).status_code == 204
    assert await db.portfolios.find_one({'_id': ObjectId(ids[0])}) is None
    assert await db.applications.count_documents({'portfolioId': ObjectId(ids[1])}) == 1
