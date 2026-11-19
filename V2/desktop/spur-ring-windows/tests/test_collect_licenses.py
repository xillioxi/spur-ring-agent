from pathlib import Path, PurePosixPath
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from collect_licenses import collect_licenses


class LicenseTests(unittest.TestCase):
    def test_mac_stdlib_python_license_and_pyobjc_notices_are_preserved(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            prefix, stdlib, packages = root / 'prefix', root / 'stdlib', root / 'site-packages'
            prefix.mkdir(); stdlib.mkdir(); packages.mkdir()
            (stdlib / 'LICENSE.txt').write_text('Python notice', encoding='utf-8')
            relatives = [PurePosixPath('framework.dist-info/licenses/LICENSE'),
                         PurePosixPath('framework.dist-info/licenses/vendor/LICENSE')]
            for index, relative in enumerate(relatives):
                path = packages.joinpath(*relative.parts)
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(f'PyObjC notice {index}', encoding='utf-8')
            distribution = SimpleNamespace(metadata={'Name': 'pyobjc-framework-CoreBluetooth'},
                files=relatives, locate_file=lambda relative: packages.joinpath(*relative.parts))
            output = root / 'SpurRingService.app' / 'Contents' / 'Resources'
            with patch('collect_licenses.sys.base_prefix', str(prefix)), \
                    patch('collect_licenses.sysconfig.get_path', return_value=str(stdlib)), \
                    patch('collect_licenses.metadata.distributions', return_value=[distribution]):
                self.assertEqual(collect_licenses(output), 3)
            notices = list((output / 'licenses').iterdir())
            self.assertEqual({path.read_text(encoding='utf-8') for path in notices},
                             {'Python notice', 'PyObjC notice 0', 'PyObjC notice 1'})


if __name__ == '__main__':
    unittest.main()
