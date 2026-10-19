import { existsSync, mkdirSync, writeFileSync, copyFileSync, realpathSync, lstatSync } from 'node:fs';
import { resolve, join, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { devNull } from 'node:os';
import { loadRecipe, vendorDirectory, verifySource, verifyBinary, inspectBinary } from './verify-windows-psmux.mjs';

function options(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key in result) throw new Error(`duplicate option: ${key}`);
    if (['--plan', '--prepare-only', '--build', '--fetch'].includes(key)) result[key] = true;
    else if (['--source-dir', '--output-dir', '--upstream-local', '--from-binary', '--cargo-home'].includes(key) && args[i + 1] && !args[i + 1].startsWith('--')) result[key] = args[++i];
    else throw new Error(`unsupported or incomplete option: ${key}`);
  }
  return result;
}

function freshDirectory(path) {
  if (existsSync(path)) throw new Error(`destination already exists: ${path}`);
  // Also refuse dangling links and non-physical parents rather than replacing them.
  try { lstatSync(path); throw new Error(`destination already exists: ${path}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const parent = dirname(path);
  if (realpathSync(parent) !== parent) throw new Error('destination parent must be physical and already exist');
}

function run(command, args, cwd, env, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('build deadline reached');
  const result = spawnSync(command, args, { cwd, env, shell: false, encoding: 'utf8', timeout: remaining, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0 || result.error || result.signal) {
    throw new Error(`${command} failed (${result.error?.code ?? result.signal ?? result.status}). Output retained by caller; timeout does not prove descendant cleanup.\n${result.stderr ?? ''}`);
  }
  return result.stdout;
}

function inside(child, parent) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

export function main(args) {
  const opts = options(args);
  const recipe = loadRecipe();
  const modeCount = ['--plan', '--prepare-only', '--build', '--from-binary'].filter(key => opts[key]).length;
  if (modeCount !== 1) throw new Error('Choose exactly one: --plan, --prepare-only, --build, or --from-binary FILE');
  if (opts['--fetch'] && !opts['--build']) throw new Error('--fetch requires --build');
  if (opts['--cargo-home'] && !opts['--build']) throw new Error('--cargo-home requires --build');
  if (opts['--plan']) return { upstream: recipe.upstream, patch: recipe.patch, sourceManifest: recipe.sourceManifest,
    buildArgv: recipe.buildArgv, acceptedArtifact: recipe.acceptedArtifact,
    effects: 'None. Preparation clones the pinned source; --build additionally invokes Rust. --fetch explicitly allows Cargo dependency downloads. No global install or persistent PATH change.' };
  if (!opts['--output-dir'] && opts['--from-binary']) throw new Error('--from-binary requires a fresh --output-dir');
  if (opts['--from-binary'] && (opts['--source-dir'] || opts['--upstream-local'])) throw new Error('binary setup does not use source options');
  if (!opts['--from-binary'] && !opts['--source-dir']) throw new Error('source preparation requires a fresh --source-dir');
  if (opts['--build'] && !opts['--output-dir']) throw new Error('--build requires a fresh --output-dir');
  if (opts['--build'] && process.platform !== 'win32') throw new Error('--build requires native Windows in an MSVC developer shell');
  const source = opts['--source-dir'] && resolve(opts['--source-dir']);
  const output = opts['--output-dir'] && resolve(opts['--output-dir']);
  if (source) freshDirectory(source);
  if (output) freshDirectory(output);
  if (source && output && (inside(source, output) || inside(output, source))) throw new Error('source and output directories must be disjoint');
  if (opts['--from-binary']) {
    const result = verifyBinary(resolve(opts['--from-binary']), recipe.acceptedArtifact);
    mkdirSync(output, { mode: 0o700 });
    for (const name of ['psmux.exe', 'tmux.exe']) copyFileSync(resolve(opts['--from-binary']), join(output, name));
    for (const name of ['psmux.exe', 'tmux.exe']) verifyBinary(join(output, name), recipe.acceptedArtifact);
    copyFileSync(join(vendorDirectory, 'LICENSE'), join(output, 'LICENSE.psmux'));
    writeFileSync(join(output, 'artifact-receipt.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    return result;
  }
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: '0' };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && !['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_TERMINAL_PROMPT'].includes(key)) delete env[key];
  const deadline = Date.now() + 90 * 60 * 1000;
  const upstream = opts['--upstream-local'] ? resolve(opts['--upstream-local']) : recipe.upstream.repository;
  run('git', ['-c', 'credential.helper=', 'clone', '--no-hardlinks', '--no-checkout', '--config', 'core.autocrlf=false', '--', upstream, source], undefined, env, deadline);
  run('git', ['-C', source, 'checkout', '--detach', recipe.upstream.commit], undefined, env, deadline);
  const patch = join(vendorDirectory, recipe.patch.file);
  run('git', ['-C', source, 'apply', '--check', patch], undefined, env, deadline);
  run('git', ['-C', source, 'apply', patch], undefined, env, deadline);
  verifySource(source);
  if (opts['--prepare-only']) return { sourcePrepared: true, sourceManifestSHA256: recipe.sourceManifest.sha256, files: recipe.sourceManifest.files, nativeBuild: 'not run' };
  mkdirSync(output, { mode: 0o700 });
  const cargoHome = opts['--cargo-home'] ? resolve(opts['--cargo-home']) : join(output, 'cargo-home');
  if (opts['--cargo-home'] && (realpathSync(cargoHome) !== cargoHome || !lstatSync(cargoHome).isDirectory())) throw new Error('Cargo cache must be an existing physical directory');
  const cargoEnv = { ...env, CARGO_HOME: cargoHome, CARGO_TARGET_DIR: join(output, 'target'), CARGO_BUILD_JOBS: '1' };
  if (opts['--fetch']) run('rustup', ['run', recipe.toolchain, 'cargo', 'fetch', '--locked', '--target', recipe.target], source, cargoEnv, deadline);
  const rustc = run('rustup', ['run', recipe.toolchain, 'rustc', '--version'], source, cargoEnv, deadline).trim();
  run(recipe.buildArgv[0], recipe.buildArgv.slice(1), source, cargoEnv, deadline);
  verifySource(source);
  const built = join(cargoEnv.CARGO_TARGET_DIR, recipe.target, 'release', 'psmux.exe');
  const binary = inspectBinary(built);
  for (const name of ['psmux.exe', 'tmux.exe']) copyFileSync(built, join(output, name));
  const receipt = { schema: 1, sourceManifestSHA256: recipe.sourceManifest.sha256, upstream: recipe.upstream,
    patchSHA256: recipe.patch.sha256, binary, rustc, buildArgv: recipe.buildArgv,
    qualification: 'Unsigned local source/build bookkeeping. Not byte-reproducibility, native OpenRig, lifecycle, provider or QA acceptance.' };
  for (const name of ['psmux.exe', 'tmux.exe']) verifyBinary(join(output, name), recipe.acceptedArtifact, receipt, recipe.sourceManifest.sha256);
  copyFileSync(join(vendorDirectory, 'LICENSE'), join(output, 'LICENSE.psmux'));
  writeFileSync(join(output, 'build-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
