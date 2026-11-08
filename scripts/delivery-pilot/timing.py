"""Optional exact native call join. Native event times are not process times."""
import hashlib
import json
import pathlib
import datetime


def valid_time(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
        return value if parsed.tzinfo else None
    except ValueError:
        return None


def join(spec):
    path = pathlib.Path(spec['path'])
    start, end, call = spec['start'], spec['end'], spec['call_id']
    if (type(start) is not int or type(end) is not int or
            not 1 <= start <= end or end - start >= 10000 or
            not isinstance(call, str) or not 0 < len(call) <= 4096):
        raise ValueError('invalid native linkage')
    if spec['format'] not in ('codex', 'claude'):
        raise ValueError('unsupported native format')
    selected, calls, results, size, scanned = [], [], [], 0, 0
    with path.open('rb') as stream:
        for index, line in enumerate(iter(lambda: stream.readline(4 * 1024 * 1024 + 1), b''), 1):
            if index > end:
                break
            scanned += len(line)
            if len(line) > 4 * 1024 * 1024 or scanned > 64 * 1024 * 1024:
                raise ValueError('native scan limit')
            if index < start:
                continue
            size += len(line)
            if len(line) > 4 * 1024 * 1024 or size > 16 * 1024 * 1024:
                raise ValueError('oversize native event')
            selected.append(line.rstrip(b'\r\n'))
            event = json.loads(line)
            stamp = valid_time(event.get('timestamp'))
            if spec['format'] == 'codex':
                payload = event.get('payload', {})
                if payload.get('call_id') != call:
                    continue
                kind = payload.get('type')
                if kind in ('function_call', 'custom_tool_call'):
                    calls.append(stamp)
                elif kind in ('function_call_output', 'custom_tool_call_output'):
                    results.append(stamp)
            else:
                content = event.get('message', {}).get('content', [])
                for item in content if isinstance(content, list) else []:
                    if not isinstance(item, dict):
                        continue
                    if item.get('type') == 'tool_use' and item.get('id') == call:
                        calls.append(stamp)
                    elif item.get('type') == 'tool_result' and item.get('tool_use_id') == call:
                        results.append(stamp)
    if len(selected) != end - start + 1 or len(calls) != 1 or len(results) != 1:
        raise ValueError('incomplete or ambiguous native linkage')
    if not calls[0] or not results[0]:
        raise ValueError('native timestamps unavailable')
    if datetime.datetime.fromisoformat(calls[0].replace('Z', '+00:00')) > datetime.datetime.fromisoformat(results[0].replace('Z', '+00:00')):
        raise ValueError('reversed native timestamps')
    digest = lambda value: hashlib.sha256(value).hexdigest()
    return {'basis': 'native-tool-events; not subprocess occurrence',
            'reference': digest(str(path.resolve()).encode()), 'range': [start, end],
            'sha256': digest(b'\n'.join(selected)), 'call_ref': digest(call.encode()),
            'call_emitted_at': calls[0], 'result_observed_at': results[0]}
