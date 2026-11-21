'use strict';

// The vocabulary the layers above the platform speak. Nothing here runs: these are the shapes a
// shell implementation and its callers are checked against, so either side can be exercised
// without Electron and without a desktop.
//
// The three coordinate spaces share one layout and are still kept as separate types. A global DIP
// rect, an X pixel rect and an overlay-local rect are not interchangeable; the type in the name is
// what makes a mix-up visible where it happens instead of three layers later.

/** @typedef {{ x: number, y: number, w: number, h: number }} Rect */

/**
 * Global screen space in DIPs: what Electron's `screen` reports.
 * @typedef {Rect} DipRect
 */

/**
 * Pixels of the X screen. These never leave the X11 backend.
 * @typedef {Rect} PxRect
 */

/**
 * DIPs measured from the overlay's own top left corner: what the renderer is given.
 * @typedef {Rect} LocalRect
 */

/** @typedef {{ id: number, bounds: DipRect, workArea: DipRect, scale: number }} DisplayInfo */

/**
 * A value that can be watched. `last()` lets a late subscriber catch up without waiting for the
 * next change; a source with nothing to replay yet simply does not have it.
 * @template T
 * @typedef {{ subscribe(fn: (v: T) => void): () => void, last?(): T | undefined }} Observable
 */

/**
 * A window she can sit on. Already in DIPs, so no consumer converts anything.
 * @typedef {{ id: number, rect: DipRect, max: boolean }} Win
 */

/**
 * What is known about the game in front. The shape is not agreed yet, so it stays opaque: nothing
 * can lean on fields that are still moving.
 * @typedef {unknown} GameInfo
 */

/**
 * One snapshot of the desktop's windows. `rev` grows on every change, which is how a consumer
 * tells "nothing new" from "the same picture again" without serialising the frame to compare it.
 * @typedef {Object} WindowsFrame
 * @property {number} rev
 * @property {number} fg id of the focused window, 0 when there is none
 * @property {boolean} dock the focused window is a panel or a dock
 * @property {{ ai: string[], game: GameInfo | null }} front what the focused window is
 * @property {Win[]} wins front first, seats only
 * @property {DipRect | null} self where the compositor holds the overlay, when it tells us
 */

/**
 * Facts that change rarely, kept off the frame channel: a device list has no business riding
 * along with every window move.
 * @typedef {{ kind: 'devices', usb: string[], plug: object | null }} DevicesFact
 */

/**
 * What this backend can do, as reported by the backend itself rather than by a table kept beside
 * it. `screenshot` is the order to try the methods in; the first one that produces a picture wins.
 * @typedef {Object} Capabilities
 * @property {1 | 2} tier
 * @property {'kwin' | 'x11' | 'generic'} backend
 * @property {boolean} windows window tracking
 * @property {boolean} pointer global pointer position
 * @property {{ list: boolean, close: boolean }} apps
 * @property {boolean} hotkey a global hotkey the platform can own
 * @property {Array<'spectacle' | 'portal' | 'capturer'>} screenshot
 * @property {{ place: 'client' | 'compositor', stacking: 'client' | 'compositor', focus: 'client' | 'compositor', input: 'xshape' | 'toggle' | 'passthrough' }} overlay
 */

/**
 * Where the platform agent is in its life cycle. `degraded` is a working state with a retry
 * scheduled; `failed` is a refusal retrying cannot fix, a protocol mismatch for one.
 * @typedef {'idle' | 'starting' | 'ready' | 'degraded' | 'failed' | 'stopped'} AgentState
 */

/** @typedef {{ state: AgentState, reason?: string }} ShellHealth */

/**
 * A platform failure: an Error carrying a machine-readable `code` ('stopped' when the shell was
 * stopped under a pending request, 'agent-restarted', 'not-found'…). Callers branch on the code,
 * never on the message; the contract checks the code, not a shared class.
 * @typedef {Error & { code: string }} PlatformError
 */

/**
 * An open application as the window list reports it, and an installed one as the launcher list
 * reports it. Both shapes are still being agreed, so both stay opaque.
 * @typedef {unknown} AppWindow
 * @typedef {unknown} Launchable
 */

/**
 * The one door to the desktop. Everything above it asks this and never learns whether it is
 * talking to a compositor script, an X server, or nothing at all.
 * @typedef {Object} DesktopShell
 * @property {() => Capabilities} caps
 * @property {Observable<ShellHealth>} health
 * @property {{
 *   frames: Observable<WindowsFrame>,
 *   pointer: Observable<{ x: number, y: number }>,
 *   facts: Observable<DevicesFact>,
 *   workArea(displayId: number): Promise<DipRect | null>
 * }} observe
 * @property {{
 *   request(r: DipRect): Promise<DipRect>,
 *   raise(): void,
 *   focus(on: boolean): void,
 *   zones(z: { rects: Rect[], dpr: number }): void,
 *   identity(i: { pid: number, title: string, xid: number | null }): void
 * }} overlay
 * @property {{
 *   hotkey(id: string, accel: string): Promise<boolean>,
 *   onHotkey: Observable<string>,
 *   closeApps(names: string[], o: { force: boolean }): Promise<{ running: boolean }>
 * }} control
 * @property {{
 *   windows(): Promise<AppWindow[]>,
 *   launchables(): Promise<Launchable[]>,
 *   launch(id: string): Promise<void>,
 *   media(action: 'play' | 'pause' | 'next' | 'previous' | 'volup' | 'voldown' | 'mute'): Promise<boolean>,
 *   search(query: string): Promise<string[]>,
 *   screenshot(o: { display: DisplayInfo, multi: boolean }): Promise<Buffer | null>,
 *   terminal(command: string[]): Promise<boolean>
 * }} os
 * @property {(displays: DisplayInfo[]) => void} setDisplays
 * @property {() => Promise<void>} start
 * @property {() => Promise<void>} stop
 */

/**
 * Time as the core sees it: read it, schedule a one-shot callback, cancel one. Anything that
 * waits (a retry, a timeout, a debounce) goes through this instead of the globals, so a test can
 * move time by hand rather than sleep through it.
 * @typedef {{ now(): number, setTimeout(fn: Function, ms: number): any, clearTimeout(h: any): void }} Clock
 */

/**
 * Where log lines go: one method per level. `console` fits as it is; a test passes a recorder.
 * @typedef {{ debug(msg: string): void, info(msg: string): void, warn(msg: string): void, error(msg: string): void }} LogSink
 */

/**
 * What the rest of the code holds: the same four levels, every line already stamped with the
 * scope the logger was created with.
 * @typedef {{ debug(msg: string): void, info(msg: string): void, warn(msg: string): void, error(msg: string): void }} Logger
 */

/**
 * Running an external tool: the command and its arguments separately (no shell), resolved with
 * its stdout. A failure rejects with an Error carrying `code` ('ENOENT' when the tool is not
 * installed), which is how a caller tells "not there" from "there and unhappy".
 * @typedef {(cmd: string, args: string[]) => Promise<string>} Exec
 */

/**
 * The file operations the config repository's atomic write needs: write a temp file beside the
 * target, rename it over, clean up on failure. UTF-8 text throughout; `mkdir` is recursive and an
 * existing directory is fine, `rm` tolerates a missing path. The set grows when a consumer needs
 * more, not before.
 * @typedef {Object} Fs
 * @property {(path: string) => Promise<string>} readFile
 * @property {(path: string, data: string) => Promise<void>} writeFile
 * @property {(from: string, to: string) => Promise<void>} rename
 * @property {(path: string) => Promise<void>} mkdir
 * @property {(path: string) => Promise<void>} rm
 */

module.exports = {};