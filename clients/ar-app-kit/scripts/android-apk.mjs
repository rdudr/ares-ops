// Builds this AR app's Android APK, the same way on a laptop and on GitHub Actions.
//
//   node scripts/android-apk.mjs                     version from package.json
//   node scripts/android-apk.mjs --version 0.2.14    CI: major.minor from package.json + run number
//   node scripts/android-apk.mjs --publish <dir>     also adds it to a checkout of the APK repo
//
// Steps: static export (npm run build:mobile) -> Capacitor Android project (generated, never
// committed) -> launcher icons -> version stamped into Gradle -> signed release build ->
// releases/<apk name>-v<version>.apk.
//
// Signing: every build of every AR app is signed with the one AR Enterprise key, so an update
// installs over the previous version and keeps the data on the device. The key is never in a repo:
// it comes from AR_KEYSTORE (path) or AR_KEYSTORE_BASE64, with AR_KEYSTORE_PASSWORD, AR_KEY_ALIAS and
// AR_KEY_PASSWORD; on a laptop these can sit in ~/.ar-enterprise/android-signing/signing.env.
// Without a key the script makes a debug build for testing only, which is never published.
import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";

const root = process.cwd();
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const win = process.platform === "win32";
const run = (cmd, cwd = root, env = process.env) => execSync(cmd, { stdio: "inherit", cwd, env });

// --- Identity: lib/ares/app-config.ts is the one place an app names itself.
const cfgSrc = fs.readFileSync(path.join(root, "lib/ares/app-config.ts"), "utf8");
const field = (k) => { const m = cfgSrc.match(new RegExp(`${k}:\\s*("(?:[^"\\\\]|\\\\.)*")`)); return m ? JSON.parse(m[1]) : undefined; };
const APP = { code: field("code"), name: field("name"), tagline: field("tagline"), apk: field("apk") };
if (!APP.code || !APP.name || !APP.apk) throw new Error("lib/ares/app-config.ts needs code, name and apk");

// --- Version: package.json, or --version (written into package.json for the build so the app's
// update check knows which version it is, then put back).
const pkgPath = path.join(root, "package.json");
const pkgText = fs.readFileSync(pkgPath, "utf8");
const version = opt("version") || JSON.parse(pkgText).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Version must look like 1.2.3, got ${version}`);
const [maj, min, pat] = version.split(".").map(Number);
const versionCode = maj * 1_000_000 + min * 10_000 + pat; // always grows with the version

// --- Tools: JDK 21 and the Android SDK (Android Studio's bundled JDK works).
const env = { ...process.env };
const studioJdk = win ? "C:/Program Files/Android/Android Studio/jbr" : "/Applications/Android Studio.app/Contents/jbr/Contents/Home";
const javaMajor = (home) => { try { return Number(fs.readFileSync(path.join(home, "release"), "utf8").match(/JAVA_VERSION="(\d+)/)[1]); } catch { return 0; } };
if ((!env.JAVA_HOME || javaMajor(env.JAVA_HOME) < 21) && fs.existsSync(studioJdk)) env.JAVA_HOME = studioJdk; // Capacitor 8 needs JDK 21
const sdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT || (win ? path.join(os.homedir(), "AppData/Local/Android/Sdk") : path.join(os.homedir(), "Library/Android/sdk"));
env.ANDROID_HOME = sdk;

// --- Signing key.
const signingDir = path.join(os.homedir(), ".ar-enterprise", "android-signing");
const signingEnv = path.join(signingDir, "signing.env");
if (!env.AR_KEYSTORE && !env.AR_KEYSTORE_BASE64 && fs.existsSync(signingEnv)) {
  for (const line of fs.readFileSync(signingEnv, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2];
  }
  if (env.AR_KEYSTORE && !path.isAbsolute(env.AR_KEYSTORE)) env.AR_KEYSTORE = path.join(signingDir, env.AR_KEYSTORE);
}
if (!env.AR_KEYSTORE && env.AR_KEYSTORE_BASE64) {
  env.AR_KEYSTORE = path.join(os.tmpdir(), `ar-release-${process.pid}.jks`);
  fs.writeFileSync(env.AR_KEYSTORE, Buffer.from(env.AR_KEYSTORE_BASE64, "base64"));
}
const signed = !!(env.AR_KEYSTORE && env.AR_KEYSTORE_PASSWORD && env.AR_KEY_ALIAS && env.AR_KEY_PASSWORD);
if (!signed) console.warn("No AR signing key found: making a DEBUG build for testing. It will not be published.");
if (opt("publish") && !signed) throw new Error("Publishing needs the AR signing key (see the top of this script).");

// --- 1. Static export with the version baked in.
if (opt("version")) {
  const pkg = JSON.parse(pkgText);
  pkg.version = version;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
}
try {
  run("npm run build:mobile", root, env);
} finally {
  if (opt("version") && !process.env.CI) fs.writeFileSync(pkgPath, pkgText);
}

// --- 2. Android project (generated from capacitor.config.ts each time it is missing).
const npx = win ? "npx.cmd" : "npx";
const android = path.join(root, "android");
if (!fs.existsSync(android)) run(`${npx} cap add android`, root, env);
run(`${npx} cap sync android`, root, env);
fs.writeFileSync(path.join(android, "local.properties"), `sdk.dir=${sdk.replace(/\\/g, "/")}\n`);
run("node scripts/generate-icons.mjs", root, env);

// --- 3. Version and signing in Gradle. The key is read from the environment at build time.
const gradlePath = path.join(android, "app", "build.gradle");
let gradle = fs.readFileSync(gradlePath, "utf8");
gradle = gradle.replace(/versionCode\s+\d+/, `versionCode ${versionCode}`).replace(/versionName\s+"[^"]*"/, `versionName "${version}"`);
if (!gradle.includes("// AR signing")) {
  gradle = gradle.replace(/(\n\s*)buildTypes\s*\{/, `$1// AR signing: the key comes from the environment, never from this file.$1signingConfigs {$1    release {$1        if (System.getenv("AR_KEYSTORE")) {$1            storeFile file(System.getenv("AR_KEYSTORE"))$1            storePassword System.getenv("AR_KEYSTORE_PASSWORD")$1            keyAlias System.getenv("AR_KEY_ALIAS")$1            keyPassword System.getenv("AR_KEY_PASSWORD")$1        }$1    }$1}$1buildTypes {`);
  gradle = gradle.replace(/(buildTypes\s*\{\s*\n(\s*)release\s*\{)/, `$1\n$2    signingConfig signingConfigs.release`);
  if (!gradle.includes("signingConfig signingConfigs.release")) throw new Error("Could not add signing to android/app/build.gradle");
}
fs.writeFileSync(gradlePath, gradle);

// --- 4. Build.
const task = signed ? "assembleRelease" : "assembleDebug";
run(`"${path.join(android, win ? "gradlew.bat" : "gradlew")}" ${task} --no-daemon -q`, android, env);
const built = path.join(android, "app", "build", "outputs", "apk", signed ? "release" : "debug", signed ? "app-release.apk" : "app-debug.apk");
if (!fs.existsSync(built)) throw new Error(`Gradle finished but ${built} is missing`);

const outDir = path.join(root, "releases");
fs.mkdirSync(outDir, { recursive: true });
const file = `${APP.apk}-v${version}${signed ? "" : "-debug"}.apk`;
const apk = path.join(outDir, file);
fs.copyFileSync(built, apk);
if (env.AR_KEYSTORE_BASE64 && env.AR_KEYSTORE.startsWith(os.tmpdir())) fs.rmSync(env.AR_KEYSTORE, { force: true });
console.log(`APK ready: ${apk} (${(fs.statSync(apk).size / 1e6).toFixed(1)} MB, version ${version}, code ${versionCode})`);

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `apk=${apk}\nfile=${file}\nversion=${version}\ncode=${APP.code}\nname=${APP.name}\n`);
}

// --- 5. Optional: add it to a checkout of the APK repo (the caller commits and pushes).
const repo = opt("publish");
if (repo) {
  const commit = (() => { try { return execSync("git rev-parse --short HEAD", { cwd: root }).toString().trim(); } catch { return ""; } })();
  const icon = path.join(root, "public", "icon-192.png");
  const q = (s) => JSON.stringify(String(s));
  run(`node tools/publish.mjs --apk ${q(apk)} --code ${q(APP.code)} --name ${q(APP.name)} --app-config ${q(path.join(root, "lib/ares/app-config.ts"))} --version ${version} --icon ${q(icon)} --commit ${q(commit)}`, path.resolve(repo), env);
}
