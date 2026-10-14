# Gotham Frontend Command — Browser Edition

A no-backend, no-API browser edition adapted from the existing Gotham project. It keeps the dedication screen, dashboard, heuristic findings, severity filter, finding details, mission report, report export, and recent scan history stored locally in this browser.

## Run it

For the simplest test, open `index.html` in a modern browser. Folder selection uses the File System Access API in supported Chromium desktop browsers and may require a secure context (HTTPS or localhost). If folder selection is unavailable, use **Choose files** or the folder picker. On Android, select individual source files where supported; Android browsers generally cannot reliably grant recursive access to a whole project folder.

For local hosting, you can use VS Code Live Server or run `python -m http.server 8000` in this folder and open `http://localhost:8000`.

## Publish for a shareable link

Upload the contents of this folder to a static host such as GitHub Pages. No backend, API key, account system, or cloud source upload is included.

## Privacy and limitations

- Source file text is read locally by the browser and is not sent to a server by this app.
- Recent case history uses localStorage on the current browser/device. It does not sync between devices and may be cleared with browser data.
- Browser folder selection requires browser support and user permission. On mobile, use individual file selection where available.
- Python and C/C++ rules are lightweight pattern checks, not full parser/compiler analysis. No code is executed.
- All checks are heuristic. Findings may be false positives or miss defects. Review findings manually and use language-specific linters, compilers, and tests for deeper analysis.
- The project intentionally does not include a backend or AI API.
