import { useEffect, useRef, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { LocaleId, Point, SessionBounds, StickyNote, StickyNoteKind } from "../../../../shared/contracts";
import { UiIcon } from "../../components/UiIcon";
import { t } from "../../lib/i18n";
import { snapMove, snapResize, type ResizeDirection } from "../workspace/snap";
import {
  constrainStickyNoteResize,
  MAX_STICKY_NOTE_SIZE,
  MIN_STICKY_NOTE_SIZE
} from "./stickyNoteBounds";

interface StickyNoteCardProps {
  note: StickyNote;
  locale: LocaleId;
  zoom: number;
  stackIndex: number;
  editRequest: number;
  snapEnabled: boolean;
  snapTargets: readonly SessionBounds[];
  onBoundsChange(id: string, bounds: SessionBounds): void;
  onTextChange(id: string, text: string): void;
  onClose(id: string): void;
  /** True while this card is part of the marquee selection. */
  groupSelected?: boolean;
}

interface DragState {
  pointerId: number;
  startClient: Point;
  startBounds: SessionBounds;
}

interface ResizeState extends DragState {
  direction: ResizeDirection;
}

const RESIZE_DIRECTIONS: ResizeDirection[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];

type FileCardKind = Exclude<StickyNoteKind, "text">;

// Content returned by the picker, so a new card renders before its settings save reaches main.
// ponytail: never evicted; one entry per card picked this run.
const pickedContent = new Map<string, string>();

/** Opens the file picker for a media/Obsidian card; resolves to the chosen path or null. */
export async function pickCardFile(kind: FileCardKind): Promise<string | null> {
  try {
    if (kind === "media") {
      const picked = await window.canvasTTY.dialog.pickMedia();
      if (picked) pickedContent.set(picked.path, picked.dataUrl);
      return picked?.path ?? null;
    }
    const picked = await window.canvasTTY.dialog.pickMarkdown();
    if (picked) pickedContent.set(picked.path, picked.text);
    return picked?.path ?? null;
  } catch (error) {
    console.error("CanvasTTY could not open the card file.", error);
    return null;
  }
}

function readCardFile(kind: FileCardKind, path: string): Promise<string | null> {
  return kind === "media" ? window.canvasTTY.media.read(path) : window.canvasTTY.markdown.read(path);
}

// Links must leave the app: a plain <a> would navigate the CanvasTTY window itself.
const MARKDOWN_COMPONENTS: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault();
        if (!href) return;
        window.canvasTTY.external.openUrl(href).catch((error: unknown) => {
          console.warn("CanvasTTY could not open the note link.", error);
        });
      }}
    >{children}</a>
  )
};

function fileName(path: string): string {
  return path.split(/[\\/]/).pop()?.replace(/\.md$/i, "") ?? path;
}

// Interaction behavior is adapted from @TroopJostle's StickyNoteCard in PR #23.
export function StickyNoteCard({
  note,
  locale,
  zoom,
  stackIndex,
  editRequest,
  snapEnabled,
  snapTargets,
  onBoundsChange,
  onTextChange,
  onClose,
  groupSelected = false
}: StickyNoteCardProps): React.JSX.Element {
  const editor = useRef<HTMLTextAreaElement>(null);
  const dragState = useRef<DragState | null>(null);
  const resizeState = useRef<ResizeState | null>(null);
  const textSaveTimer = useRef<number | null>(null);
  const persistedText = useRef(note.text);
  const pendingText = useRef(note.text);
  const onTextChangeRef = useRef(onTextChange);
  const initialBounds = { position: note.position, size: note.size };
  const liveBounds = useRef<SessionBounds>(initialBounds);
  const [position, setPosition] = useState(note.position);
  const [size, setSize] = useState(note.size);
  const [text, setText] = useState(note.text);
  const kind = note.kind ?? "text";
  const filePath = note.filePath;
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [fileError, setFileError] = useState<"read" | "write" | "open" | null>(null);
  const [editing, setEditing] = useState(false);
  const showEditor = kind === "text" || editing;
  onTextChangeRef.current = onTextChange;

  // Obsidian cards save into their Markdown file; plain notes save into settings.
  const persist = (value: string): void => {
    if (kind !== "obsidian" || !filePath) {
      onTextChangeRef.current(note.id, value);
      return;
    }
    window.canvasTTY.markdown.write(filePath, value).then(
      () => setFileError(null),
      (error: unknown) => {
        console.error("CanvasTTY could not save the Obsidian note.", error);
        setFileError("write");
      }
    );
  };
  const persistRef = useRef(persist);
  persistRef.current = persist;

  useEffect(() => {
    if (kind === "text" || !filePath) return;
    let active = true;
    const apply = (content: string | null): void => {
      if (!active) return;
      if (content === null) {
        setFileError("read");
        return;
      }
      setFileError(null);
      if (kind === "media") {
        setMediaUrl(content);
        return;
      }
      persistedText.current = content;
      pendingText.current = content;
      setText(content);
    };
    const load = (fresh: boolean): void => {
      const picked = fresh ? undefined : pickedContent.get(filePath);
      (picked !== undefined ? Promise.resolve(picked) : readCardFile(kind, filePath))
        .then(apply, () => apply(null));
    };
    load(false);
    if (kind !== "obsidian") return () => {
      active = false;
    };
    // Pick up edits made in Obsidian when the user comes back, unless this card has unsaved typing.
    const refresh = (): void => {
      if (pendingText.current === persistedText.current) load(true);
    };
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
    };
  }, [kind, filePath]);

  useEffect(() => {
    const bounds = { position: note.position, size: note.size };
    liveBounds.current = bounds;
    setPosition(bounds.position);
    setSize(bounds.size);
  }, [note.position, note.size]);

  useEffect(() => {
    persistedText.current = note.text;
    pendingText.current = note.text;
    setText(note.text);
  }, [note.text]);

  useEffect(() => {
    if (editRequest <= 0) return;
    const frame = window.requestAnimationFrame(() => {
      const element = editor.current;
      if (!element) return;
      element.focus({ preventScroll: true });
      element.setSelectionRange(element.value.length, element.value.length);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [editRequest]);

  useEffect(() => () => {
    if (textSaveTimer.current !== null) window.clearTimeout(textSaveTimer.current);
    if (pendingText.current !== persistedText.current) {
      persistRef.current(pendingText.current);
    }
  }, [note.id]);

  const saveText = (nextText: string): void => {
    if (textSaveTimer.current !== null) window.clearTimeout(textSaveTimer.current);
    textSaveTimer.current = null;
    if (nextText === persistedText.current) return;
    persistedText.current = nextText;
    persist(nextText);
  };

  const changeText = (nextText: string): void => {
    pendingText.current = nextText;
    setText(nextText);
    if (textSaveTimer.current !== null) window.clearTimeout(textSaveTimer.current);
    textSaveTimer.current = window.setTimeout(() => saveText(nextText), 400);
  };

  const applyBounds = (bounds: SessionBounds): void => {
    liveBounds.current = bounds;
    setPosition(bounds.position);
    setSize(bounds.size);
  };

  const startDrag = (event: React.PointerEvent<HTMLElement>): void => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button, input, textarea")) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragState.current = {
      pointerId: event.pointerId,
      startClient: { x: event.clientX, y: event.clientY },
      startBounds: liveBounds.current
    };
  };

  const drag = (event: React.PointerEvent<HTMLElement>): void => {
    const state = dragState.current;
    if (!state || state.pointerId !== event.pointerId) return;
    // A buttonless move is a hover, not a drag.
    if (event.buttons === 0) return;
    const rawPosition = {
      x: state.startBounds.position.x + (event.clientX - state.startClient.x) / zoom,
      y: state.startBounds.position.y + (event.clientY - state.startClient.y) / zoom
    };
    applyBounds({
      position: snapEnabled ? snapMove(rawPosition, state.startBounds.size, snapTargets) : rawPosition,
      size: state.startBounds.size
    });
  };

  const endDrag = (event: React.PointerEvent<HTMLElement>): void => {
    if (dragState.current?.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    dragState.current = null;
    onBoundsChange(note.id, liveBounds.current);
  };

  // A group drag takes pointer capture without a pointerup; drop local state so a
  // later hover cannot act on it.
  const cancelDrag = (): void => {
    dragState.current = null;
  };

  const cancelResize = (): void => {
    resizeState.current = null;
  };

  const startResize = (event: React.PointerEvent<HTMLDivElement>, direction: ResizeDirection): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeState.current = {
      pointerId: event.pointerId,
      direction,
      startClient: { x: event.clientX, y: event.clientY },
      startBounds: liveBounds.current
    };
  };

  const resize = (event: React.PointerEvent<HTMLDivElement>): void => {
    const state = resizeState.current;
    if (!state || state.pointerId !== event.pointerId) return;
    // A buttonless move is a hover, not a resize.
    if (event.buttons === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const deltaX = (event.clientX - state.startClient.x) / zoom;
    const deltaY = (event.clientY - state.startClient.y) / zoom;
    const constrained = constrainStickyNoteResize({
      position: {
        x: state.startBounds.position.x + (state.direction.includes("w") ? deltaX : 0),
        y: state.startBounds.position.y + (state.direction.includes("n") ? deltaY : 0)
      },
      size: {
        width: state.startBounds.size.width
          + (state.direction.includes("e") ? deltaX : 0)
          - (state.direction.includes("w") ? deltaX : 0),
        height: state.startBounds.size.height
          + (state.direction.includes("s") ? deltaY : 0)
          - (state.direction.includes("n") ? deltaY : 0)
      }
    }, state.direction);
    applyBounds(snapEnabled
      ? snapResize(constrained, state.direction, snapTargets, {
          min: MIN_STICKY_NOTE_SIZE,
          max: MAX_STICKY_NOTE_SIZE
        })
      : constrained);
  };

  const endResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (resizeState.current?.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    resizeState.current = null;
    onBoundsChange(note.id, liveBounds.current);
  };

  return (
    <article
      className={`sticky-note-card sticky-note-card--${kind} ${groupSelected ? "sticky-note-card--selected" : ""}`}
      data-interactive="true"
      data-sticky-note-id={note.id}
      data-canvas-layer-id={`note:${note.id}`}
      data-wheel-owner="local"
      style={{
        zIndex: stackIndex,
        width: size.width,
        height: size.height,
        transform: `translate(${position.x}px, ${position.y}px)`
      }}
    >
      <header
        className="sticky-note-card__header"
        onPointerDown={startDrag}
        onPointerMove={drag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={cancelDrag}
      >
        <span title={filePath}>
          <UiIcon name={kind === "media" ? "image-plus" : kind === "obsidian" ? "pencil" : "sticky-note"} size="1.15em" />
          <span className="sticky-note-card__title">{filePath ? fileName(filePath) : t(locale, "stickyNote")}</span>
        </span>
        {kind === "obsidian" && filePath && (
          <span className="sticky-note-card__actions">
            <button
              className="sticky-note-card__close"
              type="button"
              onClick={() => {
                if (editing) saveText(text);
                setEditing((current) => !current);
              }}
              title={t(locale, editing ? "previewNote" : "editNote")}
              aria-label={t(locale, editing ? "previewNote" : "editNote")}
              aria-pressed={editing}
            >
              <UiIcon name={editing ? "done" : "pencil"} size="1.1em" />
            </button>
            <button
              className="sticky-note-card__close"
              type="button"
              onClick={() => {
                window.canvasTTY.markdown.openInObsidian(filePath).catch((error: unknown) => {
                  console.error("CanvasTTY could not open Obsidian.", error);
                  setFileError("open");
                });
              }}
              title={t(locale, "openInObsidian")}
              aria-label={t(locale, "openInObsidian")}
            >
              <UiIcon name="arrow" size="1.1em" />
            </button>
          </span>
        )}
        <button
          className="sticky-note-card__close"
          type="button"
          onClick={() => {
            saveText(text);
            onClose(note.id);
          }}
          title={t(locale, "close")}
          aria-label={t(locale, "close")}
        >
          <UiIcon name="close" size="1.23em" />
        </button>
      </header>
      {fileError && (
        <p className="sticky-note-card__status" role="alert">
          {t(locale, fileError === "read" ? "cardFileUnavailable" : fileError === "open" ? "obsidianOpenFailed" : "obsidianSaveFailed")}
        </p>
      )}
      {kind === "media" ? (
        mediaUrl && <img className="sticky-note-card__media" src={mediaUrl} alt={filePath ? fileName(filePath) : ""} draggable={false} />
      ) : kind === "obsidian" && fileError !== "read" && !editing ? (
        <div
          className="sticky-note-card__markdown"
          onDoubleClick={() => setEditing(true)}
          title={t(locale, "editNote")}
        >
          <Markdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>{text}</Markdown>
        </div>
      ) : (kind === "text" || fileError !== "read") && showEditor && (
      <textarea
        autoFocus={kind === "obsidian"}
        ref={editor}
        className="sticky-note-card__editor"
        value={text}
        maxLength={kind === "text" ? 20_000 : undefined}
        placeholder={t(locale, "stickyNotePlaceholder")}
        aria-label={t(locale, "stickyNote")}
        onChange={(event) => changeText(event.target.value)}
        onBlur={() => {
          saveText(text);
          if (kind === "obsidian") setEditing(false);
        }}
      />
      )}
      {RESIZE_DIRECTIONS.map((direction) => (
        <div
          key={direction}
          className={`terminal-card__resize-handle terminal-card__resize-handle--${direction}`}
          aria-hidden="true"
          onPointerDown={(event) => startResize(event, direction)}
          onPointerMove={resize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          onLostPointerCapture={cancelResize}
        />
      ))}
    </article>
  );
}
