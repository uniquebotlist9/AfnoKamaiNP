// Local header verification helper.
// The Firebase Hosting emulator (firebase-tools 15.x) does not apply custom
// `headers` from firebase.json, so we run superstatic directly against the same
// hosting config to verify the CSP / security headers that production will serve.
//
// Windows note: superstatic normalizes glob sources and request paths with
// glob-slash, which calls win32 `path.normalize`, turning "/sw.js" into
// "\sw.js". superstatic's bundled minimatch does not match backslash globs, so
// on win32 every header pattern silently fails and this probe reports "no
// headers" for a config that is actually correct. Firebase Hosting applies
// headers on Linux, so we pin glob-slash to POSIX semantics here to reproduce
// production behavior. Without this the probe gives false negatives.
const fs = require("fs");
const path = require("path");

// superstatic ships inside firebase-tools' global install (the repo has no
// local copy). Try the usual global roots before falling back to the known
// install path.
const candidates = [
  process.env.APPDATA &&
    path.join(process.env.APPDATA, "npm", "node_modules", "firebase-tools", "node_modules", "superstatic"),
  process.env.ProgramFiles &&
    path.join(process.env.ProgramFiles, "nodejs", "node_modules", "firebase-tools", "node_modules", "superstatic"),
  "C:/Users/VICTUS/AppData/Roaming/npm/node_modules/firebase-tools/node_modules/superstatic",
].filter((p) => p && fs.existsSync(p));

if (!candidates.length) {
  console.error("headers-probe: superstatic not found inside firebase-tools");
  process.exit(1);
}
const SUPERSTATIC_ROOT = candidates[0];

// Resolve glob-slash from superstatic's own dependency tree and pre-seed the
// module cache with a POSIX implementation before superstatic is loaded
// (superstatic captures the reference at require time).
const globSlashPath = require.resolve("glob-slash", {
  paths: [path.join(SUPERSTATIC_ROOT, "lib")],
});
if (process.platform === "win32") {
  const posixNormalize = (value) =>
    path.posix.normalize(path.posix.join("/", value));
  const posixGlobSlash = (value) =>
    value.charAt(0) === "!" ? "!" + posixNormalize(value.substr(1)) : posixNormalize(value);
  posixGlobSlash.normalize = posixNormalize;
  require.cache[globSlashPath] = {
    id: globSlashPath,
    filename: globSlashPath,
    loaded: true,
    exports: posixGlobSlash,
  };
}

const superstatic = require(SUPERSTATIC_ROOT);
const fb = require(path.join(__dirname, "..", "firebase.json"));
const hosting = Array.isArray(fb.hosting) ? fb.hosting[0] : fb.hosting;

const server = superstatic.server({
  debug: false,
  port: process.env.PORT || 5007,
  config: hosting,
  compression: true,
  cwd: path.join(__dirname, ".."),
  stack: "strict",
});

server.listen(() => {
  console.log("headers-probe listening on", process.env.PORT || 5007);
});
