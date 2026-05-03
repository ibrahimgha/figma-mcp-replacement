# Figma Browser Exporter

A local, visible-browser Figma exporter for Windows.

It opens a real Chrome, Edge, or Chromium window, lets you sign in normally, scans the visible Figma UI for designed screens, exports each screen screenshot, exports rendered assets when possible, and writes a prompt gallery HTML file that opens automatically when the run finishes.

By default, the exporter avoids Figma UI actions that can write to the file. It uses canvas screenshots and screenshot-derived assets, and it does not add export settings. It still has to navigate pages, select frames, zoom to selection, and toggle Figma's local UI visibility to capture screens.

This project intentionally avoids:

- Headless browser automation
- OAuth or personal access tokens
- Figma REST API calls
- Private network payload parsing
- Bot-detection bypasses

The tool is built for human-assisted runs on one machine. If Figma asks for sign-in, MFA, or a challenge, you handle it in the visible browser and then continue the CLI.

## Features

- Opens a Figma design URL in a visible browser.
- Uses a persistent local browser profile so sign-in can be reused.
- Pauses while you sign in and load the file.
- Can scroll the left Pages panel and scan every discovered page/section with `--all-left-sections`.
- Detects frame-like screens from Figma's visible Layers UI and Dev Mode "Ready for development" cards.
- Can detect small phone screens directly from a visible canvas board with `--canvas-board-screens`, useful when Dev Mode only lists a subset of the real board.
- In canvas-board mode, opens the file once in Dev Mode, merges Ready-for-development rows with canvas-detected screens, and pre-captures selected canvas screens immediately to avoid repeated per-screen URL refreshes.
- Uses feedback-learned filters to skip obvious non-screen rows such as cover/overview pages, labels, raw image frames, device mock frames, and generic numbered frames.
- Lets you review, add, or remove frames before exporting.
- Exports every selected frame into its own folder.
- For Dev Mode/view-only files, can hide the Figma UI, zoom to each selected frame, and crop the selected frame outline with `--screenshot-mode canvas`.
- Exports rendered assets as PNG/SVG through Figma's UI when possible.
- In canvas screenshot mode, derives standalone illustration/icon PNG assets from the screen screenshot when nested Figma asset export is unavailable.
- Blocks native Figma export-setting writes unless `--allow-figma-writes` is explicitly passed.
- Writes a `manifest.json` for every exported frame.
- Generates `prompts.html` with:
  - One prompt per screen, in export order
  - A screenshot preview for each prompt
  - Local screenshot, screen folder, and assets folder paths
  - Exported asset paths
  - A copy button for each prompt
  - A page title when one can be inferred
  - `Detect what that page is` when the title is generic or missing

## Requirements

- Windows
- Node.js 20 or newer
- npm
- Chrome, Edge, or Playwright Chromium
- Figma file access with export permissions

On this machine, use `npm.cmd` instead of `npm` because PowerShell blocks the `npm.ps1` shim.

## Install

```powershell
npm.cmd install
```

## Run

Recommended on Windows, especially for Figma URLs that include `&p=...` or `&m=...` query parameters:

```powershell
node --import tsx .\src\cli.ts "https://www.figma.com/design/FILE_KEY/File-Name?node-id=1-2&p=f&m=dev" --out .\exports --browser chrome --cooldown-ms 1500
```

The `npm.cmd run export -- ...` form works for simple URLs, but Windows command processing can split Figma URLs containing `&`.

```powershell
npm.cmd run export -- "https://www.figma.com/design/FILE_KEY/File-Name" --out .\exports --browser chrome --cooldown-ms 1500
```

Useful options:

```powershell
node --import tsx .\src\cli.ts "<figma-url>" --asset-mode manual
node --import tsx .\src\cli.ts "<figma-url>" --asset-mode none
node --import tsx .\src\cli.ts "<figma-url>" --browser edge --keep-browser-open
node --import tsx .\src\cli.ts "<figma-url>" --use-url-node --skip-ready-prompt --skip-frame-review --asset-mode none
node --import tsx .\src\cli.ts "<figma-url>" --screenshot-mode canvas --asset-mode auto
node --import tsx .\src\cli.ts "<figma-url>" --all-left-sections --screenshot-mode canvas --asset-mode auto
node --import tsx .\src\cli.ts "<figma-url>" --canvas-board-screens --screenshot-mode canvas --asset-mode auto --keep-browser-open
node --import tsx .\src\cli.ts "<figma-url>" --all-left-sections --left-section "Registration" --frame-name-match "Registration - light mode|OTP Error|failed"
node --import tsx .\src\cli.ts "<figma-url>" --allow-figma-writes --screenshot-mode native
```

## Workflow

1. Run the CLI with a Figma design URL.
2. A visible browser opens.
3. Sign in, solve any challenge, and wait for the design file to finish loading.
4. Press Enter in the terminal.
5. The tool scans the visible Figma UI for frame candidates and records their `node-id` by selecting them. With `--all-left-sections`, it first scrolls the left Pages panel, selects each discovered page/section, and scans frames on each one. With `--canvas-board-screens`, it detects phone-sized screen rectangles from the visible canvas board, clicks each detected screen to learn its real `node-id`, and pre-captures those screens while the correct selection is still active.
6. Review the frame list:
   - Press Enter to export.
   - Type `a` to add the current Figma selection.
   - Type `r 1,2` to remove frames by number.
   - Type `q` to cancel.
7. The tool exports each selected frame and writes a prompt report.
8. `prompts.html` opens automatically in the browser.

## Output

Each frame is exported into its own directory:

```text
exports/<file-slug>/<frame-slug>__<node-id>/screenshot.png
exports/<file-slug>/<frame-slug>__<node-id>/assets/
exports/<file-slug>/<frame-slug>__<node-id>/manifest.json
```

The run also creates:

```text
exports/<file-slug>/prompts.html
```

The prompt HTML page is intended for quick run verification and copy/paste handoff into another coding or design agent.

## Asset Behavior

Pure browser UI mode cannot guarantee original uploaded image bytes. This tool exports rendered assets by selecting image-like layers as PNG and vector-like layers as SVG through Figma's export UI.

For Dev Mode/view-only files, use `--screenshot-mode canvas --asset-mode auto`. The tool will save the selected screen crop, then derive standalone illustration/icon PNG assets from that screenshot. This catches common empty-state illustrations and icons even when Figma's native export panel is unavailable.

Native Figma export can add or adjust export settings in the file, so it is disabled by default. To allow that write-capable path, pass `--allow-figma-writes --screenshot-mode native`.

If automatic asset discovery is noisy, run with manual asset mode:

```powershell
npm.cmd run export -- "<figma-url>" --asset-mode manual
```

For each frame, select an asset in Figma and type `png` or `svg` in the terminal.

## Configuration

The first real export run creates:

```text
.figma-browser-export/config.json
```

Use this file to tune UI selectors and default timing if Figma changes its interface.

Generated runtime folders are ignored by Git:

```text
.figma-browser-export/
exports/
dist/
node_modules/
```

## Limitations

Figma's web UI is not a stable public automation API. This exporter uses visible UI heuristics and records failures in `manifest.json` instead of silently dropping them.

If Figma changes labels, buttons, or layer structure, update `.figma-browser-export/config.json` selectors or use manual review mode.

Export permissions still apply. If the file owner disables export/copy, the tool cannot bypass that.

## Development

Run tests:

```powershell
npm.cmd test
```

Run typecheck:

```powershell
npm.cmd run typecheck
```

Build:

```powershell
npm.cmd run build
```

Show CLI help:

```powershell
npm.cmd run export -- --help
```
