import json
import os
import stat
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from pathlib import Path

import pytest

from business.domain import Business, BusinessError
from business.store import Store


@pytest.fixture
def business(tmp_path):
    return Business(Store(str(tmp_path / 'workspace.db')))


def test_store_private_files_preserve_data_and_unrelated_directory_modes(tmp_path):
    workspace = tmp_path / 'selected'
    unrelated = tmp_path / 'unrelated'
    unrelated.mkdir()
    parent_mode = stat.S_IMODE(tmp_path.stat().st_mode)
    unrelated_mode = stat.S_IMODE(unrelated.stat().st_mode)
    store = Store(workspace / 'business.db')
    with store.connect() as db:
        db.execute('CREATE TABLE privacy_test (value TEXT)')
        db.execute('INSERT INTO privacy_test VALUES (?)', ('Persist this',))
        db.commit()
        files = [Path(store.path + suffix) for suffix in ('', '-wal', '-shm')]
        assert all(path.exists() for path in files)
        if os.name == 'posix':
            assert stat.S_IMODE(workspace.stat().st_mode) == 0o700
            assert all(stat.S_IMODE(path.stat().st_mode) == 0o600 for path in files)
            # Reopening also repairs files left by an older, permissive version.
            workspace.chmod(0o755)
            for path in files:
                path.chmod(0o666)
        reopened = Store(store.path)
        if os.name == 'posix':
            assert stat.S_IMODE(workspace.stat().st_mode) == 0o700
            assert all(stat.S_IMODE(path.stat().st_mode) == 0o600 for path in files)
            assert stat.S_IMODE(tmp_path.stat().st_mode) == parent_mode
            assert stat.S_IMODE(unrelated.stat().st_mode) == unrelated_mode
    with reopened.connect() as db:
        assert db.execute('SELECT value FROM privacy_test').fetchone()['value'] == 'Persist this'


def test_persistence_versions_archive_and_activity(business):
    client = business.create('clients', {'name': 'Acme', 'tags': ['video', 'video']}, actor='harness')
    assert client['tags'] == ['video'] and client['version'] == 1
    assert client['created_by'] == 'harness'
    changed = business.update('clients', client['id'], {'company': 'Acme Studios'}, 1)
    assert changed['version'] == 2 and changed['name'] == 'Acme'
    with pytest.raises(BusinessError) as error:
        business.update('clients', client['id'], {'name': 'Stale'}, 1)
    assert error.value.status == 409
    archived = business.archive('clients', client['id'], 2)
    assert archived['version'] == 3
    reopened = Business(Store(business.store.path))
    assert reopened.list('clients') == []
    assert reopened.list('clients', archived=True)[0]['company'] == 'Acme Studios'
    assert [entry['action'] for entry in reopened.activity()] == ['archived', 'updated', 'created']
    assert reopened.export()['records']['clients'][0]['id'] == client['id']


def test_private_workspaces_and_references(business, tmp_path):
    foreign = Business(Store(str(tmp_path / 'other.db')))
    client = business.create('clients', {'name': 'Private client'})
    with pytest.raises(BusinessError) as error:
        foreign.get('clients', client['id'])
    assert error.value.status == 404
    with pytest.raises(BusinessError):
        foreign.create('projects', {'name': 'Foreign link', 'client_id': client['id']})
    assert foreign.activity() == [] and foreign.list('projects') == []


@pytest.mark.parametrize('kind,body', [
    ('clients', {'name': ' '}),
    ('clients', {'name': 'A', 'unexpected': True}),
    ('clients', {'name': 'A', 'follow_up_date': '2026-02-30'}),
    ('projects', {'name': 'A', 'due_date': '2026-1-01'}),
    ('projects', {'name': 'A', 'budget': '-1'}),
    ('leads', {'name': 'A', 'currency': 'XYZ'}),
    ('finances', {'title': 'A', 'amount': 'NaN'}),
    ('finances', {'title': 'A', 'amount': 'Infinity'}),
    ('finances', {'title': 'A', 'amount': '-1'}),
    ('finances', {'title': 'A', 'amount': '0'}),
    ('finances', {'title': 'A', 'amount': True}),
    ('finances', {'title': 'A', 'amount': '0.0000001'}),
    ('finances', {'title': 'A', 'amount': '1', 'date': ''}),
    ('events', {'title': 'A', 'start': '2026-11-01T12:00:00', 'end': '2026-11-01T13:00:00'}),
    ('events', {'title': 'A', 'start': '2026-11-01T14:00:00Z', 'end': '2026-11-01T13:00:00Z'}),
    ('portfolio', {'title': 'A', 'url': 'javascript:alert(1)'}),
])
def test_invalid_records_are_atomic(business, kind, body):
    with pytest.raises(BusinessError):
        business.create(kind, body)
    assert business.list(kind) == [] and business.activity() == []


def test_create_idempotency_returns_original_result_and_conflicts(business):
    first = business.create('clients', {'name': 'Acme'}, request_id='same-request')
    second = business.create('clients', {'name': 'Acme'}, request_id='same-request')
    assert first == second and len(business.list('clients')) == 1
    with pytest.raises(BusinessError) as error:
        business.create('clients', {'name': 'Different'}, request_id='same-request')
    assert error.value.status == 409
    assert len(business.activity()) == 1


def test_conversion_atomic_and_concurrent_retry_safe(business):
    lead = business.create('leads', {'name': 'Future Client', 'email': 'a@example.com', 'estimated_value': '500'})
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: business.convert_lead(lead['id'], request_id='convert-1'), range(2)))
    assert results[0] == results[1]
    converted = results[0]
    assert converted['lead']['status'] == 'won'
    assert converted['client']['lead_id'] == lead['id']
    assert converted['lead']['client_id'] == converted['client']['id']
    assert len(business.list('clients')) == 1
    repeated = business.convert_lead(lead['id'], request_id='another-convert')
    assert repeated['already_converted'] is True
    assert len(business.list('clients')) == 1 and len(business.activity()) == 3
    with pytest.raises(BusinessError):
        business.update('leads', lead['id'], {'status': 'lost'}, 2)


def test_reference_consistency_and_archiving_preserves_history(business):
    client = business.create('clients', {'name': 'Client A'})
    other = business.create('clients', {'name': 'Client B'})
    project = business.create('projects', {'name': 'Film', 'client_id': client['id']})
    invoice = business.create('finances', {'title': 'Deposit', 'amount': '100', 'client_id': client['id'], 'project_id': project['id']})
    with pytest.raises(BusinessError):
        business.create('tasks', {'title': 'Wrong client', 'project_id': project['id'], 'client_id': other['id']})
    with pytest.raises(BusinessError):
        business.update('projects', project['id'], {'client_id': other['id']}, 1)
    business.archive('clients', client['id'], 1)
    assert business.get('finances', invoice['id'])['client_id'] == client['id']
    business.update('finances', invoice['id'], {'status': 'paid'}, 1)
    with pytest.raises(BusinessError):
        business.create('projects', {'name': 'New project', 'client_id': client['id']})


def test_decimal_totals_currency_and_drilldown(business):
    dollar = business.create('finances', {'title': 'Paid', 'amount': '0.10', 'currency': 'USD', 'status': 'paid', 'date': '2026-10-01'})
    business.create('finances', {'title': 'Paid again', 'amount': '0.20', 'currency': 'USD', 'status': 'paid', 'date': '2026-10-02'})
    expense = business.create('finances', {'title': 'Expense', 'type': 'expense', 'amount': '0.10', 'currency': 'USD', 'status': 'paid', 'date': '2026-10-03'})
    business.create('finances', {'title': 'Pending', 'amount': '200', 'currency': 'USD', 'status': 'pending', 'date': '2026-10-03'})
    business.create('finances', {'title': 'Cancelled', 'amount': '999', 'currency': 'USD', 'status': 'cancelled', 'date': '2026-10-03'})
    business.create('finances', {'title': 'Euro', 'amount': '10', 'currency': 'EUR', 'status': 'paid', 'date': '2026-10-03'})
    dashboard = business.dashboard(start='2026-10-01', end='2026-10-31')
    totals = {item['currency']: item for item in dashboard['totals_by_currency']}
    assert totals['USD']['revenue'] == '0.30'
    assert totals['USD']['expenses'] == '0.10' and totals['USD']['net'] == '0.20'
    assert totals['USD']['outstanding'] == '200' and totals['EUR']['revenue'] == '10'
    assert dollar['id'] in totals['USD']['record_ids']['revenue']
    assert expense['id'] in totals['USD']['record_ids']['expenses']
    assert {item['currency'] for item in dashboard['monthly']} == {'USD', 'EUR'}
    json.dumps(dashboard, allow_nan=False)


def test_filters_consistently_limit_totals_records_actions_and_series(business):
    client = business.create('clients', {'name': 'Selected'})
    other = business.create('clients', {'name': 'Other'})
    project = business.create('projects', {'name': 'Project', 'client_id': client['id'], 'due_date': '2026-10-10'})
    invoice = business.create('finances', {'title': 'Selected income', 'amount': '20', 'status': 'paid', 'project_id': project['id'], 'date': '2026-10-10'})
    business.create('finances', {'title': 'Other income', 'amount': '900', 'status': 'paid', 'client_id': other['id'], 'date': '2026-10-10'})
    business.create('finances', {'title': 'Wrong month', 'amount': '500', 'status': 'paid', 'project_id': project['id'], 'date': '2026-09-10'})
    task = business.create('tasks', {'title': 'Selected task', 'project_id': project['id'], 'due_date': '2026-10-10'})
    business.create('tasks', {'title': 'Wrong month', 'project_id': project['id'], 'due_date': '2026-09-10'})
    dashboard = business.dashboard(start='2026-10-01', end='2026-10-31', client_id=client['id'], project_id=project['id'], currency='USD')
    assert dashboard['totals_by_currency'][0]['revenue'] == '20'
    assert [item['id'] for item in dashboard['records']['finances']] == [invoice['id']]
    assert dashboard['counts']['tasks'] == 1
    assert task['id'] in [item['record_id'] for item in dashboard['action_center']]
    assert dashboard['monthly'][0]['record_ids'] == [invoice['id']]
    with pytest.raises(BusinessError):
        business.dashboard(start='2026-11-01', end='2026-10-01')


def test_calendar_overlap_and_action_center_do_not_require_ai(business):
    today = date.today()
    overdue = business.create('tasks', {'title': 'Overdue', 'due_date': (today - timedelta(days=1)).isoformat()})
    business.create('tasks', {'title': 'Completed', 'due_date': (today - timedelta(days=1)).isoformat(), 'status': 'done'})
    event = business.create('events', {'title': 'Overnight', 'start': '2026-11-10T23:00:00+08:00', 'end': '2026-11-11T01:00:00+08:00', 'timezone': 'Asia/Hong_Kong'})
    business.update_settings({'ai_enabled': False})
    dashboard = business.dashboard()
    assert dashboard['counts']['overdue_tasks'] == 1
    assert dashboard['action_center'][0]['record_id'] == overdue['id']
    calendar = business.calendar('2026-11-11', '2026-11-11')
    assert event['id'] in [item['record_id'] for item in calendar]


def test_modules_and_ai_preferences_persist_without_deleting_data(business):
    client = business.create('clients', {'name': 'Keep this'})
    registry = business.configure_modules({'modules': [{'id': 'clients', 'enabled': False, 'order': 0, 'permissions': {'ai_read': False, 'ai_write': False}}]})
    assert next(item for item in registry['modules'] if item['id'] == 'clients')['order'] == 0
    business.update_settings({'ai_enabled': False, 'currency': 'HKD', 'dashboard_layout': ['clients', 'finances']})
    reopened = Business(Store(business.store.path))
    module = next(item for item in reopened.modules()['modules'] if item['id'] == 'clients')
    assert not module['enabled'] and not module['permissions']['ai_read']
    assert reopened.settings()['currency'] == 'HKD' and not reopened.settings()['ai_enabled']
    assert reopened.get('clients', client['id'])['name'] == 'Keep this'
    with pytest.raises(BusinessError):
        reopened.configure_modules({'modules': [{'id': 'overview', 'enabled': False}]})
    with pytest.raises(BusinessError):
        reopened.configure_modules({'modules': [{'id': 'automations', 'enabled': True}]})
    with pytest.raises(BusinessError):
        reopened.update_settings({'currency': 'XYZ'})


def test_optional_native_record_modules_are_usable(business):
    inputs = {'services': {'name': 'Editing', 'price': '50'}, 'portfolio': {'title': 'Showreel', 'url': 'https://example.com/reel'},
              'proposals': {'title': 'Draft', 'budget': '200'}, 'deliverables': {'title': 'Film', 'feedback': 'Please trim'},
              'opportunities': {'title': 'New brief', 'budget': '500'}}
    for kind, body in inputs.items():
        record = business.create(kind, body)
        assert business.get(kind, record['id']) == record
        assert business.list(kind)[0]['id'] == record['id']
    assert not next(item for item in business.modules()['modules'] if item['id'] == 'integrations')['permissions']['ai_write']


def test_partial_permission_change_cannot_reenable_an_existing_denial(business):
    business.configure_modules({'modules': [{'id': 'integrations', 'permissions': {'ai_read': False}}]})
    integration = next(item for item in business.modules()['modules'] if item['id'] == 'integrations')
    assert integration['permissions'] == {'ai_read': False, 'ai_write': False}
    business.configure_modules({'modules': [{'id': 'clients', 'permissions': {'ai_write': False}}]})
    business.configure_modules({'modules': [{'id': 'clients', 'permissions': {'ai_read': False}}]})
    clients = next(item for item in business.modules()['modules'] if item['id'] == 'clients')
    assert clients['permissions'] == {'ai_read': False, 'ai_write': False}


def test_archived_project_preserves_client_financial_history(business):
    client = business.create('clients', {'name': 'Acme'})
    project = business.create('projects', {'name': 'Last Film', 'client_id': client['id']})
    business.create('finances', {'title': 'Final payment', 'project_id': project['id'], 'amount': '500', 'status': 'paid'})
    business.archive('projects', project['id'], 1)
    result = business.dashboard(client_id=client['id'])
    assert result['totals_by_currency'][0]['revenue'] == '500'
    assert result['breakdowns']['clients'][0]['name'] == 'Acme'
    assert result['breakdowns']['projects'][0]['name'] == 'Last Film'
    assert result['counts']['projects'] == 0


def test_search_matches_record_values_without_matching_field_names(business):
    one = business.create('clients', {'name': 'One'})
    business.create('clients', {'name': 'Two'})
    assert [item['id'] for item in business.list('clients', query='One')] == [one['id']]
    assert business.list('clients', query='phone') == []


def test_update_and_archive_receipts_are_atomic_and_survive_restart(business):
    item = business.create('clients', {'name': 'Original'})
    changed = business.update('clients', item['id'], {'name': 'Updated'}, 1, actor='harness', request_id='update-once')
    reopened = Business(Store(business.store.path))
    assert reopened.update('clients', item['id'], {'name': 'Updated'}, 1, actor='harness', request_id='update-once') == changed
    assert len(reopened.activity()) == 2
    with pytest.raises(BusinessError) as conflict:
        reopened.update('clients', item['id'], {'name': 'Different'}, 1, actor='harness', request_id='update-once')
    assert conflict.value.status == 409
    archived = reopened.archive('clients', item['id'], 2, actor='harness', request_id='archive-once')
    assert reopened.archive('clients', item['id'], 2, actor='harness', request_id='archive-once') == archived
    assert len(reopened.activity()) == 3


def test_harness_mutations_check_latest_permissions_inside_transaction(business):
    item = business.create('clients', {'name': 'Keep'})
    business.configure_modules({'modules': [{'id': 'clients', 'permissions': {'ai_write': False}}]})
    before = len(business.activity())
    for operation in (
        lambda: business.create('clients', {'name': 'Denied'}, actor='harness'),
        lambda: business.update('clients', item['id'], {'name': 'Denied'}, 1, actor='harness'),
        lambda: business.archive('clients', item['id'], 1, actor='harness'),
    ):
        with pytest.raises(BusinessError) as denied:
            operation()
        assert denied.value.status == 403
    assert len(business.activity()) == before
    assert business.get('clients', item['id'])['version'] == 1
    # UI remains usable regardless of assistant permissions.
    assert business.update('clients', item['id'], {'name': 'Manual edit'}, 1)['name'] == 'Manual edit'


def test_conversion_denial_and_receipt_replay_cannot_bypass_revocation(business):
    lead = business.create('leads', {'name': 'Prospect'})
    business.configure_modules({'modules': [{'id': 'clients', 'permissions': {'ai_write': False}}]})
    with pytest.raises(BusinessError) as denied:
        business.convert_lead(lead['id'], actor='harness', request_id='denied-convert')
    assert denied.value.status == 403 and business.list('clients') == []
    item = business.create('clients', {'name': 'Manual'})
    business.configure_modules({'modules': [{'id': 'clients', 'permissions': {'ai_write': True}}]})
    business.update('clients', item['id'], {'name': 'Agent edit'}, 1, actor='harness', request_id='saved-update')
    business.update_settings({'ai_enabled': False})
    with pytest.raises(BusinessError) as denied:
        business.update('clients', item['id'], {'name': 'Agent edit'}, 1, actor='harness', request_id='saved-update')
    assert denied.value.status == 403


def test_canonical_registry_preserves_original_outputs_without_fake_library(business):
    modules = {item['id']: item for item in business.modules()['modules']}
    assert 'content-library' not in modules
    assert modules['outputs']['route'] == '#deliverables'
    assert modules['outputs']['permissions'] == {'ai_read': False, 'ai_write': False}

