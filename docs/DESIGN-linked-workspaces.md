# Linked workspaces: a workspace kept as a folder of files

Status: **proposed** (2026-11-05). The owner chose option B from the gap analysis against the UX redesign canvas:
workspaces stay as they are, and any workspace can *optionally* be linked to a folder on disk. This replaces the
canvas's "Desk" (every workspace is always a folder).

## Goal

A team keeps a workspace in a git repo, reviews changes in pull requests, and runs it in CI with the same files.
One person can also use a folder simply as a readable, diffable copy of their own work.

Not goals: real-time collaboration, a server, syncing secrets, folders in the web build.

## Decisions

1. **"Workspace" keeps its name.** No "Desk".
2. **Linking is opt-in, per workspace, desktop only.** Unlinked workspaces and the web build work exactly as today.
3. **The app's own storage (IndexedDB) stays the working copy; the folder is a two-way mirror of it.** Undo, backups,
   tabs, history and the web build need no changes, and the app never edits a file it hasn't just read.
4. **Secrets never go into the folder.** Each device keeps its own values, as linked collections already do.
5. **Device-specific things stay on the device:** history, cookies, OAuth and MCP sign-ins, run results, backups,
   settings, and **schedules**. A schedule should not start running on a teammate's computer because they cloned a
   repo. Shared, must-run schedules belong in CI (phase 3).
6. **One file per item, written to merge well:** stable key order, ids kept, no timestamps, integer canvas positions.

## What's in the folder

```
payments/                          ← the linked folder (often a git repo)
  dispatch.workspace.yaml          ← workspace id, name, format version
  collections/
    payments-api/                  ← today's collection format, unchanged
      dispatch.collection.yaml
      charges/_folder.yaml
      charges/create-charge.req.yaml
  environments/
    staging.env.yaml               ← name, id, variables; secret values left empty
  flows/
    login-and-check-orders.flow.yaml
```

- **Collections** use the existing format (`src/core/fileFormat.ts`) as-is, so `dispatch-run` and today's linked
  collections keep working.
- **Environments:** `{ id, name, variables: [{ key, value, secret?, enabled? }] }`. A secret is written as
  `secret: true` with an empty value. On a device that has no value, the environment editor marks it
  "needs a value".
- **Flows:** `{ id, name, docs, nodes: [{ id, type, label, x, y, config }], edges: [{ id, from, port, to }] }`.
  Nodes and edges keep their creation order, so moving a block changes two numbers on one line. Request blocks
  refer to requests by id. A flow that points at a request outside the workspace keeps today's "doesn't point at a
  saved request" warning.
- **File names** come from item names (`slug()`); ids live inside the files. Renaming an item renames its file. Two
  files with the same id (for example, a copied file) are noticed on read and the copy gets a new id.
- **Not in the folder (for now):** globals (still device-wide), data files (the runner and flows pick them per run),
  and mock settings (mocks are built from saved examples, which are in the collection files).

## Using it

- **Workspaces page → "Link to a folder…"** on a workspace. If the folder is empty, Dispatch writes everything into
  it. If it already holds a workspace, Dispatch shows what each side has and asks which one wins. It never merges
  silently.
- **"Open a workspace folder…"** (Workspaces page and the top bar's workspace menu) adds a workspace from a folder,
  for example a repo a teammate shared. If this device already has a workspace with the same id, it is re-linked
  instead of duplicated.
- **Unlink** stops mirroring. The files stay where they are.
- **The workspace menu shows a linked workspace's path**, plus a status line: "In sync", "Updated from disk: 3
  requests", or "2 conflicts".
- **Collections that already have their own folder:** when their workspace is linked, Dispatch offers to move them
  under `collections/`. If you decline, they keep their own folder and aren't written into the workspace folder.
  A collection is never written to two places.

## Keeping the app and the folder in step

### App → folder

- Changes are written shortly after you make them, as linked collections are today.
- **Compare before write (new, and it also fixes linked collections):**
  - Dispatch remembers a hash of each file as it last read or wrote it.
  - The Rust writer replaces or deletes a file only if the file on disk still has that hash.
  - Otherwise the file changed outside the app (an editor, `git pull`). Dispatch skips it and reports it, and it
    becomes a conflict (see below).
  - Today a linked collection's next edit rewrites the whole folder and silently undoes a `git pull`. This closes that hole.
- Writes go through a temporary file plus a rename, so a crash never leaves a half-written file.

### Folder → app (phase 2)

- **Watching:**
  - A file watcher (the Rust `notify` crate) watches the folder, ignores `.git/`, and waits until changes stop
    for about half a second.
  - It ignores files whose content matches what Dispatch itself just wrote.
  - The whole folder is also re-checked when the app starts and when its window regains focus.
- **Changed files the app hasn't touched since:** applied straight away, with a toast like "Updated from disk:
  3 requests, 1 flow". A tab whose request changed on disk, and that has no unsaved edits, shows the new version.
- **Deleted files:** the item is removed and goes to the undo list.
- **Conflicts:** a file changed on disk *and* the same item changed in the app since the last sync. Dispatch keeps
  the app's version and the file as they are, and shows the conflict in the workspace menu with three choices:
  - "Use the file's version"
  - "Keep mine" (writes the app's version)
  - "Show differences" (uses the existing `diff.ts`)
- **Files that can't be read** (for example, git conflict markers `<<<<<<<`):
  - Dispatch shows "Can't read flows/x.flow.yaml, line 12" and leaves the item as it was in the app.
  - It doesn't write that file until it can be read again.

## Secrets

- The rule matches linked collections today:
  - Secret variable values and literal secrets in auth are never written.
  - Auth keeps only `{{variable}}` references.
  - On read, the blanks are filled from this device's encrypted store, matched by item id and key.
- **Saving a request with a literal secret** in a linked workspace shows the existing note: "Literal secrets in …
  weren't written to the files; move them into variables."
- **CI (phase 3):** `dispatch-run` takes secret values from environment variables named `DISPATCH_SECRET_<key>`, so
  a pipeline maps its own secret store onto them.

## The CLI (phase 3)

- `dispatch-run <workspace-folder>`, with:
  - `--collection <name>` (and an optional folder path) for a run
  - `--flow <name>` for a flow
  - `--env <name>` to pick an environment from `environments/`
- Bare collection folders and exported files keep working.
- `dispatch-run mcp <workspace-folder>` serves every collection and flow in the workspace.

## Phases

1. **Folder format and linking** (medium):
   - The workspace, environment and flow file formats, with round-trip tests.
   - Link, open and unlink.
   - Writing from the app to the folder, with the compare-before-write and temp-file safety. Linked collections get
     the same safety.
   - A "Reload from folder" button stands in for watching until phase 2.
2. **Watching and conflicts** (medium):
   - The watcher, re-checks on start and focus, automatic reload and toasts.
   - The conflict list with its three choices, and handling for files that can't be read.
3. **CLI and CI** (small):
   - `dispatch-run` on workspace folders, with `--env`, `--flow` and `DISPATCH_SECRET_*`.
   - Docs, and a section in the Windows test guide.

Each phase is its own PR and release.

**Tests:**
- Round trips for each format.
- "Changed on disk" cases in the Rust writer.
- A UI test for a conflict.
- A Linux check that a `git pull` into a linked folder while the app is open shows up in the app and nothing is lost.

## Questions for the owner

1. **Globals:** keep them device-wide (proposed for now), or give each linked workspace its own globals in
   `dispatch.workspace.yaml`?
2. **Schedules** stay on the device and out of the folder (proposed). Agree?
3. **Collections with their own folder:** offer to move them under the workspace folder when it's linked (proposed),
   or always leave them where they are?
