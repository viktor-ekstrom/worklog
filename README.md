# WorkLog

A local-first professional work journal designed to complement Jira rather than mirror it.

WorkLog captures the things task systems are bad at preserving: meeting context, informal conversations, decisions, rationale, personal contributions, outcomes, achievements, and links back to Jira/PRs/docs.

## Core storage model

The data is the product. There is no backend and no database.

WorkLog asks you to select a local folder and then writes **one human-readable JSON file per ISO week**:

```text
worklog-data/
  2026/
    2026-W40.json
    2026-W41.json
  2027/
    2027-W01.json
```

The schema is versioned and documented in [`schema/week.schema.json`](schema/week.schema.json).

## Entry types

- Meeting — discussion, participants, your contribution, decisions, follow-ups, references
- Work done — summary, technical details, outcome, references
- Conversation — informal/1:1 context and notes
- Decision — decision, context, rationale, participants
- Achievement — accomplishment, impact, evidence
- Quick note — anything worth remembering

## Run locally

Requirements: Node.js 18+ and a Chromium-based desktop browser (Microsoft Edge or Google Chrome).

```bash
npm run dev
```

Then open:

```text
http://localhost:4173
```

There are no npm dependencies and no build step.

### Why localhost?

Direct local file access uses the browser's File System Access API, which requires a secure context. `localhost` qualifies; opening `index.html` directly from `file://` is not reliable.

## First run

1. Click **Connect folder**.
2. Pick or create a folder such as `worklog-data`.
3. Add an entry.
4. WorkLog creates the correct year directory and weekly JSON file automatically.

The selected directory handle is remembered in IndexedDB. The underlying journal data is never stored in IndexedDB and never sent over the network.

## Data portability

Because weekly JSON files are canonical, migration does not depend on WorkLog existing. The app also provides:

- import of weekly JSON files
- a combined backup export
- an explicit `schemaVersion`
- a JSON Schema for validation/tooling

## Example data

[`example-data/2026/2026-W40.json`](example-data/2026/2026-W40.json) demonstrates the structure used by the UI.

## Browser support

Direct folder read/write depends on the File System Access API. The intended environment is a Windows desktop using Edge or Chrome. Other browsers can render the UI, but direct folder access may be unavailable.

## Philosophy

Jira answers: **What work item exists and what is its status?**

WorkLog answers: **What happened, what did I contribute, what was decided, why, and what changed?**
