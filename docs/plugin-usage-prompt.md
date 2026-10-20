# Prompt: add zeploy usage reporting to a plugin

Paste everything below the line into the chat of the plugin project. It is
self-contained: the helpers from `examples/usage/` are included, and a test
(`packages/agent/test/usage.test.ts`) checks they match the files there.

---

Add usage reporting to this plugin, so our team's deployment tool, zeploy,
can show which plugins are used most and which features inside them. Read
the whole brief before changing anything.

## Context

zeploy installs our After Effects, Premiere Pro, Illustrator, Animate and
Blender plugins on the team's PCs. Its agent runs on every PC. A plugin
reports usage by appending one JSON line per event to a local file:

```
%LOCALAPPDATA%\zeploy\usage\<plugin id>.jsonl
```

The agent picks the file up every minute, sends daily totals to the admin
app and deletes it. The plugin never talks to the network and never knows
whether anyone reads the file. A ready-made helper writes the lines; your job
is to add the helper and call it in the right places.

## Rules

1. **Copy the helper for this plugin's platform unchanged** (they are at the
   end of this brief). Do not reformat, rename or "improve" it: every plugin
   must write exactly the same format, and the helper's function name
   (`zeployUsageV1`) is shared by every plugin in the same app.
2. **Usage must never affect the plugin.** The helpers never throw and never
   block; keep it that way. Do not wrap them in extra logic that could fail,
   and do not await anything just for usage.
3. **No personal or project data.** Event names are short, fixed words you
   choose in code (`export`, `align`, `remap`). Never pass file names, layer
   or comp names, paths, user names, error messages or any user input as a
   name.
4. **No new dependencies, no network, no UI** for this.
5. Use the plugin's own id and version (see "The id" below), written once as
   constants next to where the helper is created.

## The id and version

| Plugin | id | version |
| --- | --- | --- |
| CEP panel | `ExtensionBundleId` from `CSXS/manifest.xml`, such as `com.colosave.panel` | `ExtensionBundleVersion` |
| Blender extension | `id` from `blender_manifest.toml` | `version` from `blender_manifest.toml` |
| Blender legacy add-on | the add-on's module (folder) name, such as `remaper` | `bl_info["version"]` joined with dots |
| `.jsx` / `.jsxbin` script | the script's file name, such as `Aegroup.jsx` | the script's own version constant, if it has one, else `""` |
| Animate `.jsfl` command | the file name, such as `DelayerZ.jsfl` | its version constant, else `""` |

If the version already lives in one place in the code, read it from there
instead of repeating it.

## What to count

- **`action(name)`**: the user used a feature. This is the number that
  matters: zeploy ranks plugins by how many PCs use them and how often.
  Count each main feature once per use, where the work starts or completes:
  a button that does the work, a menu command, an operator's `execute`, the
  run of a script. Prefer `track(name, fn)`, which also records how long the
  feature took and counts an `error` if it throws. Do not count hovers,
  panel resizes, setting changes, redraws, timers or anything automatic.
- **`open()`**: the panel was opened (CEP panels: once, when the panel's
  page loads). Not for Blender add-ons: `register()` runs at every Blender
  start, used or not. Not for scripts and JSFL commands: their run is the
  action.
- **`error(name)`**: a feature failed where you already catch the failure
  (`track` does this by itself). The name is the feature's name or a short
  fixed error kind, never the message.

Names: lowercase words, at most 40 characters of `a-z 0-9 . _ -`, stable
across versions, one per feature. Aim for the features a person would name
when asked "what do you use this plugin for": usually 2 to 10 per plugin.
For a script that does one thing, use `run`.

## Steps

1. Work out the plugin's platform, id and version, and list its main
   features with the name you will give each. Show me this list before
   changing code.
2. Add the matching helper file to the project unchanged:
   - CEP panel: `zeploy-usage.js`, loaded with a `<script>` tag in the
     panel's HTML before the panel's own scripts (after `CSInterface.js` if
     the panel loads it). If the panel's ExtendScript host side has features
     worth counting on its own, add `zeploy-usage.jsx` there too, with
     `"aftereffects"`, `"premiere"` or `"illustrator"` as the app.
   - After Effects or Illustrator script: `zeploy-usage.jsx`, `#include`d
     (or pasted at the top for a single-file script), with
     `"aftereffects"` or `"illustrator"` as the app.
   - Animate JSFL command: paste `zeploy-usage.jsfl` at the top of the
     command file.
   - Blender: `zeploy_usage.py` as a module inside the add-on package (for a
     single-file add-on, paste its class above the add-on's code).
3. Create one usage object at load time:
   - CEP: `var usage = zeployUsageV1("<id>", "<version>"); usage.open();`
   - ExtendScript: `var usage = zeployUsageV1("<id>", "<version>", "<app>");`
   - JSFL: `var usage = zeployUsageV1("<id>", "<version>");`
   - Blender: `usage = zeploy_usage.Usage("<id>", "<version>")` at module level.
4. Count each feature from step 1 with `usage.track("<name>", ...)`
   (Blender: decorate the operator's `execute` with `@usage.track("<name>")`;
   for async CEP work, `usage.trackAsync`), or `usage.action("<name>")` where
   wrapping is awkward. Keep the plugin's behaviour, return values and error
   handling exactly as they were.
5. If the plugin has a build or packaging step, make sure the helper file is
   included in the output.
6. Bump the plugin's version as the project usually does for a change.

## Done means

- The helper file is in the project, byte for byte as below.
- Every feature from the list in step 1 is counted once per use, and nothing
  else is.
- No event name contains user data.
- The plugin works exactly as before on a PC without zeploy (the helper
  writes nothing there).
- Tell me how to check it: on a PC with the zeploy agent, use each feature
  and look at `%LOCALAPPDATA%\zeploy\usage\<file>.jsonl` (one line per event;
  the agent deletes the file within a minute), or create the
  `%LOCALAPPDATA%\zeploy` folder on a PC without the agent to see the lines
  stay.

## The line format (for reference; the helpers write it)

```json
{"v":1,"t":"2026-10-20T09:12:03.120Z","plugin":"com.colosave.panel","ver":"1.4.0","app":"aftereffects","ev":"action","name":"export","ms":340}
```

`v` 1; `t` ISO 8601 UTC; `plugin` the id; `ver` the version; `app` one of
`aftereffects`, `premiere`, `illustrator`, `animate`, `blender`; `ev` `open`,
`action` or `error`; `name` for actions and errors; `ms` the duration. The
file name is the id with characters outside `A-Z a-z 0-9 . _ -` replaced by
`_`, plus `.jsonl`. Writers stop at 512 KB and write only where
`%LOCALAPPDATA%\zeploy` exists.

## The helpers

### CEP panel: zeploy-usage.js

```js
// zeploy usage helper for CEP panels (After Effects, Premiere Pro,
// Illustrator, Animate). Load it in the panel's HTML before the panel's own
// script; copy it unchanged. Contract: docs/plugin-usage.md in the zeploy
// repository.
//
//   var usage = zeployUsageV1("com.colosave.panel", "1.4.0");
//   usage.open();                                    // once, when the panel loads
//   usage.action("export");                          // a feature was used
//   usage.track("export", function () { ... });       // ... with its duration
//   await usage.trackAsync("export", async () => {}); // ... for async work
//   usage.error("export");                           // a feature failed
//
// The app ("aftereffects", ...) is read from CSInterface when it is loaded.
// It appends one line to %LOCALAPPDATA%\zeploy\usage\<plugin>.jsonl, and
// only on PCs where zeploy is installed. It uses Node's fs when the panel
// enables Node (--enable-nodejs), else window.cep.fs (which needs
// CSInterface.js to find the folder). It never throws,
// never shows anything and never uses the network.

(function (root) {
  if (typeof root.zeployUsageV1 === "function") return;

  var MAX_BYTES = 524288;
  var HOSTS = { AEFT: "aftereffects", PPRO: "premiere", ILST: "illustrator", FLPR: "animate" };

  // With --enable-nodejs, Node is global in a mixed context and under
  // cep_node otherwise.
  function nodeRequire() {
    if (typeof require === "function") return require;
    return root.cep_node && typeof root.cep_node.require === "function" ? root.cep_node.require : null;
  }

  function nodeProcess() {
    if (typeof process !== "undefined") return process;
    return root.cep_node ? root.cep_node.process : null;
  }

  function node() {
    try {
      var req = nodeRequire();
      return req ? { fs: req("fs"), path: req("path") } : null;
    } catch (e) {
      return null;
    }
  }

  function hostApp() {
    try {
      var env = new CSInterface().getHostEnvironment();
      return HOSTS[env.appName] || HOSTS[env.appId] || null;
    } catch (e) {
      return null;
    }
  }

  function localAppData() {
    try {
      var proc = nodeProcess();
      if (proc && proc.env && proc.env.LOCALAPPDATA) return proc.env.LOCALAPPDATA;
    } catch (e) {}
    try {
      // Without Node: the user's Roaming folder, next to Local.
      var roaming = new CSInterface().getSystemPath(SystemPath.USER_DATA);
      return roaming.replace(/[\\\/]Roaming[\\\/]?$/i, "/Local");
    } catch (e) {
      return null;
    }
  }

  function append(dir, fileName, line) {
    var n = node();
    if (n) {
      var file = n.path.join(dir, fileName);
      if (!n.fs.existsSync(n.path.dirname(dir))) return;
      if (!n.fs.existsSync(dir)) n.fs.mkdirSync(dir);
      if (n.fs.existsSync(file) && n.fs.statSync(file).size > MAX_BYTES) return;
      n.fs.appendFileSync(file, line + "\n", "utf8");
      return;
    }
    var cepfs = root.cep && root.cep.fs;
    if (!cepfs) return;
    var home = dir.replace(/[\\\/]usage$/, "");
    if (cepfs.readdir(home).err !== 0) return;
    if (cepfs.readdir(dir).err !== 0) cepfs.makedir(dir);
    var path = dir + "/" + fileName;
    var current = cepfs.readFile(path);
    var text = current.err === 0 ? current.data : "";
    if (text.length > MAX_BYTES) return;
    // cep.fs cannot append: the file is written whole.
    cepfs.writeFile(path, text + line + "\n");
  }

  root.zeployUsageV1 = function (plugin, version, app) {
    app = app || hostApp();

    function write(ev, name, ms) {
      try {
        var base = localAppData();
        if (!base) return;
        var event = { v: 1, t: new Date().toISOString(), plugin: String(plugin) };
        if (version) event.ver = String(version);
        if (app) event.app = app;
        event.ev = ev;
        if (name) event.name = String(name);
        if (typeof ms === "number" && ms >= 0) event.ms = Math.round(ms);
        var fileName = String(plugin).replace(/[^A-Za-z0-9._-]/g, "_") + ".jsonl";
        append(base.replace(/[\\\/]+$/, "") + "/zeploy/usage", fileName, JSON.stringify(event));
      } catch (e) {
        // Usage must never get in the way of the panel.
      }
    }

    return {
      open: function () {
        write("open");
      },
      action: function (name, ms) {
        write("action", name, ms);
      },
      error: function (name) {
        write("error", name);
      },
      // Runs fn as the feature `name`: counts it with its duration, or counts
      // an error when fn throws (and throws on).
      track: function (name, fn) {
        var start = Date.now();
        var result;
        try {
          result = fn();
        } catch (e) {
          write("error", name);
          throw e;
        }
        write("action", name, Date.now() - start);
        return result;
      },
      // The same for a function returning a promise.
      trackAsync: function (name, fn) {
        var start = Date.now();
        return Promise.resolve()
          .then(fn)
          .then(
            function (result) {
              write("action", name, Date.now() - start);
              return result;
            },
            function (err) {
              write("error", name);
              throw err;
            },
          );
      },
    };
  };
})(typeof window !== "undefined" ? window : this);
```

### ExtendScript (After Effects, Illustrator, CEP host side): zeploy-usage.jsx

```js
// zeploy usage helper for ExtendScript: After Effects and Illustrator
// scripts, and the host side of CEP panels. Copy this file into the plugin
// unchanged. Contract: docs/plugin-usage.md in the zeploy repository.
//
//   var usage = zeployUsageV1("Aegroup.jsx", "2.1.0", "aftereffects");
//   usage.action("group");                         // a feature was used
//   usage.track("export", function () { ... });     // ... with its duration
//   usage.error("export");                         // a feature failed
//   usage.open();                                  // the UI was opened
//
// It appends one line to %LOCALAPPDATA%\zeploy\usage\<plugin>.jsonl, and
// only on PCs where zeploy is installed. It never throws, never shows
// anything and never uses the network.

if (typeof $.global.zeployUsageV1 !== "function") {
  $.global.zeployUsageV1 = function (plugin, version, app) {
    var MAX_BYTES = 524288;

    function pad(n, width) {
      var s = String(n);
      while (s.length < (width || 2)) s = "0" + s;
      return s;
    }

    function iso(d) {
      return (
        d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()) +
        "T" + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + ":" + pad(d.getUTCSeconds()) +
        "." + pad(d.getUTCMilliseconds(), 3) + "Z"
      );
    }

    // ExtendScript has no JSON object. Anything outside printable ASCII is
    // written as \uXXXX, so the file encoding never matters.
    function str(value) {
      var s = String(value);
      var out = '"';
      for (var i = 0; i < s.length; i++) {
        var c = s.charAt(i);
        var code = s.charCodeAt(i);
        if (c === '"' || c === "\\") out += "\\" + c;
        else if (code < 32 || code > 126) {
          var hex = code.toString(16);
          while (hex.length < 4) hex = "0" + hex;
          out += "\\u" + hex;
        } else out += c;
      }
      return out + '"';
    }

    function write(ev, name, ms) {
      try {
        var base = $.getenv("LOCALAPPDATA");
        if (!base) return;
        var home = new Folder(base + "/zeploy");
        if (!home.exists) return;
        var dir = new Folder(home.fsName + "/usage");
        if (!dir.exists && !dir.create()) return;
        var file = new File(dir.fsName + "/" + String(plugin).replace(/[^A-Za-z0-9._-]/g, "_") + ".jsonl");
        if (file.exists && file.length > MAX_BYTES) return;
        var line = '{"v":1,"t":' + str(iso(new Date())) + ',"plugin":' + str(plugin);
        if (version) line += ',"ver":' + str(version);
        if (app) line += ',"app":' + str(app);
        line += ',"ev":' + str(ev);
        if (name) line += ',"name":' + str(name);
        if (typeof ms === "number" && ms >= 0) line += ',"ms":' + Math.round(ms);
        line += "}";
        file.encoding = "UTF-8";
        file.lineFeed = "Unix";
        if (!file.open("a")) return;
        file.writeln(line);
        file.close();
      } catch (e) {
        // Usage must never get in the way of the plugin.
      }
    }

    return {
      open: function () {
        write("open");
      },
      action: function (name, ms) {
        write("action", name, ms);
      },
      error: function (name) {
        write("error", name);
      },
      // Runs fn as the feature `name`: counts it with its duration, or counts
      // an error when fn throws (and throws on).
      track: function (name, fn) {
        var start = new Date().getTime();
        var result;
        try {
          result = fn();
        } catch (e) {
          write("error", name);
          throw e;
        }
        write("action", name, new Date().getTime() - start);
        return result;
      },
    };
  };
}
```

### Animate JSFL: zeploy-usage.jsfl

```js
// zeploy usage helper for Animate JSFL commands. Paste it at the top of the
// command (JSFL has no includes for commands) and leave it unchanged.
// Contract: docs/plugin-usage.md in the zeploy repository.
//
//   var usage = zeployUsageV1("DelayerZ.jsfl", "1.1.0");
//   usage.action("run");                          // the command was run
//   usage.track("run", function () { ... });       // ... with its duration
//   usage.error("run");                           // it failed
//
// It appends one line to %LOCALAPPDATA%\zeploy\usage\<plugin>.jsonl, and
// only on PCs where zeploy is installed. It never throws, never shows
// anything and never uses the network.

function zeployUsageV1(plugin, version) {
  var MAX_BYTES = 524288;

  function pad(n, width) {
    var s = String(n);
    while (s.length < (width || 2)) s = "0" + s;
    return s;
  }

  function iso(d) {
    return (
      d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()) +
      "T" + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + ":" + pad(d.getUTCSeconds()) +
      "." + pad(d.getUTCMilliseconds(), 3) + "Z"
    );
  }

  function str(value) {
    var s = String(value);
    var out = '"';
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      var code = s.charCodeAt(i);
      if (c === '"' || c === "\\") out += "\\" + c;
      else if (code < 32 || code > 126) {
        var hex = code.toString(16);
        while (hex.length < 4) hex = "0" + hex;
        out += "\\u" + hex;
      } else out += c;
    }
    return out + '"';
  }

  // fl.configURI is file:///C|/Users/<name>/AppData/Local/Adobe/Animate <version>/<language>/Configuration/
  function localAppDataUri() {
    var i = fl.configURI.toLowerCase().indexOf("/adobe/");
    return i > 0 ? fl.configURI.substring(0, i) : null;
  }

  function write(ev, name, ms) {
    try {
      var base = localAppDataUri();
      if (!base) return;
      var home = base + "/zeploy";
      if (!FLfile.exists(home)) return;
      var dir = home + "/usage";
      if (!FLfile.exists(dir) && !FLfile.createFolder(dir)) return;
      var file = dir + "/" + String(plugin).replace(/[^A-Za-z0-9._-]/g, "_") + ".jsonl";
      if (FLfile.exists(file) && FLfile.getSize(file) > MAX_BYTES) return;
      var line = '{"v":1,"t":' + str(iso(new Date())) + ',"plugin":' + str(plugin);
      if (version) line += ',"ver":' + str(version);
      line += ',"app":"animate","ev":' + str(ev);
      if (name) line += ',"name":' + str(name);
      if (typeof ms === "number" && ms >= 0) line += ',"ms":' + Math.round(ms);
      FLfile.write(file, line + "}\n", "append");
    } catch (e) {
      // Usage must never get in the way of the command.
    }
  }

  return {
    action: function (name, ms) {
      write("action", name, ms);
    },
    error: function (name) {
      write("error", name);
    },
    track: function (name, fn) {
      var start = new Date().getTime();
      var result;
      try {
        result = fn();
      } catch (e) {
        write("error", name);
        throw e;
      }
      write("action", name, new Date().getTime() - start);
      return result;
    },
  };
}
```

### Blender: zeploy_usage.py

```python
"""zeploy usage helper for Blender add-ons and extensions.

Copy this file into the add-on unchanged. Contract: docs/plugin-usage.md in
the zeploy repository.

    from . import zeploy_usage
    usage = zeploy_usage.Usage("remaper", "1.3.2")   # module or extension id, version

    class REMAPER_OT_remap(bpy.types.Operator):
        ...
        @usage.track("remap")          # counts each run that is not cancelled
        def execute(self, context):
            ...

    usage.action("remap")              # or count a use directly
    usage.error("remap")               # a feature failed

Do not count anything in register(): Blender registers enabled add-ons at
every start, used or not.

It appends one line to %LOCALAPPDATA%\\zeploy\\usage\\<plugin>.jsonl, and only
on PCs where zeploy is installed. It never raises, never shows anything and
never uses the network.
"""

import functools
import json
import os
import re
import time
from datetime import datetime, timezone

_MAX_BYTES = 512 * 1024


class Usage:
    def __init__(self, plugin, version=""):
        self.plugin = str(plugin)
        self.version = str(version) if version else ""

    def _write(self, ev, name=None, ms=None):
        try:
            base = os.environ.get("LOCALAPPDATA")
            if not base:
                return
            home = os.path.join(base, "zeploy")
            if not os.path.isdir(home):
                return
            folder = os.path.join(home, "usage")
            os.makedirs(folder, exist_ok=True)
            path = os.path.join(folder, re.sub(r"[^A-Za-z0-9._-]", "_", self.plugin) + ".jsonl")
            if os.path.exists(path) and os.path.getsize(path) > _MAX_BYTES:
                return
            now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            event = {"v": 1, "t": now, "plugin": self.plugin}
            if self.version:
                event["ver"] = self.version
            event["app"] = "blender"
            event["ev"] = ev
            if name:
                event["name"] = str(name)
            if ms is not None and ms >= 0:
                event["ms"] = int(round(ms))
            with open(path, "a", encoding="utf-8") as f:
                f.write(json.dumps(event, ensure_ascii=True, separators=(",", ":")) + "\n")
        except Exception:
            # Usage must never get in the way of the add-on.
            pass

    def open(self):
        self._write("open")

    def action(self, name, ms=None):
        self._write("action", name, ms)

    def error(self, name):
        self._write("error", name)

    def track(self, name):
        """Decorator: counts each call as the feature `name`, with its duration.

        An operator that returns {'CANCELLED'} is not counted; an exception
        counts an error and is raised on.
        """

        def decorate(fn):
            @functools.wraps(fn)
            def wrapper(*args, **kwargs):
                start = time.perf_counter()
                try:
                    result = fn(*args, **kwargs)
                except Exception:
                    self.error(name)
                    raise
                if not (isinstance(result, set) and "CANCELLED" in result):
                    self.action(name, (time.perf_counter() - start) * 1000)
                return result

            return wrapper

        return decorate
```
