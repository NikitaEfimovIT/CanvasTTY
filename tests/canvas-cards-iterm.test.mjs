import assert from "node:assert/strict";
import test from "node:test";
import { normalizeStickyNotes } from "../src/main/services/SettingsStore.ts";
import { itermProfileFromBookmarks } from "../src/main/services/itermProfile.ts";

const bounds = { position: { x: 0, y: 0 }, size: { width: 300, height: 220 } };
const id = (n) => `00000000-0000-4000-8000-00000000000${n}`;

test("keeps media/obsidian cards with absolute paths and drops unsafe ones", () => {
  const notes = normalizeStickyNotes([
    { id: id(1), text: "", kind: "media", filePath: "/tmp/cards/cat.gif", ...bounds },
    { id: id(2), text: "", kind: "obsidian", filePath: "/tmp/cards/vault/Today.md", ...bounds },
    { id: id(3), text: "", kind: "obsidian", filePath: "../relative.md", ...bounds },
    { id: id(4), text: "", kind: "media", ...bounds },
    { id: id(5), text: "plain", kind: "bogus", filePath: "/x", ...bounds },
    { id: id(6), text: "", kind: "media-folder", filePath: "/tmp/cards/wallpapers", ...bounds }
  ]);
  assert.deepEqual(notes.map((note) => [note.id, note.kind, note.filePath]), [
    [id(1), "media", "/tmp/cards/cat.gif"],
    [id(2), "obsidian", "/tmp/cards/vault/Today.md"],
    [id(5), undefined, undefined],
    [id(6), "media-folder", "/tmp/cards/wallpapers"]
  ]);
});

const rgb = (r, g, b) => ({ "Red Component": r, "Green Component": g, "Blue Component": b, "Color Space": "sRGB" });

test("reads the default iTerm2 profile, preferring dark colors", () => {
  const profile = itermProfileFromBookmarks([
    { Guid: "other", "Background Color": rgb(1, 0, 0), "Foreground Color": rgb(0, 0, 0) },
    {
      Guid: "main",
      "Use Separate Colors for Light and Dark Mode": true,
      "Background Color": rgb(0.98, 0.98, 0.98),
      "Background Color (Dark)": rgb(0, 0, 0),
      "Foreground Color (Dark)": rgb(1, 1, 1),
      "Ansi 1 Color": rgb(1, 0, 0),
      "Selection Color (Dark)": rgb(0, 0, 1),
      "Normal Font": "MesloLGS-NF-Regular 14"
    }
  ], "main");
  assert.equal(profile.theme.background, "#000000");
  assert.equal(profile.theme.foreground, "#ffffff");
  assert.equal(profile.theme.red, "#ff0000");
  assert.equal(profile.theme.selectionBackground, "#0000ff80");
  assert.equal(profile.fontFamily, '"MesloLGS NF", "MesloLGS-NF-Regular"');
  assert.equal(profile.fontSize, 14);
});

test("returns null without usable colors", () => {
  assert.equal(itermProfileFromBookmarks([{ Guid: "a" }], "a"), null);
  assert.equal(itermProfileFromBookmarks("nope", ""), null);
});
