#!/usr/bin/env python3
"""Copy explicit native ranges locally; publish only hashed wrapper-link evidence."""
import argparse
import hashlib
import json
import os
import pathlib
import stat
import sys
import time

import timing
from exporter import identifier


LIMITS = {'scan_bytes': 256 * 1024 * 1024, 'scan_lines': 100000,
          'line_bytes': 4 * 1024 * 1024, 'output_bytes': 16 * 1024 * 1024}
SCOPE = 'wrapper-launch-first-receipt'


def digest(value):
    return hashlib.sha256(value).hexdigest()


def private_write(path, content):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(content)


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2, allow_nan=False) + '\n').encode()


def task_binding(index, *, expected_task=None):
    if expected_task is not None:
        identifier(expected_task)
    task = index.get('task_id')
    if task is None:
        return {'task_id': None, 'task_binding': 'unknown'}
    identifier(task)
    if expected_task is not None and task != expected_task:
        raise ValueError('native index task mismatch')
    return {'task_id': task, 'task_binding': 'explicit-index'}


def extract(index, output_dir, *, limits=None, expected_task=None):
    binding = task_binding(index, expected_task=expected_task)
    bounds = dict(LIMITS)
    for key, value in (limits or {}).items():
        if key not in bounds or type(value) is not int or not 0 < value <= bounds[key]:
            raise ValueError('invalid excerpt bounds')
        bounds[key] = value
    if index.get('format') not in ('codex', 'claude'):
        raise ValueError('unsupported native format')
    source = index.get('path')
    if not isinstance(source, str) or not source or len(source) > 4096:
        raise ValueError('invalid native source')
    links = index.get('links')
    if not isinstance(links, list) or not 1 <= len(links) <= 16:
        raise ValueError('invalid native links')
    ranges, call_ids = [], set()
    for link in links:
        if not isinstance(link, dict):
            raise ValueError('invalid native range')
        start, end, call = link.get('start'), link.get('end'), link.get('call_id')
        if (type(start) is not int or type(end) is not int or
                not 1 <= start <= end <= bounds['scan_lines'] or end - start >= 10000 or
                not isinstance(call, str) or not 0 < len(call) <= 4096 or call in call_ids):
            raise ValueError('invalid or conflicting native range')
        call_ids.add(call)
        ranges.append({'start': start, 'end': end, 'call_id': call})
    ranges.sort(key=lambda link: link['start'])
    if any(left['end'] >= right['start'] for left, right in zip(ranges, ranges[1:])):
        raise ValueError('overlapping native ranges')
    deadline = time.monotonic() + 30
    source_path = pathlib.Path(source)
    selected = [[] for _ in ranges]
    scanned = written = current = line_number = 0
    # One bounded source pass. Prefix lines are never copied, parsed or printed.
    descriptor = os.open(source_path, os.O_RDONLY | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError('native source must be a regular file')
        while line_number < ranges[-1]['end']:
            if time.monotonic() > deadline:
                raise ValueError('native scan deadline')
            line = stream.readline(bounds['line_bytes'] + 1)
            if not line:
                raise ValueError('truncated native range')
            line_number += 1
            scanned += len(line)
            if len(line) > bounds['line_bytes'] or scanned > bounds['scan_bytes']:
                raise ValueError('native scan limit')
            if line_number > ranges[current]['end']:
                current += 1
            if line_number >= ranges[current]['start']:
                written += len(line)
                if written > bounds['output_bytes']:
                    raise ValueError('native output limit')
                # JSONL framing is necessary for exact line provenance.
                if not line.endswith(b'\n'):
                    raise ValueError('incomplete native line')
                json.loads(line)
                selected[current].append(line)
    output = pathlib.Path(output_dir)
    # Existing directories are never reused or overwritten. Raw files remain local.
    output.mkdir(mode=0o700)
    source_ref = digest(str(source_path.resolve()).encode())
    manifest = {**binding, 'source_reference': source_ref, 'format': index['format'], 'links': []}
    summary = {**binding, 'source_reference': source_ref, 'format': index['format'],
               'linkage_scope': SCOPE, 'scanned_bytes': scanned,
               'scanned_lines': line_number, 'selected_bytes': written, 'links': [],
               'coverage_gaps': ['inner-process-spans-not-established', 'usage-unattributed']}
    for number, (link, lines) in enumerate(zip(ranges, selected)):
        if len(lines) != link['end'] - link['start'] + 1:
            raise ValueError('truncated native range')
        name = 'excerpt-' + str(number + 1) + '.jsonl'
        raw = b''.join(lines)
        private_write(output/name, raw)
        spec = {'path': str((output/name).resolve()), 'start': 1, 'end': len(lines),
                'call_id': link['call_id'], 'format': index['format']}
        joined = None
        try:
            joined = timing.join(spec)
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            pass
        safe = {'original_range': [link['start'], link['end']],
                'excerpt_range': [1, len(lines)], 'call_reference': digest(link['call_id'].encode()),
                'selected_bytes_sha256': digest(raw),
                'status': 'joined' if joined else 'join-unavailable', 'join': joined}
        summary['links'].append(safe)
        manifest['links'].append({**safe, 'excerpt_file': name, 'timing_spec': spec})
    private_write(output/'manifest.json', encoded(manifest))
    private_write(output/'summary.json', encoded(summary))
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--index', required=True)
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--task', help='Validate supplied task identity against this expected task; never infer it')
    args = parser.parse_args()
    try:
        descriptor = os.open(args.index, os.O_RDONLY | os.O_NONBLOCK)
        with os.fdopen(descriptor, 'rb') as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise ValueError('native index must be a regular file')
            raw = stream.read(65537)
        if len(raw) > 65536:
            raise ValueError('oversize native index')
        summary = extract(json.loads(raw), args.output_dir, expected_task=args.task)
        print(encoded(summary).decode(), end='')
        return 0
    except Exception:
        print('native excerpt failed; no raw payload emitted', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
