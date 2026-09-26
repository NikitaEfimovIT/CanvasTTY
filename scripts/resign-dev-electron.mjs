// macOS rejects notifications from the dev Electron.app because its downloaded
// signature does not validate. An ad-hoc re-sign fixes it; packaged builds are
// signed by electron-builder and never use this bundle.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

if (process.platform === "darwin") {
  const electronDir = dirname(createRequire(import.meta.url).resolve("electron/package.json"));
  const bundle = join(electronDir, "dist", "Electron.app");
  if (existsSync(bundle)) {
    try {
      execFileSync("codesign", ["--force", "--deep", "--sign", "-", bundle], { stdio: "inherit" });
    } catch (error) {
      // Only dev notifications depend on this; never fail the install over it.
      console.warn("Could not re-sign the dev Electron.app; dev notifications may not appear.", error.message);
    }
  }
}
