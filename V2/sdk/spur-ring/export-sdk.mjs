import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Explicit SDK assets only: never copy app data, node_modules, credentials or builds.
const here = path.dirname(fileURLToPath(import.meta.url));
const mobile = path.resolve(here, '../../appV2/app_mobile');
const bundle = path.join(here, 'bundle');
const manifestPath = path.join(bundle, 'manifest.json');
const androidLibs = [
  'aizo_be_lib_release_v2.1.0.aar',
  'aizo_sdk_release_v2.1.2.aar',
  'aizo_serversdk_release_v2_2.2.6.aar',
  'AliAgent-release-4.1.3.aar',
  'rtk-bbpro-core-1.6.1.jar',
  'rtk-core-1.6.9.jar',
  'rtk-dfu-3.12.32.jar',
];
const iosSources = [
  'YanqiangVoiceModule.h',
  'YanqiangVoiceModule.m',
  'YanqiangVoiceModuleSimulatorStub.m',
  'YanqiangVoiceOpusBridge.swift',
  'VoiceRecordingTranscoder.swift',
  'VoiceRecordingFileSelector.swift',
  'SpurRecordingPaths.h',
];
const androidSources = [
  'YanqiangVoiceModule.java',
  'YanqiangVoicePackage.kt',
  // Original ReactPackage also registers these modules; retain its dependencies.
  'PhoneAudioModule.java',
  'SpurFeedbackModule.kt',
  'SpurIdentityModule.kt',
];

function inside(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\')) {
    throw new Error(`Invalid bundle path: ${relative}`);
  }
  const target = path.resolve(root, relative);
  const delta = path.relative(root, target);
  if (!delta || delta === '..' || delta.startsWith(`..${path.sep}`) || path.isAbsolute(delta)) {
    throw new Error(`Path escapes root: ${relative}`);
  }
  return target;
}

async function exists(file) {
  try { await lstat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function rejectLinks(root, relative) {
  let current = root;
  for (const part of ['.', ...relative.split('/')]) {
    current = path.join(current, part);
    if (await exists(current) && (await lstat(current)).isSymbolicLink()) {
      throw new Error(`Symbolic links are not supported: ${current}`);
    }
  }
}

async function walk(root, prefix = '') {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Symbolic link in bundle: ${relative}`);
    if (entry.isDirectory()) files.push(...await walk(path.join(root, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Unsupported file: ${relative}`);
  }
  return files.sort();
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function extractionPlan() {
  const plan = [];
  const add = (source, destination) => plan.push({ source, path: destination });
  for (const name of androidLibs) add(`android/app/libs/${name}`, `vendor/android/${name}`);
  for (const name of ['RingSDK.xcframework', 'AB_FOTA.xcframework']) {
    await rejectLinks(mobile, `native-sdk/${name}`);
    for (const file of await walk(inside(mobile, `native-sdk/${name}`))) {
      add(`native-sdk/${name}/${file}`, `vendor/ios/${name}/${file}`);
    }
  }
  for (const name of iosSources) add(`native-sdk/ios/${name}`, `reference/ios/${name}`);
  for (const name of androidSources) {
    add(`android/app/src/main/java/com/suprring/yanqiang/${name}`, `reference/android/yanqiang/${name}`);
  }
  add('android/app/src/main/java/com/suprring/MainApplication.kt', 'reference/android/MainApplication.kt');
  add('android/app/src/main/AndroidManifest.xml', 'reference/android/AndroidManifest.xml');
  add('android/app/build.gradle', 'reference/android/app.build.gradle');
  add('android/build.gradle', 'reference/android/root.build.gradle');
  add('native-sdk/YanqiangRingSDK.podspec', 'reference/ios/YanqiangRingSDK.podspec');
  add('ios/Podfile', 'reference/ios/Podfile');
  for (const name of ['native.ts', 'types.ts', 'RingConnectionService.ts']) {
    add(`src/ring/${name}`, `reference/typescript/${name}`);
  }
  add('docs/SDK-MIGRATION.md', 'reference/SDK-MIGRATION.md');
  return plan.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

async function exportSdk() {
  await rejectLinks(here, 'bundle/manifest.json');
  const files = [];
  // Preflight every source and destination before writing anything. Refuse to
  // overwrite a previous snapshot if either it or its mobile source has changed.
  for (const entry of await extractionPlan()) {
    await rejectLinks(mobile, entry.source);
    const source = inside(mobile, entry.source);
    if (!(await lstat(source)).isFile()) throw new Error(`Not a source file: ${entry.source}`);
    const data = await readFile(source);
    const file = { ...entry, bytes: data.length, sha256: sha256(data) };
    await rejectLinks(bundle, entry.path);
    const destination = inside(bundle, entry.path);
    if (await exists(destination) && sha256(await readFile(destination)) !== file.sha256) {
      throw new Error(`Existing export differs: ${entry.path}. Preserve it before making a new extraction.`);
    }
    files.push(file);
  }
  if (await exists(bundle)) {
    const expected = new Set(['manifest.json', ...files.map(file => file.path)]);
    for (const file of await walk(bundle)) {
      if (!expected.has(file)) throw new Error(`Unexpected existing export file: ${file}`);
    }
  }
  const manifest = {
    schemaVersion: 1,
    family: 'AIZO / Yanqiang recording ring',
    kind: 'mobile-sdk-extraction',
    sourceRoot: 'V2/appV2/app_mobile',
    platforms: {
      android: 'Vendor AAR/JAR; Android runtime required',
      ios: 'arm64 iOS device; arm64 simulator stub',
      windows: 'No vendor Windows runtime or direct BLE adapter included',
      macos: 'No macOS framework slice included',
    },
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    files,
  };
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  if (await exists(manifestPath) && await readFile(manifestPath, 'utf8') !== serialized) {
    throw new Error('Existing manifest differs. Preserve this snapshot before making a new extraction.');
  }
  for (const file of files) {
    const destination = inside(bundle, file.path);
    await mkdir(path.dirname(destination), { recursive: true });
    if (!await exists(destination)) await copyFile(inside(mobile, file.source), destination);
  }
  if (!await exists(manifestPath)) await writeFile(manifestPath, serialized, { flag: 'wx' });
  await verify(false);
}

async function verify(checkSource) {
  await rejectLinks(here, 'bundle/manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) {
    throw new Error('Unsupported or empty manifest');
  }
  const seen = new Set();
  let totalBytes = 0;
  for (const file of manifest.files) {
    const destination = inside(bundle, file.path);
    if (seen.has(file.path) || file.path === 'manifest.json') throw new Error(`Duplicate/reserved path: ${file.path}`);
    seen.add(file.path);
    await rejectLinks(bundle, file.path);
    const data = await readFile(destination);
    if (data.length !== file.bytes || sha256(data) !== file.sha256) {
      throw new Error(`Export checksum mismatch: ${file.path}`);
    }
    totalBytes += data.length;
    if (checkSource) {
      await rejectLinks(mobile, file.source);
      const source = await readFile(inside(mobile, file.source));
      if (source.length !== file.bytes || sha256(source) !== file.sha256) {
        throw new Error(`Mobile source changed: ${file.source}`);
      }
    }
  }
  if (seen.size !== manifest.fileCount || totalBytes !== manifest.totalBytes) throw new Error('Manifest totals mismatch');
  for (const file of await walk(bundle)) {
    if (file !== 'manifest.json' && !seen.has(file)) throw new Error(`Unlisted bundle file: ${file}`);
  }
  console.log(`Verified ${seen.size} extracted files (${totalBytes} bytes)${checkSource ? ' against mobile sources' : ''}.`);
  console.log('Vendor runtimes: Android / iOS. Direct Windows ring connectivity requires a desktop vendor SDK or a protocol implementation.');
}

try {
  const args = process.argv.slice(2);
  if (args.length === 0) await exportSdk();
  else if (args.length === 1 && args[0] === '--verify') await verify(false);
  else if (args.length === 1 && args[0] === '--verify-source') await verify(true);
  else throw new Error('Usage: node export-sdk.mjs [--verify | --verify-source]');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
