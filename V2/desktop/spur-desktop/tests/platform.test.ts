import assert from 'node:assert/strict';
import { test } from 'node:test';
import { desktopEnvironment, serviceLaunch } from '../electron/platform';

test('macOS profile uses Application Support and a Command shortcut', () => {
  const value = desktopEnvironment('darwin', '/Users/kevin', '/Users/kevin/Library/Application Support', 'ignored-windows-path');
  assert.equal(value.dataRoot, '/Users/kevin/Library/Application Support/Spur/RingDesktop');
  assert.equal(value.shortcut, 'Cmd+Shift+Space');
  assert.equal(value.credentialStore, 'macOS Keychain');
});
test('Windows retains the existing profile and shortcut', () => {
  const value = desktopEnvironment('win32', 'C:\\Users\\Kevin', 'C:\\Roaming', 'C:\\Local');
  assert.equal(value.dataRoot, 'C:\\Local\\Spur\\RingDesktop');
  assert.equal(value.shortcut, 'Ctrl+Shift+Space');
});
test('Mac package launches its native helper app executable', () => {
  const value = serviceLaunch(true, '/Applications/Spur Desktop.app/Contents/Resources', '/unused', '/Users/a/Library/Application Support/Spur/RingDesktop', 'darwin', 'arm64');
  assert.equal(value.executable, '/Applications/Spur Desktop.app/Contents/Resources/ring-service/SpurRingService.app/Contents/MacOS/SpurRingService');
  assert.deepEqual(value.args, ['--data-dir', '/Users/a/Library/Application Support/Spur/RingDesktop']);
  assert.ok(!value.executable.endsWith('.exe'));
});
test('Mac development picks a matching architecture Python environment', () => {
  const value = serviceLaunch(false, '/unused', '/source/V2/desktop/spur-desktop', '/data', 'darwin', 'x64');
  assert.equal(value.executable, '/source/V2/desktop/spur-ring-windows/.venv-macos-x64/bin/python');
  assert.equal(value.args[0], '/source/V2/desktop/spur-ring-windows/service_launcher.py');
});
test('Windows package still launches its EXE sidecar', () => {
  const value = serviceLaunch(true, 'C:\\Spur\\resources', 'C:\\source', 'C:\\data', 'win32', 'x64');
  assert.equal(value.executable, 'C:\\Spur\\resources\\ring-service\\SpurRingService.exe');
});
test('development Python override is explicit and packaged paths ignore it', () => {
  assert.equal(serviceLaunch(false, '/r', '/a/app', '/d', 'darwin', 'arm64', '/custom/python').executable, '/custom/python');
  assert.notEqual(serviceLaunch(true, '/r', '/a/app', '/d', 'darwin', 'arm64', '/custom/python').executable, '/custom/python');
});
test('unsupported host platforms fail before launching a Windows executable', () => {
  assert.throws(() => serviceLaunch(true, '/r', '/a', '/d', 'linux'), /macOS and Windows/);
});
