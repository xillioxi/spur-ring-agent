import { access, copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const documents = ['PROTOCOL_LIVE.md', 'PROTOCOL_AUTH.md', 'PROTOCOL_RECORDINGS.md', 'THIRD_PARTY.md'];

export async function findChromiumNotice(destination, platform, electronDist = path.join(project, 'node_modules/electron/dist')) {
  const candidates = [path.join(destination, 'LICENSES.chromium.html')];
  if (platform === 'darwin') {
    candidates.push(
      path.join(electronDist, 'Electron.app/Contents/Resources/LICENSES.chromium.html'),
      path.join(electronDist, 'Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/LICENSES.chromium.html'),
      path.resolve(destination, '../Frameworks/Electron Framework.framework/Versions/A/Resources/LICENSES.chromium.html'),
    );
  }
  candidates.push(path.join(electronDist, 'LICENSES.chromium.html'));
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile() && info.size > 0) return candidate;
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
  }
  throw new Error(`The Chromium license notice is missing or empty. Checked:\n${candidates.join('\n')}`);
}

async function collect(destination, platform) {
  const licenses = path.join(destination, 'licenses');
  await mkdir(licenses, { recursive: true });
  for (const name of ['react', 'react-dom', 'ws', 'electron']) {
    const directory = path.join(project, 'node_modules', name);
    for (const entry of await readdir(directory)) {
      if (/^(license|copying|copyright)(\.|$)/i.test(entry)) {
        await copyFile(path.join(directory, entry), path.join(licenses, `${name}-${entry}`));
      }
    }
  }
  // electron-builder moves the Mac ZIP's root notice into Contents/Resources
  // before afterPack. Prefer that actual packaged runtime over npm's dist copy.
  const chromium = await findChromiumNotice(destination, platform);
  await copyFile(chromium, path.join(licenses, 'Electron-LICENSES.chromium.html'));
  await copyFile(path.join(project, 'README.md'), path.join(destination, 'README.md'));
  for (const name of documents) {
    await copyFile(path.join(project, '../spur-ring-windows', name), path.join(destination, name));
  }
  const manifest = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8'));
  await writeFile(path.join(destination, 'runtime-versions.json'), JSON.stringify({
    app: manifest.version, runtime: manifest.dependencies, tooling: manifest.devDependencies,
  }, null, 2) + '\n');
}

/** Runs before signing and DMG generation, so signed bundles are never patched. */
export default async function afterPack(context) {
  if (context.electronPlatformName === 'darwin') {
    const bundle = `${context.packager.appInfo.productFilename}.app`;
    await collect(path.join(context.appOutDir, bundle, 'Contents/Resources'), 'darwin');
  } else if (context.electronPlatformName === 'win32') {
    await collect(context.appOutDir, 'win32');
  }
}

async function packagedDestinations() {
  const release = path.join(project, 'release');
  const result = [];
  let entries;
  try { entries = await readdir(release, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return result; throw error; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(release, entry.name);
    if (/^win(?:-[\w]+)?-unpacked$/.test(entry.name)) {
      result.push({ destination: directory, platform: 'win32' });
    } else if (/^mac(?:-(?:arm64|x64))?$/.test(entry.name)) {
      for (const app of await readdir(directory, { withFileTypes: true })) {
        if (app.isDirectory() && app.name.endsWith('.app')) {
          result.push({ destination: path.join(directory, app.name, 'Contents/Resources'), platform: 'darwin' });
        }
      }
    }
  }
  return result;
}

async function verify(destination) {
  for (const name of ['README.md', ...documents, 'runtime-versions.json', 'licenses/Electron-LICENSES.chromium.html']) {
    await access(path.join(destination, name));
  }
  const chromium = await stat(path.join(destination, 'licenses/Electron-LICENSES.chromium.html'));
  if (!chromium.isFile() || chromium.size === 0) throw new Error(`The Chromium license notice is empty in ${destination}`);
  for (const name of ['react', 'react-dom', 'ws', 'electron']) {
    const files = await readdir(path.join(destination, 'licenses'));
    if (!files.some(file => file.startsWith(`${name}-`))) throw new Error(`Missing ${name} license in ${destination}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--verify')) throw new Error('Usage: node scripts/collect-notices.mjs [--verify]');
  const destinations = await packagedDestinations();
  if (!destinations.length) throw new Error('No packaged Windows or macOS app found under release/.');
  for (const { destination, platform } of destinations) {
    // Preserve the existing Windows post-package command. macOS content was
    // included by afterPack; touching it after signing would break the signature.
    if (!args.includes('--verify') && platform === 'win32') await collect(destination, platform);
    await verify(destination);
    console.log(`Notices verified: ${destination}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
