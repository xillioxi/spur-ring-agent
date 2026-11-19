"""A bounded JSON process protocol, never an HTTP server or arbitrary Python runner.

The database path is the sole command-line argument, selected by our Node host.
Request JSON cannot override storage, actor through args, or arbitrary methods.
"""
import json
import sqlite3
import sys
from pathlib import Path

MAX_INPUT_BYTES = 256 * 1024

OPERATIONS = {
    'modules': (set(), set()),
    'configure_modules': ({'value'}, set()),
    'settings': (set(), set()),
    'update_settings': ({'value'}, set()),
    'list': ({'kind'}, {'query', 'archived'}),
    'get': ({'kind', 'record_id'}, set()),
    'create': ({'kind', 'data'}, {'request_id'}),
    'update': ({'kind', 'record_id', 'data', 'version'}, {'request_id'}),
    'archive': ({'kind', 'record_id', 'version'}, {'request_id'}),
    'convert_lead': ({'record_id'}, {'request_id'}),
    'dashboard': (set(), {'start', 'end', 'client_id', 'project_id', 'currency'}),
    'calendar': (set(), {'start', 'end'}),
    'activity': (set(), {'limit'}),
    'export': (set(), set()),
    'schema': (set(), {'kind'}),
}


class ProtocolError(ValueError):
    def __init__(self, message, status=422):
        super().__init__(message)
        self.status = status


def validate_request(request):
    if not isinstance(request, dict) or set(request) - {'operation', 'args', 'actor'}:
        raise ProtocolError('Provide operation, args and actor only')
    operation = request.get('operation')
    if not isinstance(operation, str) or operation not in OPERATIONS:
        raise ProtocolError('Unknown business operation', 404)
    args = request.get('args', {})
    if not isinstance(args, dict):
        raise ProtocolError('Business arguments must be an object')
    required, optional = OPERATIONS[operation]
    if required - set(args):
        raise ProtocolError('Missing arguments: ' + ', '.join(sorted(required - set(args))))
    if set(args) - required - optional:
        raise ProtocolError('Unsupported business arguments: ' + ', '.join(sorted(set(args) - required - optional)))
    actor = request.get('actor', 'user')
    if not isinstance(actor, str) or not actor.strip() or len(actor) > 200:
        raise ProtocolError('A valid actor is required')
    for key in ('kind', 'record_id', 'query', 'start', 'end', 'client_id', 'project_id', 'currency'):
        if key in args and not isinstance(args[key], str):
            raise ProtocolError(key + ' must be a string')
    for key in ('data', 'value'):
        if key in args and not isinstance(args[key], dict):
            raise ProtocolError(key + ' must be an object')
    for key in ('version', 'limit'):
        if key in args and (not isinstance(args[key], int) or isinstance(args[key], bool)):
            raise ProtocolError(key + ' must be an integer')
    if 'archived' in args and not isinstance(args['archived'], bool):
        raise ProtocolError('archived must be a boolean')
    if 'request_id' in args and args['request_id'] is not None and not isinstance(args['request_id'], str):
        raise ProtocolError('request_id must be a string')
    return operation, args, actor.strip()


def execute(database_path, request):
    operation, args, actor = validate_request(request)
    if __package__:
        from .domain import Business, MODELS, KIND_MODULE
        from .store import Store
    else:
        # Isolated Python (-I) intentionally ignores cwd/PYTHONPATH. Import only
        # sibling modules from this fixed, application-owned script directory.
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from domain import Business, MODELS, KIND_MODULE
        from store import Store
    if operation == 'schema':
        if 'kind' in args:
            Business._kind(args['kind'])
            return {'kind': args['kind'], 'module': KIND_MODULE[args['kind']], 'schema': MODELS[args['kind']].model_json_schema()}
        return {'kinds': list(MODELS), 'schemas': {kind: model.model_json_schema() for kind, model in MODELS.items()}}
    service = Business(Store(database_path))
    if actor == 'harness':
        if operation in {'configure_modules', 'update_settings', 'settings', 'export'}:
            raise ProtocolError('This operation is not exposed to the Harness.', 403)
        if not service.settings().get('ai_enabled', True):
            raise ProtocolError('AI is disabled in workspace settings.', 403)
        if operation in {'list', 'get'}:
            service._kind(args['kind'])
            with service.store.connect() as db:
                service._require_harness_access(db, args['kind'], actor, write=False)
    if operation in {'create', 'update', 'archive', 'convert_lead'}:
        args = {**args, 'actor': actor}
    # The operation is already in the fixed public allowlist above. No arbitrary
    # user-controlled method name can reach getattr.
    return getattr(service, operation)(**args)


def main():
    try:
        if len(sys.argv) != 2 or not Path(sys.argv[1]).is_absolute():
            raise ProtocolError('The host must configure an absolute business database path', 503)
        raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        if len(raw) > MAX_INPUT_BYTES:
            raise ProtocolError('Business request exceeds the size limit', 413)
        try:
            def invalid_constant(_value):
                raise ValueError('Non-finite JSON number')
            request = json.loads(raw.decode('utf-8'), parse_constant=invalid_constant)
        except (ValueError, UnicodeError):
            raise ProtocolError('Business request must contain valid finite JSON')
        result = execute(sys.argv[1], request)
        response = {'ok': True, 'result': result}
    except (ModuleNotFoundError, ImportError):
        response = {'ok': False, 'status': 503, 'code': 'dependency_unavailable',
                    'error': 'Business storage needs Python with Pydantic 2. Install business/requirements.txt and configure SPUR_BUSINESS_PYTHON.'}
    except sqlite3.Error:
        response = {'ok': False, 'status': 503, 'code': 'storage_unavailable',
                    'error': 'Business storage is unavailable or busy. Check the existing record before retrying a write.'}
    except (ValueError, TypeError) as error:
        response = {'ok': False, 'status': getattr(error, 'status', 422), 'code': 'invalid_request', 'error': str(error)}
    except Exception:
        response = {'ok': False, 'status': 500, 'code': 'service_error',
                    'error': 'Business storage could not complete the request. Check the existing record before retrying a write.'}
    sys.stdout.buffer.write(json.dumps(response, ensure_ascii=False, allow_nan=False).encode('utf-8'))
    sys.stdout.buffer.flush()


if __name__ == '__main__':
    main()
