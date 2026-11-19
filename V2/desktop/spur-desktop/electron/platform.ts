import path from 'node:path';

export function desktopEnvironment(platform: string, home: string, appData: string, localAppData?: string) {
  const mac = platform === 'darwin';
  const paths = mac ? path.posix : path.win32;
  return {
    mac,
    dataRoot: mac ? paths.join(home, 'Library', 'Application Support', 'Spur', 'RingDesktop') : paths.join(localAppData || appData, 'Spur', 'RingDesktop'),
    shortcut: mac ? 'Cmd+Shift+Space' : 'Ctrl+Shift+Space',
    credentialStore: mac ? 'macOS Keychain' : 'Windows',
  };
}

export function serviceLaunch(packaged: boolean, resources: string, appRoot: string, dataDirectory: string,
  platform: string = process.platform, arch: string = process.arch, pythonOverride?: string) {
  if (!['darwin', 'win32'].includes(platform)) throw new Error('Spur Desktop supports macOS and Windows.');
  const paths = platform === 'darwin' ? path.posix : path.win32;
  const source = paths.resolve(appRoot, '../spur-ring-windows');
  const python = pythonOverride || (platform === 'darwin'
    ? paths.join(source, `.venv-macos-${arch}`, 'bin', 'python')
    : paths.resolve(appRoot, '../../..', '.build-tools/ring-windows-env/Scripts/python.exe'));
  const executable = packaged ? (platform === 'darwin'
    ? paths.join(resources, 'ring-service', 'SpurRingService.app', 'Contents', 'MacOS', 'SpurRingService')
    : paths.join(resources, 'ring-service', 'SpurRingService.exe')) : python;
  const args = packaged ? ['--data-dir', dataDirectory] : [paths.join(source, 'service_launcher.py'), '--data-dir', dataDirectory];
  return { executable, args };
}
