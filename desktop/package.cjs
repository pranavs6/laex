// Builds LAEX.app (macOS) or a LAEX folder (Linux) into desktop/dist.
// The app is a thin shell: it runs the laex checkout it was built from, so
// updating the checkout updates the app.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { packager } = require("@electron/packager");

const here = __dirname;
const root = path.resolve(here, "..");
fs.writeFileSync(path.join(here, "laex-root.json"), JSON.stringify({ root }, null, 2));

let icon;
if (process.platform === "darwin") {
  // .icns from icon.png via iconutil.
  const set = path.join(here, "dist", "icon.iconset");
  fs.mkdirSync(set, { recursive: true });
  for (const size of [16, 32, 64, 128, 256, 512]) {
    execFileSync("sips", ["-z", String(size), String(size), path.join(here, "icon.png"), "--out", path.join(set, `icon_${size}x${size}.png`)], { stdio: "ignore" });
    execFileSync("sips", ["-z", String(size * 2), String(size * 2), path.join(here, "icon.png"), "--out", path.join(set, `icon_${size}x${size}@2x.png`)], { stdio: "ignore" });
  }
  icon = path.join(here, "dist", "icon.icns");
  execFileSync("iconutil", ["-c", "icns", set, "-o", icon]);
}

packager({
  dir: here,
  name: "LAEX",
  out: path.join(here, "dist"),
  overwrite: true,
  icon,
  appBundleId: "local.laex",
  ignore: [/^\/dist($|\/)/, /^\/laex-root\.json\.example$/],
  prune: true,
}).then((paths) => {
  console.log(`Built ${paths.join(", ")}`);
  if (process.platform === "darwin") console.log("Drag LAEX.app into /Applications, or run: open desktop/dist/LAEX-darwin-*/LAEX.app");
});
