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
