// Local header verification helper.
// The Firebase Hosting emulator (firebase-tools 15.x) does not apply custom
// `headers` from firebase.json, so we run superstatic directly against the same
// hosting config to verify the CSP / security headers that production will serve.
const path = require("path");
const superstatic = require(
  "C:/Users/VICTUS/AppData/Roaming/npm/node_modules/firebase-tools/node_modules/superstatic"
);
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
