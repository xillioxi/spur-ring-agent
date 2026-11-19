"""PyInstaller console entry point for the Electron shell's private backend."""

from spur_ring.desktop_service import main


if __name__ == "__main__":
    raise SystemExit(main())
