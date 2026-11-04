// Makes public/overview.js: each field app's own calculation engine with a small overview per app
// (tools/overview-entry.ts), so the Console's "Overview" of an app at a company shows the figures
// the app itself shows.
//
//   node tools/bundle-overview.mjs            (apps found next to this folder, see APPS below)
//   AR_APPS=/path/to/"AR Apps" node tools/bundle-overview.mjs
//
// Run it whenever an app changes its calculations, then commit public/overview.js.
// Each app folder must be on its `oracle` branch.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const AR_APPS = process.env.AR_APPS || path.resolve(ROOT, "..", "AR Apps");
// The AR apps (their calculations are the KISEM apps', unchanged; see clients/kisem-port).
const APPS = {
  thermo: path.join(AR_APPS, "ares-boiler"),
  acmp: path.join(AR_APPS, "ares-air"),
  mla: path.join(AR_APPS, "ares-mla"),
  pump: path.join(AR_APPS, "ares-pump"),
  cool: path.join(AR_APPS, "ares-cooling"),
  xmer: path.join(AR_APPS, "ares-xmer"),
  light: path.join(AR_APPS, "ares-light"),
  dryer: path.join(AR_APPS, "ares-dryer"),
};

const version = [];
for (const [code, dir] of Object.entries(APPS)) {
  if (!fs.existsSync(dir)) throw new Error(`${code}: app folder not found at ${dir}`);
  const git = (cmd) => execSync(`git ${cmd}`, { cwd: dir }).toString().trim();
  const branch = git("branch --show-current");
  if (branch !== "oracle") throw new Error(`${code}: ${dir} is on "${branch}", not "oracle"`);
  version.push(`${code}@${git("rev-parse --short HEAD")}`);
}

const appOf = (file) => Object.entries(APPS).find(([, d]) => path.resolve(file).startsWith(path.resolve(d) + path.sep));
const STUB = path.join(HERE, "overview-stubs.js");
const resolveTs = (base) => {
  for (const ext of ["", ".ts", ".tsx", ".js", "/index.ts"]) if (fs.existsSync(base + ext) && fs.statSync(base + ext).isFile()) return base + ext;
  throw new Error(`cannot resolve ${base}`);
};
const zustand = (p) => {
  const pkg = path.join(ROOT, "node_modules", "zustand");
  if (p === "zustand") return path.join(pkg, "esm", "index.mjs");
  const sub = p.split("/").slice(1).join("/");
  for (const c of [path.join(pkg, "esm", sub + ".mjs"), path.join(pkg, "esm", sub, "index.mjs")]) if (fs.existsSync(c)) return c;
  throw new Error(`zustand: cannot resolve ${p}`);
};

const plugin = {
  name: "ares-apps",
  setup(b) {
    b.onResolve({ filter: /^@(thermo|acmp|mla|pump|cool|xmer|light|dryer)\// }, (a) => {
      const [, code, rest] = /^@([a-z]+)\/(.*)$/.exec(a.path);
      return { path: resolveTs(path.join(APPS[code], rest)) };
    });
    b.onResolve({ filter: /^@\// }, (a) => {
      const app = appOf(a.importer);
      if (!app) throw new Error(`"@/" import outside an app: ${a.importer}`);
      return { path: resolveTs(path.join(app[1], a.path.slice(2))) };
    });
    b.onResolve({ filter: /^zustand(\/.*)?$/ }, (a) => ({ path: zustand(a.path) }));
    b.onResolve({ filter: /^(@capacitor\/.*|idb-keyval|sonner|react|react-dom|react\/jsx-runtime|next\/.*|lucide-react)$/ }, () => ({ path: STUB }));
  },
};

const out = path.join(ROOT, "public", "overview.js");
await build({
  entryPoints: [path.join(HERE, "overview-entry.ts")],
  bundle: true, format: "iife", platform: "browser", target: "es2019", minify: true, legalComments: "none",
  outfile: out, plugins: [plugin], define: { "process.env.NODE_ENV": '"production"' }, logLevel: "warning",
});
fs.writeFileSync(out, fs.readFileSync(out, "utf8").replace("__OVERVIEW_VERSION__", version.join(" ")));
console.log(`wrote ${path.relative(ROOT, out)}  ${(fs.statSync(out).size / 1024).toFixed(0)} KB\n  ${version.join("\n  ")}`);
