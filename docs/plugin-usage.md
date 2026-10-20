# Plugin usage

How a plugin tells zeploy that it was used, so the admin app can show which
plugins the team uses most (**Usage** in the top bar). This file is the
contract between the plugins and zeploy; `docs/plugin-usage-prompt.md` turns
it into a prompt for adding usage to a plugin project.

## How it works

```
plugin  ──appends a line──▶  %LOCALAPPDATA%\zeploy\usage\<plugin>.jsonl
agent   ──every minute: daily totals per plugin──▶  admin app(s)
admin   ──keeps 180 days──▶  Usage: ranking per plugin, per role, per PC
```

The plugin only writes to a local file. The zeploy agent (0.8.0 or later)
renames the file, counts its lines into one row per day and plugin, sends
the rows to every admin computer that wants usage, and deletes the file once
one of them stored it. If usage is switched off under Settings, the agent
deletes the files instead.

## Helpers

Copy the helper for the plugin's platform from `examples/usage/` unchanged:

| Plugin | Helper | Create |
| --- | --- | --- |
| CEP panel (AE, Premiere, Illustrator, Animate) | `zeploy-usage.js`, loaded in the panel's HTML | `zeployUsageV1(id, version)` (the app is read from CSInterface) |
| After Effects or Illustrator script, host script of an AE, Premiere or Illustrator panel | `zeploy-usage.jsx`, `#include`d or pasted at the top | `zeployUsageV1(id, version, app)` |
| Animate JSFL command, host script of an Animate panel (it runs in Animate's JSFL engine) | `zeploy-usage.jsfl`, pasted at the top | `zeployUsageV1(id, version)` |
| Blender add-on or extension | `zeploy_usage.py`, a module in the add-on | `zeploy_usage.Usage(id, version)` |

Every helper offers `action(name, ms?)`, `error(name)` and `track(name, fn)`
(Python: `@usage.track(name)`); the CEP, ExtendScript and Python helpers also
`open()`, and the CEP one `trackAsync(name, fn)`.

The helpers are version 1 of the contract (`zeployUsageV1`). They never
throw, never show anything, never use the network, and write nothing on a PC
without zeploy (no `%LOCALAPPDATA%\zeploy` folder).

## What to count

- **`action`**: the user used a feature. This is what makes a plugin "used":
  the ranking counts uses and the PCs with at least one. Count each main
  feature (a button that does the work, an operator's `execute`, a script
  run) under a short, stable name: `export`, `align`, `remap`. Not hovers,
  not settings changes, not every redraw.
- **`open`**: the panel was opened or loaded. Informational: a docked CEP
  panel loads with the app whether used or not. Blender add-ons do not report
  it, because `register()` runs at every Blender start.
- **`error`**: a feature failed. Name the feature (or a short error kind),
  never the message: messages contain file paths and project names.

A plugin that reports only `open` is ranked by opens.

## The id

The plugin's own id, which zeploy already uses to match plugins to packages:

| Plugin | id |
| --- | --- |
| CEP panel | its `ExtensionBundleId` from `CSXS/manifest.xml`: `com.colosave.panel` |
| `.zxp` | the bundle id inside it |
| Blender extension | `id` from `blender_manifest.toml` |
| Blender legacy add-on | its module (folder) name: `remaper` |
| `.jsx`, `.jsxbin`, `.jsfl` | its file name: `Aegroup.jsx` |

The version is the plugin's own version (`ExtensionBundleVersion`,
`bl_info`/`version`, or the script's `@version`), so the admin sees which
versions are in use. An id zeploy has no package for still shows in Usage,
marked "not in zeploy".

## The line format (version 1)

One JSON object per line, UTF-8, `\n` after each:

```json
{"v":1,"t":"2026-10-20T09:12:03.120Z","plugin":"com.colosave.panel","ver":"1.4.0","app":"aftereffects","ev":"action","name":"export","ms":340}
```

| Field | Required | Value |
| --- | --- | --- |
| `v` | yes | `1` |
| `t` | yes | the time, ISO 8601 in UTC |
| `plugin` | yes | the id above, at most 120 characters |
| `ver` | no | the plugin's version, at most 32 characters |
| `app` | no | `aftereffects`, `premiere`, `illustrator`, `animate` or `blender` |
| `ev` | yes | `open`, `action` or `error` |
| `name` | for `action` and `error` | at most 40 characters of `A-Z a-z 0-9 . _ -` and space; others become `_` |
| `ms` | no | the feature's duration in milliseconds |

The file is `%LOCALAPPDATA%\zeploy\usage\<plugin>.jsonl`, with every
character of the id outside `A-Z a-z 0-9 . _ -` replaced by `_`. Writers
create `usage` if needed, write only when `%LOCALAPPDATA%\zeploy` exists, and
stop appending past 512 KB. The agent skips lines it cannot read, events
more than about a year off the PC's clock, and anything beyond these fields.

## What the admin sees

Per plugin, over 7, 30 or 90 days: on how many PCs it was used (of those
that have it installed), uses, opens, errors and when it was last used; per
plugin also its features with their average duration, uses per role, the PCs
using it most, and its versions. Stored per day and PC, kept 180 days, in
`usage.json` next to the admin app's `state.json`. No user names, times of
day, file names or project names are stored.

## Checking a plugin

1. On a PC with the zeploy agent, use the plugin.
2. `%LOCALAPPDATA%\zeploy\usage\<plugin>.jsonl` gets a line per event. It
   disappears within a minute once the agent (0.8.0) has sent it.
3. In the admin app, **Usage** lists the plugin.
