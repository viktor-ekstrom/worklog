# WorkLog

A local work journal for meetings, conversations, decisions, achievements and contributions that you want to remember at review time.

## Run WorkLog

1. Install Node.js 20 or newer.
2. Download or clone this repository and open a terminal in its folder.
3. Run:

   ```bash
   npm start
   ```

4. Open **http://localhost:4173** in your browser.

Keep the terminal running while using WorkLog. Press **Ctrl+C** to stop it; your saved entries remain on disk. Run `npm start` again to reopen the app.

This is the only supported startup method. Do not double-click `index.html`: the app needs the local server to save data. No build or dependency installation is needed for normal use; the server uses Node's built-in modules. Development and testing dependencies are installed separately below.

The server listens on your computer's loopback interface only. There is no cloud account, remote database or folder-permission prompt.

## Your data

Add an entry immediately after opening the app. WorkLog automatically creates one JSON file per ISO week beneath `data/` in the repository folder:

```text
data/
  2026/
    2026-W40.json
  history/
    2026/
      2026-W40-<timestamp>.json
  backups/
    2026/
      2026-W40.json
  recovery/
    2026/
      2026-W40-<timestamp>.json
```

`history/` retains versions before replacement; `backups/` retains a previous valid version. Damaged files are preserved under `recovery/` when encountered during a write. Normal writes refuse to replace invalid existing files. The server validates weekly documents and writes via a temporary file followed by a rename.

The default `data/` directory is excluded from Git. Keep a separate backup of it, especially before replacing or deleting the application folder. History is not automatically pruned.

### Existing journals or another folder

Use **Settings → Import** to bring in existing weekly JSON files or a full WorkLog backup. Replacing existing weeks requires confirmation. **Settings → Export backup** downloads all readable weeks as one JSON file.

Alternatively, stop WorkLog and point it at your existing journal folder. For example, in Windows PowerShell:

```powershell
$env:WORKLOG_DATA_DIR = 'C:\Users\YourName\Documents\WorkLog Data'
npm start
```

The folder must contain year subfolders such as `2026/2026-W40.json`. The server prints the active data path at startup. This setting applies to that terminal session. `PORT` can also be set before startup if port 4173 is occupied.

## Features

- Meeting notes, work done, conversations, decisions, achievements and quick notes
- Daily, weekly and monthly views
- Weekly reflections and monthly highlights
- Search, people, topics and yearly analytics
- JSON import/export and light/dark themes
- Press **N** outside a form to add an entry

Weekly files are portable and versioned. See [the schema](schema/week.schema.json) and [example data](example-data/2026/2026-W40.json).

Moves between weeks save the destination first. If removal from the original week fails, check both weeks before retrying. Multi-week imports can partially complete if a write fails; the app reports how many weeks completed. Avoid editing files externally or running multiple servers against the same data folder while using WorkLog.

## Development and verification

Development uses the same `npm start` entry point. Install test dependencies and run:

```bash
npm ci
npm test
npx playwright install chromium
npm run test:browser
```

The unit suite covers schema validation, imports and storage logic. Browser tests launch the actual local server with a temporary data directory and exercise entry creation, editing, deletion, navigation, reflections, import/export, failure handling and stale edits. One failed API write is deliberately simulated to verify the UI preserves unsaved changes. Test data never uses your journal directory.

To capture all pages, monthly tabs and entry dialogs with synthetic data:

```bash
npm run screenshots
```

Browser screenshots and results are written to `test-results/`, or the directory specified by `TEST_OUTPUT`. CI runs the unit and browser suites.
