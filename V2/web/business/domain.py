"""Workspace-local creator business records and deterministic, auditable summaries.

All writes use the selected workspace Store, including audit and request receipts.
No operation in this module sends mail, charges a card, or writes to an integration.
"""
import hashlib
import json
import re
import time
import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator


SCHEMA = """
CREATE TABLE IF NOT EXISTS business_records (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL, document TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1, archived INTEGER NOT NULL DEFAULT 0,
 created REAL NOT NULL, updated REAL NOT NULL, created_by TEXT NOT NULL, updated_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS business_records_kind ON business_records(kind,archived,updated);
CREATE TABLE IF NOT EXISTS business_changes (
 id INTEGER PRIMARY KEY AUTOINCREMENT, record_id TEXT NOT NULL, kind TEXT NOT NULL,
 action TEXT NOT NULL, actor TEXT NOT NULL, details TEXT NOT NULL, created REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS business_requests (
 request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL, created REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS business_preferences (
 key TEXT PRIMARY KEY, value TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1
);
"""

# Active ISO 4217 codes; no implicit exchange-rate conversion is performed.
CURRENCIES = set(('AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BOV BRL BSD BTN BWP BYN BZD '
 'CAD CDF CHE CHF CHW CLF CLP CNY COP COU CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP '
 'GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT '
 'LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MXV MYR MZN NAD NGN NIO NOK NPR '
 'NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SLL SOS SRD SSP '
 'STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD USN UYI UYU UYW UZS VED VES VND VUV '
 'WST XAF XCD XCG XOF XPF YER ZAR ZMW ZWG').split())


class BusinessError(ValueError):
    def __init__(self, message, status=422):
        super().__init__(message)
        self.status = status


def valid_date(value):
    if value and (not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value) or date.fromisoformat(value).isoformat() != value):
        raise ValueError('Use a valid YYYY-MM-DD date')
    return value


def decimal_string(value, positive=False):
    if isinstance(value, bool):
        raise ValueError('Enter a decimal number')
    try:
        number = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        raise ValueError('Enter a decimal number')
    if not number.is_finite() or number < 0 or (positive and number == 0):
        raise ValueError('Amount must be positive and finite' if positive else 'Value must be nonnegative and finite')
    if number >= Decimal('1000000000000') or number.as_tuple().exponent < -6:
        raise ValueError('Use an amount below one trillion with at most six decimal places')
    return format(number, 'f')


class RecordInput(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)
    notes: str = Field(default='', max_length=20000)
    tags: list[str] = Field(default_factory=list, max_length=30)
    source: str = Field(default='manual', min_length=1, max_length=200)

    @field_validator('tags')
    @classmethod
    def valid_tags(cls, value):
        if any(not item.strip() or len(item) > 100 for item in value):
            raise ValueError('Tags must contain 1–100 characters')
        return list(dict.fromkeys(item.strip() for item in value))

    @field_validator('currency', check_fields=False)
    @classmethod
    def valid_currency(cls, value):
        if value not in CURRENCIES:
            raise ValueError('Choose a supported uppercase ISO 4217 currency code')
        return value

    @field_validator('due_date', 'follow_up_date', 'date', check_fields=False)
    @classmethod
    def dates(cls, value):
        return valid_date(value)

    @field_validator('budget', 'estimated_value', 'price', 'hours', 'estimated_hours', check_fields=False, mode='before')
    @classmethod
    def decimals(cls, value):
        return decimal_string(value)


class ClientInput(RecordInput):
    name: str = Field(min_length=1, max_length=300)
    company: str = Field(default='', max_length=300)
    email: str = Field(default='', max_length=320)
    phone: str = Field(default='', max_length=100)
    status: Literal['active', 'inactive'] = 'active'
    acquisition_source: str = Field(default='', max_length=300)
    follow_up_date: str = ''
    lead_id: str = Field(default='', max_length=100)


class LeadInput(RecordInput):
    name: str = Field(min_length=1, max_length=300)
    company: str = Field(default='', max_length=300)
    email: str = Field(default='', max_length=320)
    phone: str = Field(default='', max_length=100)
    status: Literal['new', 'contacted', 'qualified', 'proposal', 'won', 'lost'] = 'new'
    estimated_value: str = '0'
    currency: str = 'USD'
    requirements: str = Field(default='', max_length=20000)
    acquisition_source: str = Field(default='', max_length=300)
    follow_up_date: str = ''
    lost_reason: str = Field(default='', max_length=2000)
    client_id: str = Field(default='', max_length=100)


class ProjectInput(RecordInput):
    name: str = Field(min_length=1, max_length=300)
    client_id: str = Field(default='', max_length=100)
    status: Literal['planned', 'active', 'on_hold', 'completed', 'cancelled'] = 'planned'
    description: str = Field(default='', max_length=20000)
    scope: str = Field(default='', max_length=20000)
    due_date: str = ''
    budget: str = '0'
    currency: str = 'USD'
    hours: str = '0'
    service_category: str = Field(default='', max_length=200)


class TaskInput(RecordInput):
    title: str = Field(min_length=1, max_length=300)
    project_id: str = Field(default='', max_length=100)
    client_id: str = Field(default='', max_length=100)
    status: Literal['todo', 'in_progress', 'done'] = 'todo'
    due_date: str = ''
    estimated_hours: str = '0'
    hours: str = '0'


class FinanceInput(RecordInput):
    title: str = Field(min_length=1, max_length=300)
    type: Literal['income', 'expense'] = 'income'
    status: Literal['pending', 'paid', 'cancelled'] = 'pending'
    amount: str
    currency: str = 'USD'
    date: str = Field(default_factory=lambda: date.today().isoformat())
    due_date: str = ''
    client_id: str = Field(default='', max_length=100)
    project_id: str = Field(default='', max_length=100)
    category: str = Field(default='', max_length=200)
    invoice_number: str = Field(default='', max_length=200)

    @field_validator('amount', mode='before')
    @classmethod
    def amount_decimal(cls, value):
        return decimal_string(value, positive=True)

    @field_validator('date')
    @classmethod
    def date_required(cls, value):
        if not value:
            raise ValueError('A financial record needs a date')
        return value


class EventInput(RecordInput):
    title: str = Field(min_length=1, max_length=300)
    start: str
    end: str
    timezone: str = Field(default='UTC', min_length=1, max_length=100)
    client_id: str = Field(default='', max_length=100)
    project_id: str = Field(default='', max_length=100)

    @field_validator('start', 'end')
    @classmethod
    def aware_datetime(cls, value):
        try:
            parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        except ValueError:
            raise ValueError('Use an ISO date and time with a timezone offset')
        if parsed.tzinfo is None or parsed.utcoffset() is None:
            raise ValueError('Event times must include a timezone offset')
        return parsed.isoformat()

    @model_validator(mode='after')
    def end_after_start(self):
        if datetime.fromisoformat(self.end) <= datetime.fromisoformat(self.start):
            raise ValueError('Event end must be after its start')
        return self


class ServiceInput(RecordInput):
    name: str = Field(min_length=1, max_length=300)
    description: str = Field(default='', max_length=20000)
    price: str = '0'
    currency: str = 'USD'
    category: str = Field(default='', max_length=200)
    status: Literal['active', 'inactive'] = 'active'


class PortfolioInput(RecordInput):
    title: str = Field(min_length=1, max_length=300)
    description: str = Field(default='', max_length=20000)
    project_id: str = Field(default='', max_length=100)
    client_id: str = Field(default='', max_length=100)
    url: str = Field(default='', max_length=2048)
    status: Literal['draft', 'featured', 'published'] = 'draft'

    @field_validator('url')
    @classmethod
    def safe_link(cls, value):
        if value:
            from urllib.parse import urlsplit
            parsed = urlsplit(value)
            if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or any(ord(c) < 33 for c in value):
                raise ValueError('Use an HTTPS link without credentials')
        return value


class ProposalInput(RecordInput):
    title: str = Field(min_length=1, max_length=300)
    client_id: str = Field(default='', max_length=100)
    lead_id: str = Field(default='', max_length=100)
    project_id: str = Field(default='', max_length=100)
    status: Literal['draft', 'sent', 'accepted', 'rejected'] = 'draft'
    scope: str = Field(default='', max_length=30000)
    deliverables: str = Field(default='', max_length=20000)
    budget: str = '0'
    currency: str = 'USD'
    due_date: str = ''


class DeliverableInput(PortfolioInput):
    status: Literal['draft', 'review', 'changes_requested', 'approved', 'delivered'] = 'draft'
    due_date: str = ''
    feedback: str = Field(default='', max_length=20000)


class OpportunityInput(PortfolioInput):
    status: Literal['saved', 'applied', 'won', 'closed'] = 'saved'
    budget: str = '0'
    currency: str = 'USD'
    due_date: str = ''
    location: str = Field(default='', max_length=300)


MODELS = {'clients': ClientInput, 'leads': LeadInput, 'projects': ProjectInput, 'tasks': TaskInput,
          'finances': FinanceInput, 'events': EventInput, 'services': ServiceInput, 'portfolio': PortfolioInput,
          'proposals': ProposalInput, 'deliverables': DeliverableInput, 'opportunities': OpportunityInput}
KIND_MODULE = {'clients': 'clients', 'leads': 'leads', 'projects': 'projects', 'tasks': 'projects',
               'finances': 'finances', 'events': 'calendar', 'services': 'portfolio', 'portfolio': 'portfolio',
               'proposals': 'proposals', 'deliverables': 'delivery', 'opportunities': 'opportunities'}
MODULE_DEFINITIONS = [
    ('overview', 'Overview', 'Actual business totals and upcoming work', True, True),
    ('action-center', 'Action Center', 'Due dates and follow-ups derived from your records', True, True),
    ('leads', 'Leads', 'Prospects, follow-ups and client conversion', False, True),
    ('clients', 'Clients', 'Contacts and client relationships', False, True),
    ('projects', 'Projects', 'Projects, deadlines, tasks and recorded hours', False, True),
    ('calendar', 'Calendar', 'Manual meetings and business deadlines', False, True),
    ('finances', 'Finances', 'Recorded income, expenses and outstanding payments', False, True),
    ('analytics', 'Analytics', 'Record-based business metrics, separated by currency', False, True),
    ('portfolio', 'Portfolio & Services', 'Private portfolio references and service offerings', False, False),
    ('proposals', 'Proposals & Contracts', 'Proposal drafts, scope, pricing and manually recorded status', False, False),
    ('delivery', 'Collaboration & Delivery', 'Private deliverable links, feedback and approval records', False, False),
    ('opportunities', 'Opportunities', 'Manually saved opportunities and application tracking', False, False),
    ('automations', 'Automations', 'Business automation execution is not yet connected', False, False),
    ('outputs', 'Deliverables', 'Existing Agent task documents and generated results', False, True),
    ('integrations', 'Integrations', 'Existing connected account settings and read access', False, True),
    ('modules', 'Modules', 'Choose and arrange workspace modules', True, True),
    ('settings', 'Settings', 'Preferences, permissions and data export', True, True),
]


class WorkspaceSettings(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)
    ai_enabled: bool = True
    currency: str = 'USD'
    timezone: str = Field(default='UTC', min_length=1, max_length=100)
    profession: str = Field(default='', max_length=200)
    sidebar_collapsed: bool = False
    dashboard_layout: list[str] = Field(default_factory=lambda: ['finances', 'projects', 'clients', 'leads', 'activity'], max_length=30)

    @field_validator('currency')
    @classmethod
    def currency_code(cls, value):
        return RecordInput.valid_currency(value)

    @field_validator('dashboard_layout')
    @classmethod
    def layout(cls, value):
        if any(item not in {'finances', 'projects', 'clients', 'leads', 'activity', 'calendar', 'tasks'} for item in value):
            raise ValueError('Unknown dashboard widget')
        return list(dict.fromkeys(value))


class Permissions(BaseModel):
    model_config = ConfigDict(extra='forbid')
    ai_read: bool = True
    ai_write: bool = True


class ModulePatch(BaseModel):
    model_config = ConfigDict(extra='ignore')  # Registry entries may be round-tripped by the UI.
    id: str
    enabled: bool | None = None
    order: int | None = Field(default=None, ge=0, le=1000)
    permissions: Permissions | None = None
    settings: dict | None = None


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def _validate(model, value):
    try:
        return model.model_validate(value).model_dump(mode='json')
    except (ValidationError, ValueError, TypeError) as exc:
        if isinstance(exc, ValidationError):
            detail = '; '.join('.'.join(str(k) for k in error['loc']) + ': ' + error['msg'] for error in exc.errors())
        else:
            detail = str(exc)
        raise BusinessError(detail) from exc


class Business:
    def __init__(self, store):
        self.store = store
        with store.connect() as db:
            db.executescript(SCHEMA)

    @staticmethod
    def record(row):
        return {**json.loads(row['document']), **{key: row[key] for key in
                ('id', 'kind', 'version', 'archived', 'created', 'updated', 'created_by', 'updated_by')}}

    @staticmethod
    def _kind(kind):
        if kind not in MODELS:
            raise BusinessError('Unknown business record kind', 404)
        return kind

    @staticmethod
    def _actor(actor):
        if not isinstance(actor, str) or not actor.strip() or len(actor) > 200:
            raise BusinessError('A valid actor is required')
        return actor.strip()

    @staticmethod
    def _audit(db, record_id, kind, action, actor, details):
        db.execute('INSERT INTO business_changes(record_id,kind,action,actor,details,created) VALUES(?,?,?,?,?,?)',
                   (record_id, kind, action, actor, _json(details), time.time()))

    @staticmethod
    def _row(db, kind, record_id):
        row = db.execute('SELECT * FROM business_records WHERE kind=? AND id=?', (kind, record_id)).fetchone()
        if not row:
            raise BusinessError('Business record not found', 404)
        return row

    @staticmethod
    def _receipt(db, request_id, operation, payload):
        if request_id is None:
            return None, None
        if not isinstance(request_id, str) or not request_id.strip() or len(request_id) > 200:
            raise BusinessError('Request ID must contain 1–200 characters')
        fingerprint = hashlib.sha256(_json({'operation': operation, 'payload': payload}).encode()).hexdigest()
        previous = db.execute('SELECT * FROM business_requests WHERE request_id=?', (request_id,)).fetchone()
        if previous:
            if previous['fingerprint'] != fingerprint:
                raise BusinessError('Request ID already used for different data', 409)
            return fingerprint, json.loads(previous['result'])
        return fingerprint, None

    @staticmethod
    def _save_receipt(db, request_id, fingerprint, result):
        if request_id is not None:
            db.execute('INSERT INTO business_requests VALUES(?,?,?,?)', (request_id, fingerprint, _json(result), time.time()))

    def _references(self, db, kind, doc, old=None):
        for field, target in [('client_id', 'clients'), ('project_id', 'projects'), ('lead_id', 'leads')]:
            if not doc.get(field):
                continue
            row = self._row(db, target, doc[field])
            if row['archived'] and (not old or old.get(field) != doc[field]):
                raise BusinessError('Cannot link to an archived ' + target.rstrip('s'))
        if doc.get('project_id'):
            project = json.loads(self._row(db, 'projects', doc['project_id'])['document'])
            if doc.get('client_id') and project.get('client_id') and project['client_id'] != doc['client_id']:
                raise BusinessError('Client does not match the selected project')
        if kind == 'projects' and old and old.get('client_id') != doc.get('client_id'):
            # Keep explicit client links on dependent records coherent when reassociating a project.
            for row in db.execute('SELECT document FROM business_records WHERE archived=0 AND kind IN (?,?,?,?,?,?,?)',
                                  ('tasks', 'finances', 'events', 'proposals', 'deliverables', 'portfolio', 'opportunities')):
                dependent = json.loads(row['document'])
                if dependent.get('project_id') == old.get('id') and dependent.get('client_id') and dependent['client_id'] != doc['client_id']:
                    raise BusinessError('Update linked records before changing this project client', 409)

    def _require_harness_access(self, db, kind, actor, write=True):
        """Check grants under the same write lock as a Harness mutation."""
        if actor != 'harness':
            return
        settings, _ = self._preferences(db, 'settings', WorkspaceSettings().model_dump())
        if not settings.get('ai_enabled', True):
            raise BusinessError('AI is disabled in workspace settings.', 403)
        saved, _ = self._preferences(db, 'modules', {})
        module = next(item for item in self._module_registry(saved) if item['id'] == KIND_MODULE[kind])
        permission = module['permissions']
        if not module['available'] or not permission['ai_read'] or (write and not permission['ai_write']):
            raise BusinessError('The workspace has not granted this AI access.', 403)

    def list(self, kind, query='', archived=False):
        self._kind(kind)
        if len(query) > 500:
            raise BusinessError('Search is too long')
        with self.store.connect() as db:
            rows = [self.record(row) for row in db.execute(
                'SELECT * FROM business_records WHERE kind=? AND archived=? ORDER BY updated DESC,id', (kind, int(archived)))]
        needle = query.casefold().strip()
        def searchable(value):
            if isinstance(value, dict):
                return ' '.join(searchable(item) for item in value.values())
            if isinstance(value, list):
                return ' '.join(searchable(item) for item in value)
            return str(value)
        return [row for row in rows if not needle or needle in searchable(row).casefold()]

    def get(self, kind, record_id):
        self._kind(kind)
        with self.store.connect() as db:
            return self.record(self._row(db, kind, record_id))

    def create(self, kind, data, request_id=None, actor='user'):
        self._kind(kind); actor = self._actor(actor)
        doc = _validate(MODELS[kind], data)
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            self._require_harness_access(db, kind, actor)
            # Hash the supplied fields, not time-dependent defaults (e.g. an omitted financial date),
            # so replaying the same request tomorrow still returns its original receipt.
            fingerprint, previous = self._receipt(db, request_id, 'create:' + kind, data)
            if previous is not None:
                return previous
            self._references(db, kind, doc)
            record_id = uuid.uuid4().hex; now = time.time()
            db.execute('INSERT INTO business_records VALUES(?,?,?,1,0,?,?,?,?)',
                       (record_id, kind, _json(doc), now, now, actor, actor))
            self._audit(db, record_id, kind, 'created', actor, {'version': 1, 'source': doc['source']})
            result = self.record(self._row(db, kind, record_id))
            self._save_receipt(db, request_id, fingerprint, result)
            return result

    def update(self, kind, record_id, data, version, actor='user', request_id=None):
        self._kind(kind); actor = self._actor(actor)
        if not isinstance(data, dict):
            raise BusinessError('Record update must be an object')
        if not isinstance(version, int) or isinstance(version, bool) or version < 1:
            raise BusinessError('A positive integer version is required')
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            self._require_harness_access(db, kind, actor)
            fingerprint, previous = self._receipt(db, request_id, 'update:' + kind,
                                                   {'id': record_id, 'data': data, 'version': version})
            if previous is not None:
                return previous
            old = self.record(self._row(db, kind, record_id))
            if old['version'] != version:
                raise BusinessError('This record changed elsewhere. Reload before saving.', 409)
            current_doc = {key: old[key] for key in MODELS[kind].model_fields}
            doc = _validate(MODELS[kind], {**current_doc, **data})
            if kind == 'leads' and old.get('client_id') and (doc['client_id'] != old['client_id'] or doc['status'] != 'won'):
                raise BusinessError('A converted lead must retain its client and won status', 409)
            self._references(db, kind, doc, old)
            db.execute('UPDATE business_records SET document=?,version=version+1,updated=?,updated_by=? WHERE id=?',
                       (_json(doc), time.time(), actor, record_id))
            self._audit(db, record_id, kind, 'updated', actor,
                        {'version': version + 1, 'fields': [key for key in doc if doc[key] != current_doc[key]]})
            result = self.record(self._row(db, kind, record_id))
            self._save_receipt(db, request_id, fingerprint, result)
            return result

    def archive(self, kind, record_id, version, actor='user', request_id=None):
        self._kind(kind); actor = self._actor(actor)
        if not isinstance(version, int) or isinstance(version, bool) or version < 1:
            raise BusinessError('A positive integer version is required')
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            self._require_harness_access(db, kind, actor)
            fingerprint, previous = self._receipt(db, request_id, 'archive:' + kind,
                                                   {'id': record_id, 'version': version})
            if previous is not None:
                return previous
            row = self._row(db, kind, record_id)
            if row['version'] != version:
                raise BusinessError('This record changed elsewhere. Reload before archiving.', 409)
            if row['archived']:
                result = self.record(row)
                self._save_receipt(db, request_id, fingerprint, result)
                return result
            db.execute('UPDATE business_records SET archived=1,version=version+1,updated=?,updated_by=? WHERE id=?',
                       (time.time(), actor, record_id))
            self._audit(db, record_id, kind, 'archived', actor, {'version': version + 1})
            result = self.record(self._row(db, kind, record_id))
            self._save_receipt(db, request_id, fingerprint, result)
            return result

    def convert_lead(self, record_id, request_id=None, actor='user'):
        actor = self._actor(actor)
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            self._require_harness_access(db, 'leads', actor)
            self._require_harness_access(db, 'clients', actor)
            fingerprint, previous = self._receipt(db, request_id, 'convert_lead', {'id': record_id})
            if previous is not None:
                return previous
            row = self._row(db, 'leads', record_id); lead = self.record(row)
            if lead['archived']:
                raise BusinessError('Archived leads cannot be converted', 409)
            if lead['client_id']:
                result = {'lead': lead, 'client': self.record(self._row(db, 'clients', lead['client_id'])), 'already_converted': True}
            else:
                client_doc = _validate(ClientInput, {key: lead[key] for key in
                    ('name', 'company', 'email', 'phone', 'notes', 'tags', 'source', 'acquisition_source', 'follow_up_date')} | {'lead_id': record_id})
                client_id = uuid.uuid4().hex; now = time.time()
                db.execute('INSERT INTO business_records VALUES(?,?,?,1,0,?,?,?,?)',
                           (client_id, 'clients', _json(client_doc), now, now, actor, actor))
                lead_doc = {key: lead[key] for key in LeadInput.model_fields}
                lead_doc.update(client_id=client_id, status='won')
                db.execute('UPDATE business_records SET document=?,version=version+1,updated=?,updated_by=? WHERE id=?',
                           (_json(lead_doc), now, actor, record_id))
                self._audit(db, client_id, 'clients', 'created_from_lead', actor, {'lead_id': record_id, 'version': 1})
                self._audit(db, record_id, 'leads', 'converted', actor, {'client_id': client_id, 'version': lead['version'] + 1})
                result = {'lead': self.record(self._row(db, 'leads', record_id)),
                          'client': self.record(self._row(db, 'clients', client_id)), 'already_converted': False}
            self._save_receipt(db, request_id, fingerprint, result)
            return result

    @staticmethod
    def _preferences(db, key, default):
        row = db.execute('SELECT value,version FROM business_preferences WHERE key=?', (key,)).fetchone()
        return (json.loads(row['value']), row['version']) if row else (default, 1)

    def settings(self):
        with self.store.connect() as db:
            value, version = self._preferences(db, 'settings', WorkspaceSettings().model_dump())
            return {**WorkspaceSettings().model_dump(), **value, 'version': version}

    def update_settings(self, value):
        if not isinstance(value, dict):
            raise BusinessError('Settings must be an object')
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            old, version = self._preferences(db, 'settings', WorkspaceSettings().model_dump())
            if value.get('version', version) != version:
                raise BusinessError('Settings changed elsewhere. Reload before saving.', 409)
            doc = _validate(WorkspaceSettings, {**old, **{key: item for key, item in value.items() if key != 'version'}})
            db.execute('INSERT INTO business_preferences VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,version=excluded.version',
                       ('settings', _json(doc), version + 1))
            self._audit(db, 'settings', 'settings', 'updated', 'user', {'fields': list(value), 'version': version + 1})
            return {**doc, 'version': version + 1}

    @staticmethod
    def _module_registry(saved):
        result = []
        for order, (module_id, name, description, permanent, enabled) in enumerate(MODULE_DEFINITIONS):
            override = saved.get(module_id, {})
            available = module_id != 'automations'
            default_permissions = Permissions(ai_read=module_id != 'outputs', ai_write=module_id not in {'integrations', 'outputs'}).model_dump()
            result.append({'id': module_id, 'name': name, 'description': description, 'icon': module_id,
                'route': {'outputs': '#deliverables', 'integrations': '#apps'}.get(module_id, '#business/' + module_id), 'permanent': permanent, 'available': available,
                'enabled': True if permanent else (override.get('enabled', enabled) and available),
                'order': override.get('order', order), 'settings': override.get('settings', {}),
                'permissions': {**default_permissions, **override.get('permissions', {})},
                'dependencies': [], 'integration_requirements': [],
                'kinds': [kind for kind, module in KIND_MODULE.items() if module == module_id]})
        return sorted(result, key=lambda item: item['order'])

    def modules(self):
        with self.store.connect() as db:
            saved, version = self._preferences(db, 'modules', {})
        return {'modules': self._module_registry(saved), 'settings': self.settings(), 'version': version}

    def configure_modules(self, value):
        if not isinstance(value, dict) or not isinstance(value.get('modules'), list):
            raise BusinessError('Provide a modules array')
        if len(value['modules']) > len(MODULE_DEFINITIONS):
            raise BusinessError('Too many module settings')
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            saved, version = self._preferences(db, 'modules', {})
            if value.get('version', version) != version:
                raise BusinessError('Modules changed elsewhere. Reload before saving.', 409)
            registry = {module['id']: module for module in self._module_registry(saved)}
            seen = set()
            for patch in value['modules']:
                try:
                    patch = ModulePatch.model_validate(patch).model_dump(mode='json', exclude_unset=True)
                except (ValidationError, ValueError, TypeError) as exc:
                    raise BusinessError('Invalid module configuration: ' + str(exc)) from exc
                module_id = patch.pop('id')
                if module_id not in registry or module_id in seen:
                    raise BusinessError('Unknown or duplicate module identifier')
                seen.add(module_id)
                if registry[module_id]['permanent'] and patch.get('enabled') is False:
                    raise BusinessError('Permanent modules cannot be disabled')
                if not registry[module_id]['available'] and patch.get('enabled'):
                    raise BusinessError('This module is not available yet')
                try:
                    if len(_json(patch.get('settings'))) > 10000:
                        raise BusinessError('Module settings are too large')
                except (ValueError, TypeError):
                    raise BusinessError('Module settings must contain JSON values')
                if patch.get('permissions') is not None:
                    patch['permissions'] = {**registry[module_id]['permissions'], **patch['permissions']}
                saved[module_id] = {**saved.get(module_id, {}), **{key: item for key, item in patch.items() if item is not None}}
            db.execute('INSERT INTO business_preferences VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,version=excluded.version',
                       ('modules', _json(saved), version + 1))
            self._audit(db, 'modules', 'modules', 'configured', 'user', {'modules': sorted(seen), 'version': version + 1})
        return self.modules()

    def activity(self, limit=50):
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 500:
            raise BusinessError('Activity limit must be between 1 and 500')
        with self.store.connect() as db:
            return [{**dict(row), 'details': json.loads(row['details'])} for row in db.execute(
                'SELECT * FROM business_changes ORDER BY id DESC LIMIT ?', (limit,))]

    @staticmethod
    def _range(start, end):
        try:
            valid_date(start); valid_date(end)
        except (ValueError, TypeError):
            raise BusinessError('Use valid YYYY-MM-DD filters')
        if start and end and end < start:
            raise BusinessError('End date must not precede start date')

    def _snapshot(self):
        records = {kind: [] for kind in MODELS}
        with self.store.connect() as db:
            for row in db.execute('SELECT * FROM business_records WHERE archived=0 ORDER BY updated DESC,id'):
                records[row['kind']].append(self.record(row))
        return records

    @staticmethod
    def _effective_date(kind, item):
        if kind == 'finances':
            return item['date']
        if kind == 'events':
            return item['start'][:10]
        if item.get('due_date') or item.get('follow_up_date'):
            return item.get('due_date') or item['follow_up_date']
        return datetime.fromtimestamp(item['created'], timezone.utc).date().isoformat()

    @staticmethod
    def _action_center(records):
        today = date.today().isoformat(); horizon = (date.today() + timedelta(days=7)).isoformat()
        actions = []
        for kind, field in [('tasks', 'due_date'), ('projects', 'due_date'), ('leads', 'follow_up_date'), ('clients', 'follow_up_date'), ('finances', 'due_date')]:
            for item in records[kind]:
                if item.get('status') in {'done', 'completed', 'cancelled', 'won', 'lost', 'inactive'}:
                    continue
                if kind == 'finances' and (item['status'] != 'pending' or item['type'] != 'income'):
                    continue
                due = item.get(field, '')
                if not due or due > horizon:
                    continue
                actions.append({'id': kind + ':' + item['id'], 'kind': kind, 'record_id': item['id'],
                    'title': item.get('title', item.get('name', '')), 'due_date': due,
                    'severity': 'overdue' if due < today else ('due' if due == today else 'upcoming'), 'module': KIND_MODULE[kind]})
        return sorted(actions, key=lambda item: (item['due_date'], item['id']))

    def dashboard(self, start='', end='', client_id='', project_id='', currency=''):
        self._range(start, end)
        if currency and currency not in CURRENCIES:
            raise BusinessError('Choose a supported currency filter')
        all_records = self._snapshot()
        # Archived parents remain available for relation lookup and historical labels, while
        # archive removes the parent itself from live counts and schedules.
        with self.store.connect() as db:
            related = [self.record(row) for row in db.execute("SELECT * FROM business_records WHERE kind IN ('clients','projects')")]
        projects = {item['id']: item for item in related if item['kind'] == 'projects'}
        if client_id:
            self.get('clients', client_id)
        if project_id:
            project = self.get('projects', project_id)
            if client_id and project['client_id'] != client_id:
                raise BusinessError('Client and project filters do not match')
        def matches(kind, item):
            linked_project = projects.get(item.get('project_id'), {})
            linked_client = item.get('client_id') or linked_project.get('client_id', '')
            if client_id and (item['id'] if kind == 'clients' else linked_client) != client_id:
                return False
            if project_id:
                match_id = item['id'] if kind == 'projects' else item.get('project_id')
                if kind == 'clients':
                    if item['id'] != project['client_id']:
                        return False
                elif match_id != project_id:
                    return False
            day = self._effective_date(kind, item)
            return not ((start and day < start) or (end and day > end) or (currency and item.get('currency', currency) != currency))
        records = {kind: [item for item in items if matches(kind, item)] for kind, items in all_records.items()}
        totals = {}; monthly = {}; breakdowns = {'clients': {}, 'projects': {}, 'categories': {}}
        def bucket(code):
            if code not in totals:
                totals[code] = {'currency': code, **{key: Decimal(0) for key in ('revenue', 'expenses', 'net', 'outstanding', 'pipeline', 'pending_expenses')},
                                'record_ids': {key: [] for key in ('revenue', 'expenses', 'outstanding', 'pipeline', 'pending_expenses')}}
            return totals[code]
        names = {'clients': {item['id']: item['name'] for item in related if item['kind'] == 'clients'},
                 'projects': {item['id']: item['name'] for item in related if item['kind'] == 'projects'}}
        for item in records['finances']:
            if item['status'] == 'cancelled':
                continue
            target = bucket(item['currency']); amount = Decimal(item['amount'])
            metric = ('revenue' if item['type'] == 'income' else 'expenses') if item['status'] == 'paid' else ('outstanding' if item['type'] == 'income' else 'pending_expenses')
            target[metric] += amount; target['record_ids'][metric].append(item['id'])
            if item['status'] == 'paid':
                month_key = (item['date'][:7], item['currency'])
                month = monthly.setdefault(month_key, {'month': month_key[0], 'currency': month_key[1], 'revenue': Decimal(0), 'expenses': Decimal(0), 'record_ids': []})
                month[metric] += amount; month['record_ids'].append(item['id'])
                if metric == 'revenue':
                    linked_client = item['client_id'] or projects.get(item['project_id'], {}).get('client_id', '')
                    for group, identifier in [('clients', linked_client), ('projects', item['project_id']), ('categories', item['category'])]:
                        entry = breakdowns[group].setdefault((identifier, item['currency']), {'id': identifier, 'name': names.get(group, {}).get(identifier, identifier) or 'Unassigned',
                            'currency': item['currency'], 'revenue': Decimal(0), 'record_ids': []})
                        entry['revenue'] += amount; entry['record_ids'].append(item['id'])
        for item in records['leads']:
            if item['status'] not in {'won', 'lost'}:
                target = bucket(item['currency']); target['pipeline'] += Decimal(item['estimated_value']); target['record_ids']['pipeline'].append(item['id'])
        for target in totals.values():
            target['net'] = target['revenue'] - target['expenses']
        for month in monthly.values():
            month['net'] = month['revenue'] - month['expenses']
        def safe(value):
            if isinstance(value, Decimal):
                return format(value, 'f')
            if isinstance(value, dict):
                return {key: safe(item) for key, item in value.items()}
            if isinstance(value, list):
                return [safe(item) for item in value]
            return value
        actions = self._action_center(records)
        counts = {kind: len(records[kind]) for kind in ('clients', 'leads', 'projects', 'tasks', 'events')}
        counts.update(active_clients=sum(item['status'] == 'active' for item in records['clients']),
            active_leads=sum(item['status'] not in {'won', 'lost'} for item in records['leads']),
            active_projects=sum(item['status'] == 'active' for item in records['projects']),
            completed_tasks=sum(item['status'] == 'done' for item in records['tasks']),
            overdue_tasks=sum(item['kind'] == 'tasks' and item['severity'] == 'overdue' for item in actions))
        return safe({'filters': {'start': start, 'end': end, 'client_id': client_id, 'project_id': project_id, 'currency': currency},
            'counts': counts, 'totals_by_currency': [totals[key] for key in sorted(totals)],
            'monthly': [monthly[key] for key in sorted(monthly)],
            'breakdowns': {group: list(values.values()) for group, values in breakdowns.items()},
            'project_status': {status: sum(item['status'] == status for item in records['projects']) for status in ('planned', 'active', 'on_hold', 'completed', 'cancelled')},
            'lead_status': {status: sum(item['status'] == status for item in records['leads']) for status in ('new', 'contacted', 'qualified', 'proposal', 'won', 'lost')},
            'action_center': actions, 'records': records, 'source': 'workspace_records', 'generated_at': time.time(),
            'date_basis': 'Financial date; event start; project/task deadline or lead/client follow-up; otherwise creation date. Paid income and paid expenses only in actual earnings.'})

    def calendar(self, start='', end=''):
        self._range(start, end); records = self._snapshot(); entries = []
        for kind, items in records.items():
            for item in items:
                if kind == 'events':
                    event_start, event_end, all_day = item['start'], item['end'], False
                elif kind in {'projects', 'tasks', 'leads', 'clients', 'finances', 'deliverables'}:
                    if item.get('status') in {'done', 'completed', 'cancelled', 'won', 'lost', 'inactive', 'delivered'}:
                        continue
                    if kind == 'finances' and item['status'] != 'pending':
                        continue
                    event_start = item.get('due_date') or item.get('follow_up_date', '')
                    if not event_start:
                        continue
                    event_end, all_day = event_start, True
                else:
                    continue
                if (start and event_end[:10] < start) or (end and event_start[:10] > end):
                    continue
                entries.append({'id': kind + ':' + item['id'], 'kind': kind, 'record_id': item['id'],
                    'title': item.get('title', item.get('name', '')), 'start': event_start, 'end': event_end,
                    'all_day': all_day, 'client_id': item.get('client_id', ''), 'project_id': item.get('project_id', ''),
                    'timezone': item.get('timezone', ''), 'source': item['source'], 'version': item['version']})
        return sorted(entries, key=lambda item: (item['start'], item['id']))

    def export(self):
        with self.store.connect() as db:
            records = {kind: [] for kind in MODELS}
            for row in db.execute('SELECT * FROM business_records ORDER BY kind,created,id'):
                records[row['kind']].append(self.record(row))
        return {'schema_version': 1, 'exported_at': time.time(), 'records': records, 'modules': self.modules(), 'activity': self.activity(500)}
