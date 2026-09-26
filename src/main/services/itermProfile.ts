import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ItermTerminalProfile } from "../../shared/contracts";

const execFileAsync = promisify(execFile);

const ANSI_KEYS = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow",
  "brightBlue", "brightMagenta", "brightCyan", "brightWhite"
] as const;

const THEME_KEYS: Array<[string, string]> = [
  ["background", "Background Color"],
  ["foreground", "Foreground Color"],
  ["cursor", "Cursor Color"],
  ["cursorAccent", "Cursor Text Color"],
  ["selectionBackground", "Selection Color"],
  ...ANSI_KEYS.map((key, index): [string, string] => [key, `Ansi ${index} Color`])
];

let cached: Promise<ItermTerminalProfile | null> | null = null;

// ponytail: read once per app run; restart CanvasTTY after changing the iTerm2 profile.
export function readItermProfile(): Promise<ItermTerminalProfile | null> {
  cached ??= loadItermProfile().catch((error: unknown) => {
    console.warn("CanvasTTY could not read the iTerm2 profile.", error);
    return null;
  });
  return cached;
}

async function loadItermProfile(): Promise<ItermTerminalProfile | null> {
  if (process.platform !== "darwin") return null;
  const plist = join(homedir(), "Library/Preferences/com.googlecode.iterm2.plist");
  // The whole plist has Data/Date values JSON cannot hold, so extract only the parts we need.
  const extract = async (key: string, format: "json" | "raw"): Promise<string> =>
    (await execFileAsync("/usr/bin/plutil", ["-extract", key, format, "-o", "-", plist])).stdout;
  const [bookmarks, defaultGuid] = await Promise.all([
    extract("New Bookmarks", "json"),
    extract("Default Bookmark Guid", "raw").catch(() => "")
  ]);
  return itermProfileFromBookmarks(JSON.parse(bookmarks), defaultGuid.trim());
}

type Bookmark = Record<string, unknown>;

export function itermProfileFromBookmarks(bookmarks: unknown, defaultGuid: string): ItermTerminalProfile | null {
  if (!Array.isArray(bookmarks)) return null;
  const profile = (bookmarks.find((item: Bookmark) => item?.Guid === defaultGuid) ?? bookmarks[0]) as Bookmark | undefined;
  if (!profile || typeof profile !== "object") return null;

  // CanvasTTY cards are always dark, so prefer the dark variant when the profile has both.
  const separate = profile["Use Separate Colors for Light and Dark Mode"] === true;
  const theme: Record<string, string> = {};
  for (const [themeKey, itermKey] of THEME_KEYS) {
    const color = colorToHex(separate ? profile[`${itermKey} (Dark)`] ?? profile[itermKey] : profile[itermKey]);
    if (color) theme[themeKey] = color;
  }
  if (!theme.background || !theme.foreground) return null;
  // Selection must stay translucent so the selected text remains readable.
  if (theme.selectionBackground) theme.selectionBackground += "80";

  const { fontFamily, fontSize } = parseFont(profile["Normal Font"]);
  return { theme, fontFamily, fontSize };
}

// ponytail: components are treated as sRGB even for P3/Calibrated colors; the shift is barely visible.
function colorToHex(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const color = value as Record<string, unknown>;
  const channels = ["Red Component", "Green Component", "Blue Component"].map((key) => color[key]);
  if (!channels.every((channel) => typeof channel === "number" && Number.isFinite(channel))) return null;
  return `#${(channels as number[])
    .map((channel) => Math.round(Math.min(1, Math.max(0, channel)) * 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

/** "MesloLGS-NF-Regular 14" → CSS family list that matches both the family and PostScript name. */
function parseFont(value: unknown): { fontFamily: string | null; fontSize: number | null } {
  if (typeof value !== "string") return { fontFamily: null, fontSize: null };
  const match = /^(\S+)\s+(\d+(?:\.\d+)?)$/.exec(value.trim());
  if (!match) return { fontFamily: null, fontSize: null };
  const postScript = match[1];
  const family = postScript.replace(/-(Regular|Book|Medium|Light|Roman)$/i, "").replace(/-/g, " ");
  const size = Number(match[2]);
  return {
    fontFamily: `"${family}", "${postScript}"`,
    fontSize: size >= 6 && size <= 72 ? size : null
  };
}
