# zeploy

zeploy installs After Effects, Premiere Pro, Illustrator, Animate and Blender
plugins on the team's PCs over the LAN.

- The **admin app** runs on one PC (the admin PC). It keeps the plugin
  packages and shows which PC has which version.
- A small **agent** runs on every team PC. It receives install and remove
  jobs from the admin app, installs the plugin, and reports back.
- A **package** is one plugin as zeploy stores it. Add a CEP panel, `.zxp`,
  Blender add-on or script as it is and zeploy reads its name and version, or
  write a `zeploy.json` to combine several parts. zeploy works out where each
  part goes.

A visual walkthrough of the flow is in
[docs/zeploy-workflow.html](docs/zeploy-workflow.html) (in Indonesian; it
was drawn before the one-click installer and PC renaming were added).

**Contents:** [1. Set up the admin PC](#1-set-up-the-admin-pc) ·
[2. Connect team PCs](#2-connect-team-pcs) ·
[3. Make a package](#3-make-a-package) ·
[4. Install, update and remove plugins](#4-install-update-and-remove-plugins) ·
[5. Troubleshooting](#5-troubleshooting) · [6. Reference](#6-reference) ·
[7. Development](#7-development) · [Status and roadmap](#status-and-roadmap)

## 1. Set up the admin PC

Do this once, on the PC that will run the admin app.

### Requirements

- Windows 10 or 11
- Node.js 22.18 or newer
- Git, to get the code

### Get the code and install the dependencies

```bash
git clone <repository URL> zeploy
```

```bash
cd zeploy
```

```bash
npm install
```

```bash
npm run setup:electron
```

The code can live on a local disk or on the network share; both work.
`npm install` may skip Electron's download step, so `setup:electron` fetches
the Electron runtime. It does nothing if the runtime is already there.

### Build and start the admin app

Build the agent first: the admin app includes a copy of it to hand out to team
PCs.

```bash
npm run build:agent
```

```bash
npm run admin
```

`npm run admin` builds the app, copies it with the Electron runtime to
`%LOCALAPPDATA%\Programs\zeploy-admin\` and starts `zeploy-admin.exe` from
there. Electron cannot start from a network share such as `Z:`, which is why it
is copied to a local folder.

Next time, start `%LOCALAPPDATA%\Programs\zeploy-admin\zeploy-admin.exe`
directly, or pin it to the taskbar. After pulling new code, close the admin app
and run `npm run build` (agent and admin app, in that order), then start it
again.

The admin app must be open while you deploy. Agents reconnect on their own
whenever it starts.

Without Electron, `npm run server` starts the same admin server. Open
`http://127.0.0.1:7420/` in a browser on the admin PC. Both use the same data,
so they show the same packages and PCs. Run only one of them at a time.

### Open the network for agents

Agents connect to the admin PC on TCP port 7420. Two Windows settings decide
whether they can:

- **The network profile.** Windows blocks incoming connections on networks
  marked Public. The office LAN should be marked Private.
- **Windows Firewall.** If you dismissed or cancelled the firewall prompt the
  first time the admin app started, Windows created rules that block it.
  Block rules always win over allow rules.

Open PowerShell with "Run as administrator" on the admin PC and run these.

1. Remove any rules that block the admin app:

   ```bash
   Get-NetFirewallApplicationFilter | Where-Object Program -ieq "$env:LOCALAPPDATA\Programs\zeploy-admin\zeploy-admin.exe" | Get-NetFirewallRule | Remove-NetFirewallRule
   ```

2. Allow port 7420 on Private networks:

   ```bash
   New-NetFirewallRule -DisplayName "zeploy admin (agent LAN)" -Direction Inbound -Protocol TCP -LocalPort 7420 -Action Allow -Profile Private
   ```

3. Mark the office LAN as Private. Replace `Ethernet 2` with the adapter name
   that `Get-NetConnectionProfile` lists for the LAN:

   ```bash
   Set-NetConnectionProfile -InterfaceAlias "Ethernet 2" -NetworkCategory Private
   ```

   Do this only for a network you trust. If you cannot mark it Private, use
   `-Profile Private,Public` in step 2 instead, which opens the port on public
   networks too.

To check: on any team PC, open `http://192.168.1.72:7420/health` in a browser
(use the admin PC's address). It should show `{"ok":true,"protocol":1}`. The
admin app shows its address at the top of the window, next to "Server".

## 2. Connect team PCs

The agent is `zeploy-agent.exe`, a single 88 MB file with Node inside, so
team PCs need no Node install. One installer serves every PC: it holds the
admin PC's address and the team token, and each PC creates its own id the
first time it runs. Running it again on the same PC reinstalls the same agent.

### Install the agent with the one-click installer

1. On the admin PC, click **Connect a PC**. Under "With the installer", enter
   or choose a folder the team PCs can open, such as `W:\00 - ZEUSPACK`, and
   click **Save installer**. The folder gets two files:
   `Install zeploy agent.cmd` and `zeploy-agent.exe`.
   If the admin PC has more than one network address, first pick the one the
   team PCs can reach.
2. On the team PC, sign in as the person who uses it. That account must be a
   local administrator.
3. Open the folder and double-click `Install zeploy agent.cmd`. Choose
   **Yes** when Windows asks whether zeploy agent may make changes.
4. A second window runs the setup and says
   `The zeploy agent is installed and running.` Within a few seconds, the PC
   appears in the admin app with a green dot and the apps it found.

The installer works when opened from a network share or a mapped drive: it
copies itself and the agent to `%TEMP%` before asking for administrator
rights, because an elevated window cannot see mapped drives. It removes that
copy afterwards.

It stops with a message, and changes nothing, when:

- the signed-in account is not a local administrator,
- `zeploy-agent.exe` is not next to it,
- you choose **No** in the Windows prompt.

If setup itself fails, the second window shows why and waits for you to close
it; see [Errors from setup](#errors-from-setup).

**The installer contains the team token.** Anyone who can run it can connect a
PC to your admin app. Save it only where the team can open it, and delete it
once the PCs are set up. Save it again whenever you need it.

### Install the agent with a command

The same setup, typed by hand:

1. Sign in on the team PC as the person who uses it (a local administrator).
2. Copy `zeploy-agent.exe` to a local folder, such as Downloads. Do not run
   it from `Z:` or another mapped drive: an administrator terminal cannot see
   mapped drives.
3. On the admin PC, click **Connect a PC**, open "Set up with a command
   instead", then click **Copy command**. Get that text to the team PC.
4. On the team PC, open PowerShell with "Run as administrator", go to the
   folder and paste the command:

   ```bash
   cd $env:USERPROFILE\Downloads
   ```

   ```bash
   .\zeploy-agent.exe setup --server 192.168.1.72:7420 --token <team token>
   ```

5. It prints the installed path and ends with `it is running now.`

If Windows asks for another administrator's password, stop. The agent would be
set up for that account instead of the person using the PC. Make the PC's user
a local administrator first.

### What setup does

- Copies the exe to `C:\Program Files\zeploy\zeploy-agent.exe`.
- Saves the server address, team token and a PC id in
  `C:\ProgramData\zeploy\agent.json`.
- Registers a Scheduled Task named "zeploy agent". It starts the agent hidden,
  with highest privileges, every time that user signs in. If the agent stops
  with an error, the task restarts it up to three times, one minute apart.
- Starts the agent immediately.

The agent runs as the signed-in user, elevated. That lets it write to Program
Files and to the user's own registry (`HKCU`), `%APPDATA%` and Blender
preferences.

### Manage an agent

Run these in an administrator PowerShell on the team PC, from
`C:\Program Files\zeploy\` or wherever the exe is:

```bash
.\zeploy-agent.exe status
```

Shows the server, whether a token is set, the PC id, whether the agent is
running, and the log path.

```bash
.\zeploy-agent.exe remove
```

Stops the agent and deletes the Scheduled Task. The exe and `agent.json`
stay, and plugins it installed stay installed.

- **Update the agent:** bump the version, rebuild (`npm run build`) and restart
  the admin app, then use
  [Update the agents](#update-the-agents). An agent before 0.3.0 needs the
  installer once: save it again and run it on the PC, or run `setup` again with
  the new exe. Setup stops the old agent, replaces the exe and starts the new
  one.
- **After an update** the new agent runs outside the Scheduled Task until the
  user next signs in; then the task starts it as usual.
- **Admin PC moved to another address:** save the installer again (it holds
  the new address) and run it on each team PC, or run `setup` again with the
  new `--server`.
- **Log file:** `%LOCALAPPDATA%\zeploy\agent.log` of the user the agent runs as.

### Upgrading from zdeploy

zeploy was called zdeploy before. Nothing has to be set up again:

- **Admin PC:** the first start of the zeploy admin app moves
  `%APPDATA%\zdeploy-admin` to `%APPDATA%\zeploy-admin`, so packages, PCs and
  the team token carry over. The build removes the old
  `%LOCALAPPDATA%\Programs\zdeploy-admin` copy; unpin the old shortcut and pin
  `zeploy-admin.exe` instead.
- **Team PCs:** an agent installed as zdeploy keeps working with the zeploy
  admin app. To switch it over, save the installer again under
  **Connect a PC** and run it on the PC. It keeps the PC's id (same row, same
  name in zeploy), moves its records, and removes the old "zdeploy agent" task,
  process and `C:\Program Files\zdeploy` folder.
- Delete the old `Install zdeploy agent.cmd` and `zdeploy-agent.exe` from the
  shared folder.
- The firewall rule from step 1 opens a port, not a program, so it keeps
  working whatever its name.

## 3. Make a package

Most plugins need no packaging: add them as they are and zeploy reads their
name and version. Write a `zeploy.json` only to combine several parts into one
package (a CEP panel plus the JSFL commands it calls) or to set install
options.

### Plugins without zeploy.json

| Add | zeploy reads | Installs as |
| --- | --- | --- |
| CEP panel folder | id (`ExtensionBundleId`), name (`ExtensionBundleName` or the panel's menu name), version (`ExtensionBundleVersion`), apps (`<Host>`) from `CSXS/manifest.xml` | `cep` |
| `.zip` holding a CEP panel | the same, from inside the zip | `cep` |
| `.zxp` | the same, from `CSXS/manifest.xml` inside it | `zxp` |
| `.ccx` (UXP) | `id`, `name`, `version`, `host` from `manifest.json` inside it | `zxp` |
| Blender extension (`.zip` or folder with `blender_manifest.toml`) | `id`, `name`, `version` | `blender` |
| Blender legacy add-on (`.zip` or folder with `__init__.py`, or one `.py`) | `name` and `version` from `bl_info`; the id is the folder or file name | `blender` (a folder is zipped) |
| `.jsx` / `.jsxbin` | the file name; a version only if the script states one (`@version 1.2.0` or `SCRIPT_VERSION = "1.2.0"`) | `ai-script` when it targets Illustrator (`#target illustrator`, or Illustrator's `pathItems`, `artboards` and the like without `app.project`); else `ae-script`: `ScriptUI Panels` when it builds its UI in a `Panel`, else `Scripts`. **Installs into** in the Add dialog corrects the guess |
| `.jsfl` | the same | `jsfl` in `Commands` |

- A folder that holds exactly one of these one level down, such as a release
  folder with one `.zxp`, works too. A folder with several asks you to pick one.
- The Add dialog shows what zeploy read, and you can change the name, version
  and id there. A script that states no version needs one typed in.
- For a `.zxp` or `.ccx`, the dialog also shows the name Adobe's
  UnifiedPluginInstallerAgent lists it under (`/list all`); zeploy needs it to
  remove the extension.
- A later version of a plugin joins the package it was first added as, by
  the plugin's own id (bundle id, extension id, module or file name), even if
  that package had a `zeploy.json` with another id. So releasing is: bump the
  version in the plugin's manifest and add it again.
- Versions are read as `major.minor.patch`: `1.4` becomes `1.4.0`.

### Write zeploy.json

A package with `zeploy.json` is a folder with that file at its root, next to
the plugin files. zeploy reads only `zeploy.json` and the files its
components point at, so the package folder can be the plugin's working folder.

```json
{
  "schemaVersion": 1,
  "id": "colosave",
  "name": "Colosave",
  "version": "1.0.0",
  "description": "Keeps shape layer fills and strokes as palettes",
  "components": [
    { "type": "cep", "source": "cep/com.colosave.panel" }
  ]
}
```

- `id`: lowercase letters, digits, `.`, `_` and `-`. It never changes for a
  plugin.
- `version`: `major.minor.patch`. Raise it every time the content changes; the
  admin app accepts each version only once.
- `components`: one or more parts of the plugin. Paths are relative to the
  folder that holds `zeploy.json`.

### Component types

| type | source | installed to |
| --- | --- | --- |
| `cep` | folder with `CSXS/manifest.xml` | `CEP\extensions\<installName>`, for all users when the agent is elevated, else for the user. Also sets `PlayerDebugMode=1` for CSXS 9 to 24, so unsigned panels load |
| `ae-script` | `.jsx`/`.jsxbin` file or folder | `Support Files\Scripts\<folder>` in every After Effects install. Needs an elevated agent |
| `ai-script` | `.jsx`/`.jsxbin` file or folder | `Presets\<language>\Scripts` in every Illustrator install, where it shows under File > Scripts. Needs an elevated agent (0.6.0 or later) |
| `jsfl` | `.jsfl` file or folder | `%LOCALAPPDATA%\Adobe\Animate <version>\<language>\Configuration\<folder>` |
| `zxp` | signed `.zxp` or `.ccx` | through Adobe's UnifiedPluginInstallerAgent |
| `blender` | extension `.zip`, legacy add-on `.zip`, or single-file `.py` | every compatible Blender version, installed and enabled by Blender itself. Each version installs on its own: if one fails, the others stay installed and the install counts as partly done |

Optional fields:

- `cep`: `installName` is the folder name (default: the bundle id from
  `manifest.xml`). Set it when an existing install uses another name.
  `playerDebugMode` defaults to `true`.
- `ae-script`: `folder` is `ScriptUI Panels` (default), `Scripts`, `Startup`
  or `Shutdown`. `versions` limits it to some AE installs, such as `["2024"]`.
- `ai-script`: `versions` limits it to some Illustrator installs, such as
  `["2025"]`.
- `jsfl`: `folder` is `Commands` (default), `Tools`, `WindowSWF` or
  `Javascript`. `versions` works as for `ae-script`.
- `zxp`: `extensionName` is required; zeploy needs it to remove the extension.
- `blender`: `kind` (`extension` or `addon`) and `module` are read from the zip
  when absent. `minBlender` and `maxBlender` limit the Blender versions, such
  as `"4.2"`. An extension's own `blender_version_min` and
  `blender_version_max` are respected too.

### Examples

A CEP panel that installs under a folder name other than its bundle id:

```json
{ "type": "cep", "source": "AudiMate", "installName": "AudiMate" }
```

An After Effects ScriptUI panel for AE 2024 and 2026 only:

```json
{ "type": "ae-script", "source": "scripts/Aegroup.jsx", "versions": ["2024", "2026"] }
```

An Animate command:

```json
{ "type": "jsfl", "source": "jsfl/DelayerZ.jsfl", "folder": "Commands" }
```

A Blender extension, and a legacy add-on limited to Blender 4.2 to 4.5:

```json
{ "type": "blender", "source": "figblend-addon-0.2.0.zip" }
```

```json
{ "type": "blender", "source": "Remaper.zip", "minBlender": "4.2", "maxBlender": "4.5" }
```

One package can combine several components, for example a CEP panel and the
JSFL commands it calls.

### Test a package on the admin PC

The `zeploy` command line runs the same install engine as the agents. Run it
through `zeploy.cmd` in this folder.

Check the package:

```bash
.\zeploy.cmd validate "Z:\path\to\plugin-folder"
```

See what an install would do, without changing anything:

```bash
.\zeploy.cmd install "Z:\path\to\plugin-folder" --dry-run
```

Install it on this PC, list what zeploy installed, and remove it again:

```bash
.\zeploy.cmd install "Z:\path\to\plugin-folder"
```

```bash
.\zeploy.cmd list
```

```bash
.\zeploy.cmd uninstall colosave
```

If the plugin folder on your PC is a developer link (a symlink or junction to
your working copy), zeploy refuses to replace it. That protects the working
copy; see [Safety rules](#safety-rules).

## 4. Install, update and remove plugins

Everything here happens in the admin app.

### Add a package

Click **Add package**, then enter or choose a plugin (**Folder** or **File**),
or drag it onto the window. That can be:

- a plugin as it is, without `zeploy.json` (see
  [Plugins without zeploy.json](#plugins-without-zeployjson)): a CEP panel
  folder, `.zxp`, `.ccx`, Blender extension or add-on, `.jsx`, `.jsxbin` or
  `.jsfl`;
- a package folder with `zeploy.json`, or a `.zip` made by `zeploy pack`.

Dropping a folder works in the zeploy app; in a browser, drop a file or type
the folder's path.

To try zeploy on the team PCs first, add `examples\test-panel`: a do-nothing
After Effects panel (`com.zeploy.testpanel`) that is safe to install and
remove, and that leaves the registry alone. It is at version 1.1.0; to try
an update, raise `version` in its `zeploy.json` and `ExtensionBundleVersion`
in `panel\CSXS\manifest.xml`, then add it again.

The admin app checks the package, zips it and stores it with its SHA-256. Each
version can be added once. If the content changed, raise the version (in the
plugin's own manifest, in `zeploy.json`, or in the dialog) and add it again.

### Read the table

There is one row per PC and one column per package (its latest version). Columns are grouped by the app the package installs into: AE, Premiere, Illustrator, Animate, Blender, then panels that load in several apps (such as "AE + Premiere") after their first app.

- ◆ filled: the latest version is installed.
- ◇ outline: an older version is installed. The cell shows which.
- Dashed blue ◇ with "Found 1.0.0": the plugin is on that PC, but zeploy did
  not install it (copied by hand, or installed before zeploy). Hover for where
  it was found. Selecting the cell offers **Replace**: zeploy installs its
  version over it, and from then on the cell is a normal ◆ or ◇.
- Empty: not installed.
- Pulsing: a job is queued or running.
- "Failed" in red: the last job for that cell failed. Open it under
  **Activity** to see why.
- Half-filled amber ◆ with "Partial": a Blender add-on installed in some
  Blender versions and failed in others (needs agent 0.5.0). Hover to see
  which. **Activity** shows the job as "Partly done", with **Retry**; select
  the cell to retry it too. The **Failed** filter includes these PCs.

Each row also shows the PC's user, its IP address, whether it is online, and
the Adobe and Blender versions its agent found. Connected PCs are listed even
before you add a package.

"Found" needs agent 0.4.0 or later. The agent looks in the CEP extensions
folders (all users and this user), the After Effects `Scripts`, `ScriptUI
Panels`, `Startup` and `Shutdown` folders, Illustrator's
`Presets\<language>\Scripts` (agent 0.6.0), Animate's `Commands`, `Tools` and
`WindowSWF`, and each Blender version's add-ons and extensions. It matches
what it finds to packages by plugin id (bundle id, extension id, module or
file name), so a CEP panel is found whatever its folder is called. A `.zxp`
is found through the CEP panel it installed. A `.ccx` is not found.

### Install or update

1. Click the cells you want, or click a package name to select its whole
   column.
2. Choose what happens if the app is open on a PC:
   - **Stop and tell me** (default): the job fails with a clear message and
     nothing changes.
   - **Close the app**: zeploy closes it first. Unsaved work is lost.
   - **Install anyway, restart later**: installs while the app runs; the user
     restarts it to load the new version.
3. Tick **Replace developer links** only for PCs where a developer link should
   be replaced by a normal installed copy.
4. Click the green button. It says what it does: **Install N**, **Update N**,
   **Reinstall N**, or **Apply N** for a mix.

Updating is the same: get the new version into zeploy, then install it on
the PCs that show ◇. Files the old version installed and the new one does not
are removed.

To get a new version into zeploy, hover over the package name and click
**↻**. zeploy reads the folder or file the package was added from again. If
it holds a newer version, that version is added right away; if something is
missing (a script without a version) or different, the Add dialog opens on it.
The ↻ button shows for packages added from a folder or file once this
feature exists; add an older package once more to give it one. Dropped files
in a browser have no folder to read again.

**Folder** and **File** in the Add dialog open where you last picked a
plugin, so the next version beside it is one click away.

A PC that is off gets the job when its agent connects again. Until then the job
is queued; open it under **Activity** to cancel it.

### Remove from PCs

Click the cells of the PCs to remove a plugin from (a filled ◆ or ◇ means it
is installed there). The side panel then shows a red **Remove N from PCs**,
where N counts the selected cells that have the plugin; the others are
skipped. Click it and confirm. The agent removes exactly what zeploy
installed, using its record of the install. Plugins zeploy did not install
are never touched.

### Update the agents

When the admin app holds a newer `zeploy-agent.exe` than a PC runs (after a
rebuild with a higher version), that PC's row shows its agent version in
amber, such as "^Agent 0.3.0". It is a notice, not an error: installs and
removals on that PC keep working.

- **Update N agents to x.y.z** (above the table) updates every PC that can.
- **Update agent** (next to a PC's name) updates one PC.

Like any job, the update waits for a PC that is off, and shows under
**Activity** as "Agent x.y.z". On the PC, the agent downloads the new exe,
checks its SHA-256 and that it starts, swaps it in for
`C:\Program Files\zeploy\zeploy-agent.exe` and starts it. The new agent
connects, and the old one exits. Jobs never stop in between. If the new agent
does not connect within a minute, the old exe goes back, the old agent keeps
running and the job fails.

#### A PC shows "Agent 0.2.0" and has no Update agent

Self-update arrived in 0.3.0, so an agent on 0.2.0 cannot update itself.
Hovering over the tag says so. Update each such PC once by hand:

1. Make sure the admin app holds the new agent. After pulling or changing
   the agent, rebuild and restart the admin app:

   ```bash
   npm run build
   ```

   ```bash
   npm run admin
   ```

   Otherwise the installer you save still carries the old exe.
2. Open **Connect PC** (or press `c`) and **Save** the installer to the shared
   folder. This writes a fresh `Install zeploy agent.cmd` and
   `zeploy-agent.exe`.
3. On each PC with the tag, double-click `Install zeploy agent.cmd` and
   choose **Yes** in the Windows prompt.

Setup stops the old agent, replaces the exe in `C:\Program Files\zeploy` and
starts the new one. It keeps the PC id, so the row, its name in zeploy and the
install records stay, and installed plugins are left alone. The tag goes away
when the agent reconnects. From then on the PC updates from the admin app.

Delete the installer from the shared folder afterwards: it holds the team
token.

### Other actions

- **Activity** lists every job. Click one to see its log.
- **Remove from repository** (under a package name) deletes that version from
  the admin app. Plugins already installed on PCs stay installed.
- **Edit** (next to a PC's name) sets two things shown only in zeploy:
  - **Name**, such as the person who uses it. The Windows computer name stays
    in the tooltip. **Use Windows name** removes it.
  - **Role**, such as Animator or Compositor. The table groups PCs under a
    header per role (A to Z, with "No role" last) showing how many are online.
    Existing roles are offered as you type, and a role typed in other case
    ("animator") joins the existing one. Leave it empty for no role.

  Both survive reconnects.
- **Forget PC** (on an offline PC) removes it from the table. It comes back
  when its agent connects again.
- **Copy team token** copies the token agents use to connect.
- Keys (shown in the status bar): `a` add package, `c` connect PC, `1` changes,
  `2` activity, `s` collapses or expands the side panel, `Esc` closes a dialog.
- The side panel can be resized: drag the bar on its left edge, or focus the
  bar and use the arrow keys. Double-click the bar to reset the width. **»**
  collapses the panel to a strip showing its counts; click the strip to expand
  it. Width and collapsed state are remembered. Removing plugins from PCs, deleting a
  package version and forgetting a PC each ask first; Enter cancels.

## 5. Troubleshooting

### A PC does not appear in the admin app

1. On the team PC, open `http://<admin PC address>:7420/health` in a browser.
   - It does not load: the network blocks it. Recheck
     [Open the network for agents](#open-the-network-for-agents), and check
     that both PCs are on the same LAN.
   - It loads: the network is fine. Continue below.
2. On the team PC, run `.\zeploy-agent.exe status` in an administrator
   PowerShell. If "running" says no, run `setup` again.
3. Read the end of `%LOCALAPPDATA%\zeploy\agent.log`. If it says
   `the server rejected the team token; check the agent configuration`, run
   `setup` again with the command from **Connect a PC**.

### Errors from setup

| Message | What to do |
| --- | --- |
| `cannot reach the admin server at http://...` | The admin app is not running, the address is wrong, or the network blocks port 7420. See above |
| `setup must be run from an administrator terminal` | Open PowerShell with "Run as administrator" |
| `setup must be run from the built zeploy-agent.exe (npm run build:agent)` | Use the built exe, not `npm run agent` |
| `setup needs --server and --token` | Copy the whole command from **Connect a PC** |
| SmartScreen or antivirus warning | The exe is not code-signed. Choose "More info", then "Run anyway". If the antivirus quarantines it, allow `zeploy-agent.exe` |
| `The account "..." is not a local administrator on this PC.` (installer) | Make that account a local administrator, sign out and in, then run the installer again |
| `zeploy-agent.exe was not found next to this file` (installer) | Keep `Install zeploy agent.cmd` and `zeploy-agent.exe` in the same folder |
| `Setup was cancelled. Nothing was installed.` (installer) | You chose No in the Windows prompt. Run it again and choose Yes |
| **Save installer** is greyed out | The admin app has no agent to hand out. Run `npm run build:agent`, then `npm run admin` |

### A job failed

The reason is the first line under the job in **Activity**; click the job for
the full log. Nothing on the PC changes when a job fails before installing.

| Message | Cause and fix |
| --- | --- |
| `close After Effects first ...` (or another app) | The app was open. Ask the user to close it, or install with **Close the app** |
| `... is a developer link to ...` | The install location is a developer's symlink or junction. Leave it, or install with **Replace developer links** |
| `... elevated (administrator) process` | The agent runs without administrator rights. The PC's user must be a local administrator; run `setup` again |
| `no matching After Effects install ...` | That PC has no After Effects version the package allows |
| `no Animate Configuration folder ...; open Animate once so it creates one` | Start Animate once on that PC, then install again |
| `no compatible Blender for ...` | That PC has no Blender version inside the package's range |
| `agent disconnected during the job` | The PC went offline mid-job. Check the PC, then install again |
| `admin server restarted during the job` | The admin app closed mid-job. Install again |

### Other problems

| Problem | Fix |
| --- | --- |
| Adding a package says `... is already in the repository with different content` | Raise the version: in the plugin's manifest, in `zeploy.json`, or in the Add dialog |
| The admin app says `The admin server could not start` | Another admin app or `npm run server` is using port 7420. Close it |
| The admin app does not start at all when run from `Z:` | Electron cannot start from a network share. Start `%LOCALAPPDATA%\Programs\zeploy-admin\zeploy-admin.exe` |
| `electron.exe` is missing after `npm install` | Run `npm run setup:electron` |
| A PC shows "Agent 0.2.0" and no **Update agent** | Its agent predates self-update. Run the installer on it once: see [A PC shows "Agent 0.2.0"](#a-pc-shows-agent-020-and-has-no-update-agent) |
| The UI shows Consolas instead of JetBrains Mono | The admin PC has no internet; the font comes from Google Fonts. Install JetBrains Mono on that PC, or ignore it: everything else works |

## 6. Reference

### Where things are stored

| What | Where |
| --- | --- |
| Admin data: packages, PCs, jobs, team token | `%APPDATA%\zeploy-admin\` (`state.json` and `packages\`) on the admin PC |
| Admin app | `%LOCALAPPDATA%\Programs\zeploy-admin\` |
| Agent | `C:\Program Files\zeploy\zeploy-agent.exe` |
| Agent settings | `C:\ProgramData\zeploy\agent.json` |
| Install records, staging, agent log | `%LOCALAPPDATA%\zeploy\` of the user the agent runs as |
| Saved installers (hold the team token) | The folder you chose under **Connect a PC** |

Back up `%APPDATA%\zeploy-admin\` on the admin PC. It holds the team token;
if it is lost, the admin app creates a new token and every PC needs `setup`
again.

### Command line (zeploy)

```bash
zeploy detect [--json]                 # installed apps and install locations
zeploy validate <folder|zip>           # check a package
zeploy pack <folder> [--out <dir>]     # build <id>-<version>.zip and print its SHA-256
zeploy install <folder|zip> [options]
zeploy uninstall <id> [options]
zeploy list                            # packages installed by zeploy on this PC
```

| Option | Meaning |
| --- | --- |
| `--dry-run` | Print every step, change nothing |
| `--if-running fail\|kill\|ignore` | A target app is open. Default `fail`; `kill` loses unsaved work |
| `--scope auto\|user\|system` | CEP folder. `auto` = all-users folder when elevated, else per user |
| `--skip-registry` | Leave `PlayerDebugMode` alone |
| `--replace-dev-links` | Replace a developer symlink or junction at the install location |
| `--blender 4.2,5.1` | Only these Blender versions |
| `--sha256 <hex>` | Refuse a zip whose hash differs |

### Agent commands (zeploy-agent.exe)

| Command | Meaning |
| --- | --- |
| `setup --server <ip[:port]> --token <token>` | Install on this PC and start (administrator) |
| `status` | Show the version, settings and whether the agent runs |
| `remove` | Stop the agent and delete its Scheduled Task (administrator) |
| `configure --server ... --token ...` | Change the saved settings only; the agent reads them at start |
| `run` | Run in the foreground; this is what the Scheduled Task starts |
| `version` | Print the version |
| `run --takeover <pid>` | What an agent update starts: connect, then take over from the agent with that pid |

### Safety rules

- A developer symlink or junction at an install location is never deleted
  through. The install stops unless "Replace developer links" is chosen, and
  then only the link itself is removed. This also covers Blender add-on
  folders: Blender 4.2 (Python 3.11) would otherwise delete a junction's
  target when overwriting an add-on.
- A copy of the same CEP panel in the other CEP folder (all users or per user)
  is removed. A developer link there is left alone and reported.
- Zip entries with absolute paths or `..` are refused before anything is
  extracted.
- Packages are extracted to a local staging folder first, so installs never run
  from a mapped drive.
- Every install writes a record. Updates remove what the old version installed
  and the new one does not; removing a package removes exactly what the record
  lists.

### Security model

- Agents and the admin app share a team token. The handshake proves both sides
  know it without sending it. Every later message carries an HMAC over its
  sequence number and content, so jobs cannot be forged, altered or replayed
  from the LAN.
- A package download needs a one-time link that belongs to its job. The agent
  installs the package only if its SHA-256 matches the one in the
  authenticated job. An agent update works the same way: the agent runs the
  new exe only if its SHA-256 matches.
- The admin UI and its API answer only on the admin PC itself, and only with a
  token that changes every time the admin app starts.
- Traffic is not encrypted: another PC on the LAN could read a package while
  it downloads.
- `zeploy-agent.exe` is not code-signed.
- A saved installer holds the team token. Anyone with the token who can also
  intercept LAN traffic could pose as the admin app and send install jobs to
  agents, so keep installers where only the team can open them. The
  repository's `.gitignore` excludes `Install zeploy agent.cmd` and
  `zeploy-agent.exe` so neither is committed by accident.

## 7. Development

| Folder | What it is |
| --- | --- |
| `packages/core` | Package format, app detection and the install engine |
| `packages/cli` | `zeploy` command line |
| `packages/protocol` | Authenticated messages between admin server and agents |
| `packages/server` | Admin server: packages, agent connections, jobs, and the admin UI (`ui/`) |
| `packages/admin` | Electron shell around the admin server |
| `packages/agent` | Agent; runs jobs through `packages/core` |
| `scripts/build.mjs` | Builds the agent exe and the admin app |
| `docs/` | Workflow diagram (source JSON and rendered HTML) |
| `zeploy.cmd` | Runs the `zeploy` command line from this folder |

Node runs the TypeScript sources directly; only the admin app and the agent
exe are bundled. The working copy has lived on a network share, where npm
workspaces fail because they need symlinks, so there is one `package.json` at
the root and the packages import each other by relative path.

| npm script | What it does |
| --- | --- |
| `npm test` | All tests (`node --test`) |
| `npm run typecheck` | TypeScript check, no output files |
| `npm run build` | Agent exe, then the admin app |
| `npm run build:agent` | `%LOCALAPPDATA%\zeploy-build\zeploy-agent\zeploy-agent.exe`, and `zeploy-agent.json` with its version |
| `npm run build:admin` | `%LOCALAPPDATA%\zeploy-build\admin` and the runnable copy in `%LOCALAPPDATA%\Programs\zeploy-admin` |
| `npm run admin` | `build:admin`, then start the admin app |
| `npm run package` | Both, ready to hand out, in `dist\zeploy-<version>` (ignored by git): `zeploy-admin\zeploy-admin.exe` with its Electron runtime, and `zeploy-agent\zeploy-agent.exe`. Copy the admin folder to a local disk to run it; Electron does not start from a network share |
| `npm run server` | Admin server without Electron (open `http://127.0.0.1:7420/`) |
| `npm run agent -- <command>` | Agent from source, e.g. `status` or `run` (not `setup`, which needs the built exe) |
| `npm run zeploy -- <command>` | The `zeploy` command line |
| `npm run setup:electron` | Download the Electron runtime if `npm install` skipped it |

```bash
npm test
```

```bash
npm run typecheck
```

A separate test server, off the LAN, with its own data:

```bash
npm run server -- --host 127.0.0.1 --port 7421 --data .zeploy-test/admin-data
```

To try Blender installs without touching your real Blender preferences, set
`BLENDER_USER_RESOURCES`, `BLENDER_USER_CONFIG`, `BLENDER_USER_SCRIPTS` and
`BLENDER_USER_EXTENSIONS` to a scratch folder first. zeploy follows the same
variables.

Environment variables for running test copies next to the real ones:

| Variable | Default |
| --- | --- |
| `ZEPLOY_PORT` | `7420` (admin app) |
| `ZEPLOY_ADMIN_HOST` | all interfaces; `127.0.0.1` keeps a test server off the LAN |
| `ZEPLOY_ADMIN_DATA` | `%APPDATA%\zeploy-admin` |
| `ZEPLOY_ADMIN_OUT` | `%LOCALAPPDATA%\Programs\zeploy-admin` (where `npm run admin` puts the app) |
| `ZEPLOY_BUILD_DIR` | `%LOCALAPPDATA%\zeploy-build` (build output; kept off the network share, where the NAS locks deleted folders) |
| `ZEPLOY_AGENT_CONFIG` | `%ProgramData%\zeploy\agent.json` |
| `ZEPLOY_HOME` | `%LOCALAPPDATA%\zeploy` (install records, staging, agent log) |

The admin app allows one instance at a time. To run a test copy with
`ZEPLOY_ADMIN_DATA` and `ZEPLOY_PORT`, close the real one first.

The version lives in `packages/agent/src/version.ts`, for both the agent and
the admin app. The admin app offers an agent update to every PC that runs an
older version than the exe it holds, so bump the version whenever the agent
changes. The admin server reads the exe's version from the
`zeploy-agent.json` the build writes next to it, so the admin app never offers
a version it does not have.

## Status and roadmap

Done:

- **Phase 1:** package format, install engine and `zeploy` command line, with
  developer-link safety for CEP and Blender.
- **Phase 2:** admin app (Electron), agents on team PCs, authenticated jobs,
  one-click installer, PC renaming.
- **Phase 3, started:** agent self-update from the admin app (0.3.0);
  plugins found on PCs without zeploy, and updating a package from its
  folder (0.4.0).

Planned for phase 3:

- Rolling a package back to an earlier version
- Encrypted connections (TLS)
- Finding the admin app on the LAN automatically, without typing its address
- A Windows notification on the team PC when a plugin was installed
- Code-signing `zeploy-agent.exe`
