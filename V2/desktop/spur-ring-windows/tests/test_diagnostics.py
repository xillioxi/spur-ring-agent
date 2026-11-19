"""Host diagnostics are mocked and must not start a Mac central manager."""
from types import ModuleType, SimpleNamespace
import sys
import unittest
from unittest.mock import AsyncMock, Mock, patch

from spur_ring.transport import diagnose


class DiagnosticTests(unittest.IsolatedAsyncioTestCase):
    async def test_macos_authorization_is_read_without_initializing_bluetooth(self):
        for authorization, expected in ((0, 'not-determined'), (1, 'restricted'),
                                        (2, 'denied'), (3, 'allowed')):
            with self.subTest(authorization=authorization):
                module = ModuleType('CoreBluetooth')
                module.CBManager = SimpleNamespace(authorization=Mock(return_value=authorization))
                module.CBCentralManager = Mock(side_effect=AssertionError('Diagnostic must not request Bluetooth'))
                with patch.dict(sys.modules, {'CoreBluetooth': module}), \
                        patch('spur_ring.transport.platform.system', return_value='Darwin'), \
                        patch('spur_ring.transport.importlib.metadata.version', return_value='3.1.0'):
                    result = await diagnose()
                self.assertEqual(result['backend'], 'macOS CoreBluetooth via Bleak')
                self.assertEqual(result['bluetooth_authorization'], expected)
                self.assertEqual(result['radio_state'], 'not-checked')
                self.assertEqual(result['radios'], [])
                module.CBCentralManager.assert_not_called()
                module.CBManager.authorization.assert_called_once_with()
                if authorization in (1, 2):
                    self.assertIn('Privacy & Security → Bluetooth', result['error'])
                else:
                    self.assertNotIn('error', result)

    async def test_windows_radio_diagnostic_retains_winrt_behavior(self):
        radios = ModuleType('winrt.windows.devices.radios')
        radios.RadioKind = SimpleNamespace(BLUETOOTH=1)
        radios.Radio = SimpleNamespace(get_radios_async=AsyncMock(return_value=[
            SimpleNamespace(name='Bluetooth adapter', kind=1, state='On'),
            SimpleNamespace(name='Wi-Fi', kind=2, state='On'),
        ]))
        with patch.dict(sys.modules, {'winrt.windows.devices.radios': radios}), \
                patch('spur_ring.transport.platform.system', return_value='Windows'), \
                patch('spur_ring.transport.importlib.metadata.version', return_value='3.1.0'):
            result = await diagnose()
        self.assertEqual(result['backend'], 'Windows WinRT via Bleak')
        self.assertEqual(result['radios'], [{'name': 'Bluetooth adapter', 'kind': '1', 'state': 'On'}])
        self.assertNotIn('error', result)

    async def test_unsupported_platform_does_not_claim_windows_or_mac_backend(self):
        with patch('spur_ring.transport.platform.system', return_value='Linux'), \
                patch('spur_ring.transport.importlib.metadata.version', return_value='3.1.0'):
            result = await diagnose()
        self.assertEqual(result['backend'], 'unsupported')
        self.assertIn('Windows and macOS', result['error'])


if __name__ == '__main__':
    unittest.main()
