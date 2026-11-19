"""Source-backed AIZO dictation controls; no microphone or network access."""
import unittest

from spur_ring.live_audio import dictation_capability, parse_touch_events


class RingControlTests(unittest.TestCase):
    def test_multiple_big_endian_touch_records(self):
        events = parse_touch_events(bytes.fromhex('81611A0B0C0F2C0901031A0B0C0F2C0A0106'))
        self.assertEqual([event.event for event in events], [259, 262])
        self.assertEqual([event.dictation_action for event in events], ['start', 'stop'])
        self.assertEqual(events[0].time_bytes.hex(), '1a0b0c0f2c09')

    def test_unknown_and_swipe_events_do_not_start_capture(self):
        for code in ('1103', '1106', 'FFFF', '0101', '0102'):
            event, = parse_touch_events(bytes.fromhex('81611A0B0C0F2C09' + code))
            self.assertIsNone(event.dictation_action)

    def test_incomplete_records_rejected_before_any_trigger(self):
        for raw in ('', '8161', '816100', '81611A0B0C0F2C09010300', '81621A0B0C0F2C090103'):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                parse_touch_events(bytes.fromhex(raw))

    def test_capability_names_host_microphone_as_live_source(self):
        capability = dictation_capability()
        self.assertTrue(capability['ring_triggered_dictation'])
        self.assertFalse(capability['ring_live_audio'])
        self.assertEqual(capability['audio_source'], 'computer_microphone')


if __name__ == '__main__':
    unittest.main()
