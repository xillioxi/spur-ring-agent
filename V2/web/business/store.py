"""Small SQLite adapter; identity and database location are chosen by the Node host."""
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path


class Store:
    def __init__(self, path):
        self.path = str(Path(path).resolve())
        workspace = Path(self.path).parent
        workspace.mkdir(mode=0o700, parents=True, exist_ok=True)
        # Restrict only this selected workspace, never its shared ancestors.
        workspace.chmod(0o700)
        # SQLite sidecars inherit the database mode, so create it privately
        # before SQLite can create a WAL or shared-memory file.
        descriptor = os.open(self.path, os.O_CREAT | os.O_RDWR, 0o600)
        os.close(descriptor)
        self._protect_files()
        with self.connect() as db:
            db.execute('PRAGMA journal_mode=WAL')

    def _protect_files(self):
        for suffix in ('', '-wal', '-shm', '-journal'):
            try:
                Path(self.path + suffix).chmod(0o600)
            except FileNotFoundError:
                # SQLite removes sidecars when the last connection closes.
                if not suffix:
                    raise

    @contextmanager
    def connect(self):
        self._protect_files()
        db = sqlite3.connect(self.path, timeout=15)
        try:
            db.row_factory = sqlite3.Row
            db.execute('PRAGMA foreign_keys=ON')
            with db:
                yield db
        finally:
            try:
                self._protect_files()
            finally:
                db.close()
