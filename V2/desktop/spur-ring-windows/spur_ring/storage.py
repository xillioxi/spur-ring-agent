"""Local desktop identity and recording library; no mobile data migration."""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import uuid


class DesktopStorage:
    def __init__(self, data_dir: Path):
        self.root = Path(data_dir).resolve()
        self.recordings = self.root / 'recordings'
        self.root.mkdir(parents=True, exist_ok=True)
        self.recordings.mkdir(exist_ok=True)
        config_path = self.root / 'desktop.json'
        if config_path.exists():
            if config_path.stat().st_size > 65536:
                raise ValueError('Desktop identity file is too large.')
            config = json.loads(config_path.read_text(encoding='utf-8'))
            if not isinstance(config, dict) or not re.fullmatch(r'[A-Fa-f0-9]{32}', str(config.get('app_id', ''))):
                raise ValueError('Desktop identity file is invalid. Preserve it for recovery before creating a new identity.')
            self.app_id = config['app_id']
        else:
            self.app_id = uuid.uuid4().hex.upper()
            temporary = config_path.with_suffix('.tmp')
            temporary.write_text(json.dumps({'schema': 1, 'app_id': self.app_id}, indent=2) + '\n', encoding='utf-8')
            os.replace(temporary, config_path)

    def list_recordings(self) -> list[dict]:
        files = []
        # Only complete, playable files created by the transfer layer appear here.
        for file in self.recordings.rglob('*.ogg'):
            if file.is_symlink() or not file.is_file():
                continue
            stat = file.stat()
            files.append({'name': file.name, 'path': str(file), 'size': stat.st_size,
                          'timestamp': stat.st_mtime})
        return sorted(files, key=lambda item: item['timestamp'], reverse=True)
