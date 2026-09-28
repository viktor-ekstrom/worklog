# WorkLog

A local-first professional work journal designed to complement Jira rather than mirror it.

WorkLog captures the things task systems are bad at preserving: meeting context, informal conversations, decisions, rationale, personal contributions, outcomes, achievements, and links back to Jira/PRs/docs.

## Core storage model

The data is the product. There is no backend, account, cloud service, or database.

WorkLog asks you to select a local folder and writes **one human-readable JSON file per ISO week**:

```text
worklog-data/
  2026/
    2026-W40.json
    2026-W41.json
  backups/
    2026/
      2026-W40.json
      2026-W41.json
  recovery/
    2026/
      2026-W40-2026-09-28T....corrupt.json
```

`backups/` is maintained automatically as a last-known-good recovery copy. `recovery/` is only used when WorkLog encounters damaged bytes and preserves them before repairing/restoring a canonical weekly file.

The schema is versioned and documented in [`schema/week.schema.json`](schema/week.schema.json).

## Entry types

- Meeting — discussion, participants, your contribution, decisions, follow-ups, references
- Work done — summary, technical details, outcome, references
- Conversation — informal/1:1 context and notes
- Decision — decision, context, rationale, participants
- Achievement — accomplishment, impact, evidence
- Quick note — anything worth remembering

## Use WorkLog

The normal end-user artifact is [`WorkLog.html`](WorkLog.html). It is a single self-contained file with the app's HTML, CSS and JavaScript embedded.

1. Download or copy `WorkLog.html` anywhere on your Windows PC.
2. Double-click it and open it in Microsoft Edge or Google Chrome.
3. Click **Connect folder** and choose the folder where your weekly JSON files should live.

No Node.js process or local web server is required for normal use. The browser still requires an explicit user gesture and permission before WorkLog can read or write the selected folder.

### Development

The repository keeps modular source files for maintainability. To run those directly during development:

```bash
npm run dev
```

Then open `http://localhost:4173`.

To regenerate the standalone artifact from the modular source:

```bash
npm run build:standalone
```

There are no npm dependencies.

## First run

1. Click **Connect folder**.
2. Pick or create a folder such as `worklog-data`.
3. Add an entry.
4. WorkLog creates the correct year directory and weekly JSON file automatically.

The selected directory handle is remembered in IndexedDB. The journal itself remains ordinary files in the folder you selected and is never sent over the network.

## Production safeguards

WorkLog v1 deliberately keeps the architecture small while protecting the journal data:

- strict runtime validation before data is trusted or written
- schema-version migrations for older files
- read-after-write verification
- automatic last-known-good recovery files
- self-recovery if a canonical weekly file becomes corrupt
- preservation of damaged bytes under `recovery/` before repair
- normal edits refuse to overwrite an already-invalid canonical file
- full backup export **and** full backup restore
- complete validation of imports/restores before the first file is changed
- automated tests for week boundaries, migrations, backup/restore and corruption recovery

Run the test suite with:

```bash
npm test
```

The same suite runs in GitHub Actions on pushes and pull requests.

## Data portability

Because weekly JSON files are canonical, migration does not depend on WorkLog existing. The app supports:

- import of individual weekly JSON files
- one-file full backup export
- one-file full backup restore
- an explicit `schemaVersion`
- automatic schema migrations
- a JSON Schema for external validation/tooling

The original MVP backup shape (`{ schemaVersion, exportedAt, weeks }`) remains restorable by v1.0.

## Example data

[`example-data/2026/2026-W40.json`](example-data/2026/2026-W40.json) demonstrates the structure used by the UI.

## Browser support

Direct folder read/write depends on the File System Access API. The intended environment is a Windows desktop using Edge or Chrome. Other browsers can render the UI, but direct folder access may be unavailable.

## Philosophy

Jira answers: **What work item exists and what is its status?**

WorkLog answers: **What happened, what did I contribute, what was decided, why, and what changed?**
