"""Retain upstream notices in a Windows app directory or macOS Resources."""
from importlib import metadata
import hashlib
from pathlib import Path
import shutil
import sys
import sysconfig


PACKAGES = {
    'altgraph', 'bleak', 'macholib', 'packaging', 'pyinstaller',
    'pyinstaller-hooks-contrib', 'pywin32-ctypes', 'setuptools', 'typing-extensions',
}


def collect_licenses(output: Path) -> int:
    destination = output.resolve() / 'licenses'
    destination.mkdir(parents=True, exist_ok=True)
    base = Path(sys.base_prefix)
    # Windows installs at the prefix; macOS framework/Homebrew distributions
    # normally retain the notice beside the standard library instead.
    candidates = (
        base / 'LICENSE.txt', base / 'LICENSE',
        Path(sysconfig.get_path('stdlib')) / 'LICENSE.txt',
        base / 'Resources' / 'English.lproj' / 'Documentation' / 'LICENSE.txt',
    )
    python_license = next((source for source in candidates if source.is_file()), None)
    if python_license is None:
        raise RuntimeError('Python license notice was not found in the Python prefix or standard library. Use a complete Python installation for packaging.')
    shutil.copy2(python_license, destination / 'Python-LICENSE.txt')
    for name in ('tcl8.6', 'tk8.6'):
        for parent in (base / 'tcl', base / 'lib'):
            source = parent / name / 'license.terms'
            if source.is_file():
                shutil.copy2(source, destination / f'{name}-license.terms')
                break
    for distribution in metadata.distributions():
        package = distribution.metadata.get('Name', '')
        normalized = package.lower().replace('_', '-')
        if not (normalized.startswith(('winrt', 'pyobjc-')) or normalized in PACKAGES):
            continue
        for relative in distribution.files or ():
            if relative.name.lower().startswith(('license', 'copying', 'notice')):
                source = distribution.locate_file(relative)
                if source.is_file():
                    # Preserve same-named notices in different bundled packages.
                    digest = hashlib.sha256(str(relative).encode('utf-8')).hexdigest()[:10]
                    suffix = f'{relative.name}-{digest}'
                    shutil.copy2(source, destination / f'{package}-{suffix}')
    return len(list(destination.iterdir()))


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: python collect_licenses.py OUTPUT_DIRECTORY')
    print(f'Retained {collect_licenses(Path(sys.argv[1]))} upstream license notices.')
