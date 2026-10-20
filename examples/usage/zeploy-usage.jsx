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
