import { readFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const vendorDirectory = fileURLToPath(new URL('../vendor/psmux/', import.meta.url));
export const digest = data => createHash('sha256').update(data).digest('hex');

export function loadRecipe() {
  const recipe = JSON.parse(readFileSync(join(vendorDirectory, 'provenance.json'), 'utf8'));
  for (const entry of [recipe.patch, recipe.sourceManifest, recipe.license]) {
    if (entry.file !== entry.file.split(/[\\/]/).at(-1)) throw new Error('unsafe recipe filename');
    if (digest(readFileSync(join(vendorDirectory, entry.file))) !== entry.sha256) throw new Error(`recipe digest mismatch: ${entry.file}`);
  }
  return recipe;
}

export function sourceManifest(recipe = loadRecipe()) {
  return JSON.parse(readFileSync(join(vendorDirectory, recipe.sourceManifest.file), 'utf8')).files;
}

export function verifySource(directory, files = sourceManifest()) {
  const root = resolve(directory);
  if (lstatSync(root).isSymbolicLink() || realpathSync(root) !== root) throw new Error('source root must be physical');
  const expected = new Set();
  for (const item of files) {
    if (!item.path || item.path.includes('\\') || item.path.startsWith('/') || item.path.includes(':') || item.path.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('unsafe source path');
    if (expected.has(item.path)) throw new Error('duplicate source path');
    expected.add(item.path);
  }
  const actual = [];
  function walk(directory, prefix = '') {
    for (const name of readdirSync(directory)) {
      if (!prefix && name === '.git') continue;
      const path = join(directory, name);
      const relative = prefix + name;
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) throw new Error(`source symlink: ${relative}`);
      if (metadata.isDirectory()) walk(path, relative + '/');
      else if (metadata.isFile()) actual.push(relative);
      else throw new Error(`unsupported source type: ${relative}`);
    }
  }
  walk(root);
  if (actual.length !== expected.size || actual.some(path => !expected.has(path))) throw new Error('source path set mismatch');
  for (const item of files) {
    const data = readFileSync(join(root, item.path));
    if (data.length !== item.bytes || digest(data) !== item.sha256) throw new Error(`source mismatch: ${item.path}`);
  }
  return { files: actual.length, exactSource: true };
}

export function inspectBinary(file) {
  if (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile()) throw new Error('binary must be a regular file');
  const data = readFileSync(file);
  if (data.length < 64 || data.toString('ascii', 0, 2) !== 'MZ') throw new Error('not a PE executable');
  const offset = data.readUInt32LE(0x3c);
  if (offset < 64 || offset + 6 > data.length || data.toString('binary', offset, offset + 4) !== 'PE\0\0') throw new Error('invalid PE header');
  if (data.readUInt16LE(offset + 4) !== 0x8664) throw new Error('binary is not PE AMD64');
  return { bytes: data.length, sha256: digest(data), format: 'PE AMD64' };
}

export function verifyBinary(file, accepted, receipt, sourceManifestSHA256) {
  const binary = inspectBinary(file);
  const acceptedArtifactMatch = binary.bytes === accepted.bytes && binary.sha256 === accepted.sha256;
  if (receipt) {
    if (receipt.schema !== 1 || receipt.sourceManifestSHA256 !== sourceManifestSHA256) throw new Error('receipt source mismatch');
    if (receipt.binary?.bytes !== binary.bytes || receipt.binary?.sha256 !== binary.sha256) throw new Error('receipt binary mismatch');
  } else if (!acceptedArtifactMatch) throw new Error('accepted artifact digest mismatch; PE shape alone is insufficient');
  return { ...binary, identity: acceptedArtifactMatch ? 'accepted-artifact' : 'local-build-receipt', acceptedArtifactMatch,
    qualification: 'Identity/provenance only. A local receipt is unsigned bookkeeping, not independent source-build attestation or native OpenRig/QA acceptance.' };
}

export function main(args) {
  if (args.length < 2) throw new Error('Usage: node scripts/verify-windows-psmux.mjs --source DIR | --binary FILE [--receipt FILE]');
  const recipe = loadRecipe();
  if (args[0] === '--source' && args.length === 2) return verifySource(args[1]);
  if (args[0] === '--binary' && (args.length === 2 || (args.length === 4 && args[2] === '--receipt'))) {
    const receipt = args.length === 4 ? JSON.parse(readFileSync(args[3], 'utf8')) : undefined;
    return verifyBinary(args[1], recipe.acceptedArtifact, receipt, recipe.sourceManifest.sha256);
  }
  throw new Error('unsupported verification arguments');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
