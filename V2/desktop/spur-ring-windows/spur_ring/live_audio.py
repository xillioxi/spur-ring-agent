"""AIZO ring controls for host-microphone dictation.

The reference Android app's realtime dictation captures Android AudioRecord,
not a live PCM stream from this AIZO ring. This module only decodes the ring's
control notifications; it never opens a microphone or sends audio anywhere.
See PROTOCOL_LIVE.md for the source and hardware distinction.
"""
from __future__ import annotations

from dataclasses import dataclass


STATE_NAMES = {
    1: 'idle', 2: 'recording', 3: 'paused',
    4: 'recordings ready', 5: 'transferring',
}
TOUCH_ACTIONS = {
    0x0101: 'single_click', 0x1101: 'single_click',
    0x0102: 'double_click', 0x1102: 'double_click',
    0x0103: 'long_press', 0x0106: 'release_press',
    0x1103: 'volume_up', 0x1104: 'volume_down',
    0x1105: 'swipe_up', 0x1106: 'swipe_down',
    0x1107: 'swipe_left', 0x1108: 'swipe_right',
}


@dataclass(frozen=True)
class TouchEvent:
    time_bytes: bytes
    event: int

    @property
    def action(self) -> str:
        return TOUCH_ACTIONS.get(self.event, 'unknown')

    @property
    def dictation_action(self) -> str | None:
        return {'long_press': 'start', 'release_press': 'stop'}.get(self.action)


def parse_touch_events(payload: bytes) -> list[TouchEvent]:
    """Decode 8161 + repeated six-byte calendar/two-byte BE event records.

    An incomplete record is rejected before any event can trigger capture.
    Calendar bytes remain opaque: ring timezone and timestamp freshness do not
    authorize capture. Only the armed application decides whether to capture.
    """
    if not payload.startswith(b'\x81\x61') or len(payload) < 10 or (len(payload) - 2) % 8:
        raise ValueError('Malformed ring touch-event notification.')
    return [TouchEvent(payload[offset:offset + 6],
                       int.from_bytes(payload[offset + 6:offset + 8], 'big'))
            for offset in range(2, len(payload), 8)]


def dictation_capability() -> dict:
    return {
        'ring_triggered_dictation': True,
        'ring_live_audio': False,
        'audio_source': 'computer_microphone',
        'reason': 'The reference Android dictation uses the host microphone; this AIZO SDK exposes ring controls and saved recordings.',
    }
