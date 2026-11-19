"""Entry point used both by Python and the packaged Windows executable."""

from spur_ring.app import main


if __name__ == "__main__":
    raise SystemExit(main())
