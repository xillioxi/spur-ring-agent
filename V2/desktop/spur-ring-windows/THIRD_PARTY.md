# Runtime and protocol sources

The desktop service contains Python 3.11, Bleak, and PyInstaller runtime
components. Windows uses PyWinRT; macOS uses PyObjC and Apple's system
frameworks. The legacy Windows Tk application also uses Tcl/Tk. Upstream
license notices supplied by the installed distributions are retained in the
release's `licenses/` directory, inside the helper's Resources on macOS.

- Python: https://docs.python.org/3/license.html (PSF license)
- Tcl/Tk: https://www.tcl-lang.org/software/tcltk/license.html (Tcl/Tk license)
- Bleak: https://github.com/hbldh/bleak/blob/develop/LICENSE (MIT)
- PyWinRT: https://github.com/pywinrt/pywinrt (MIT)
- PyObjC: https://github.com/ronaldoussoren/pyobjc/blob/main/LICENSE.txt (MIT)
- PyInstaller: https://pyinstaller.org/en/stable/license.html (GPL with the
  runtime exception for generated application bundles)

The ring protocol was recovered for interoperability with the AIZO/Yanqiang
hardware already supported by the supplied mobile app. The original proprietary
AAR/JAR and Apple framework binaries, and the CFR/Capstone analysis tools, are
not desktop runtime dependencies and are not included in this desktop release.
The supplied SDK's original proprietary terms remain applicable to those
original SDK files; this port does not replace the manufacturer's terms.

Protocol evidence and original-binary test vectors are described in
`PROTOCOL_AUTH.md` and `PROTOCOL_RECORDINGS.md` in the desktop source directory.
