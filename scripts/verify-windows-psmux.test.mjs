import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifySource, verifyBinary } from './verify-windows-psmux.mjs';
import { main as setup } from './build-windows-psmux.mjs';

function temporary(t) {
  const root = mkdtempSync(join(tmpdir(), 'openrig-psmux-unit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const hash = data => createHash('sha256').update(data).digest('hex');
const sourceFiles = [{ path: 'Cargo.toml', bytes: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' }];

test('source verification accepts exact files and rejects altered or extra build inputs', t => {
  const root = temporary(t);
  writeFileSync(join(root, 'Cargo.toml'), 'abc');
  assert.equal(verifySource(root, sourceFiles).files, 1);
  writeFileSync(join(root, 'Cargo.toml'), 'abd');
  assert.throws(() => verifySource(root, sourceFiles), /source mismatch/);
  writeFileSync(join(root, 'Cargo.toml'), 'abc');
  mkdirSync(join(root, '.cargo'));
  writeFileSync(join(root, '.cargo', 'config.toml'), 'injected');
  assert.throws(() => verifySource(root, sourceFiles), /source path set/);
});

test('source verification refuses escaping and duplicate manifest entries', t => {
  const root = temporary(t);
  assert.throws(() => verifySource(root, [{ ...sourceFiles[0], path: '../Cargo.toml' }]), /unsafe source path/);
  assert.throws(() => verifySource(root, [...sourceFiles, ...sourceFiles]), /duplicate source path/);
});

function pe() {
  const data = Buffer.alloc(256);
  data.write('MZ');
  data.writeUInt32LE(128, 0x3c);
  data.write('PE\0\0', 128, 'binary');
  data.writeUInt16LE(0x8664, 132);
  return data;
}

test('PE shape alone cannot qualify a supplied binary', t => {
  const root = temporary(t);
  const file = join(root, 'psmux.exe');
  const data = pe();
  writeFileSync(file, data);
  const accepted = { bytes: data.length, sha256: hash(data) };
  assert.equal(verifyBinary(file, accepted).identity, 'accepted-artifact');
  assert.throws(() => verifyBinary(file, { ...accepted, sha256: '0'.repeat(64) }), /artifact digest/);
  data.writeUInt16LE(0x14c, 132);
  writeFileSync(file, data);
  assert.throws(() => verifyBinary(file, { bytes: data.length, sha256: hash(data) }), /AMD64/);
});

test('a local build receipt binds source and bytes but is not accepted-artifact attestation', t => {
  const root = temporary(t);
  const file = join(root, 'psmux.exe');
  const data = pe();
  writeFileSync(file, data);
  const accepted = { bytes: 999, sha256: '0'.repeat(64) };
  const source = '1'.repeat(64);
  const receipt = { schema: 1, sourceManifestSHA256: source, binary: { bytes: data.length, sha256: hash(data) } };
  const result = verifyBinary(file, accepted, receipt, source);
  assert.equal(result.identity, 'local-build-receipt');
  assert.equal(result.acceptedArtifactMatch, false);
  assert.throws(() => verifyBinary(file, accepted, receipt, '2'.repeat(64)), /receipt source/);
  data[255] = 1;
  writeFileSync(file, data);
  assert.throws(() => verifyBinary(file, accepted, receipt, source), /receipt binary/);
});

test('setup plan is inert and setup refuses existing destinations before source or binary effects', t => {
  const root = temporary(t);
  assert.equal(setup(['--plan']).upstream.commit, '20aa1d7254ee93f64dafa059ef89341d9767470a');
  assert.throws(() => setup(['--from-binary', join(root, 'missing.exe'), '--output-dir', root]), /already exists/);
  assert.throws(() => setup(['--prepare-only', '--source-dir', root]), /already exists/);
  assert.throws(() => setup(['--plan', '--fetch']), /requires --build/);
});
