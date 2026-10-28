// Test windows for the macOS window-watch scenario (scripts/mac-window-scenario.js).
// Reads one command per line on stdin and answers one JSON line on stdout. Frames are given and
// reported in global top-left points, the helper's space.
//
//   open <name> <x> <y> <w> <h>   move <name> <x> <y>   min <name>   restore <name>
//   full <name>   unfull <name>   close <name>   state <name>   hide <name>
//   apphide   appunhide   front   activate   screens   quit
//
// Build: swiftc -O -o <out>/mac-window-fixture tools/mac-window-fixture.swift

import AppKit

let app = NSApplication.shared
app.setActivationPolicy(.regular)
setvbuf(stdout, nil, _IOLBF, 0)

var windows: [String: NSWindow] = [:]
var closed: [NSWindow] = [] // kept alive: a window freed while closing can linger on screen
let mainHeight = { NSScreen.screens.first?.frame.height ?? 0 }

func cocoa(_ x: Double, _ y: Double, _ w: Double, _ h: Double) -> NSRect {
  NSRect(x: x, y: mainHeight() - y - h, width: w, height: h)
}
func topLeft(_ r: NSRect) -> [String: Int] {
  ["x": Int(r.minX.rounded()), "y": Int((mainHeight() - r.maxY).rounded()), "w": Int(r.width.rounded()), "h": Int(r.height.rounded())]
}
func reply(_ obj: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])
  print(String(data: data, encoding: .utf8)!)
}
func state(_ name: String, _ w: NSWindow) -> [String: Any] {
  var o: [String: Any] = ["ok": true, "name": name, "id": w.windowNumber, "visible": w.isVisible,
                          "mini": w.isMiniaturized, "full": w.styleMask.contains(.fullScreen)]
  topLeft(w.frame).forEach { o[$0.key] = $0.value }
  return o
}

func run(_ line: String) {
  let p = line.split(separator: " ").map(String.init)
  guard let cmd = p.first else { return }
  let num = { (i: Int) in Double(p[i]) ?? 0 }
  switch cmd {
  case "open":
    let w = NSWindow(contentRect: cocoa(num(2), num(3), num(4), num(5)),
                     styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    w.isReleasedWhenClosed = false
    w.collectionBehavior = [.fullScreenPrimary]
    w.title = "Capri fixture \(p[1])"
    // frame given for the whole window, title bar included, like the helper reports it
    w.setFrame(cocoa(num(2), num(3), num(4), num(5)), display: true)
    w.makeKeyAndOrderFront(nil)
    windows[p[1]] = w
    app.activate(ignoringOtherApps: true)
    reply(state(p[1], w))
  case "move":
    guard let w = windows[p[1]] else { return reply(["ok": false]) }
    w.setFrame(cocoa(num(2), num(3), w.frame.width, w.frame.height), display: true)
    reply(state(p[1], w))
  case "apphide": app.hide(nil); reply(["ok": true])
  case "appunhide": app.unhide(nil); reply(["ok": true])
  case "hide": windows[p[1]]?.orderOut(nil); reply(["ok": true])
  case "min": windows[p[1]]?.miniaturize(nil); reply(["ok": true])
  case "restore": windows[p[1]]?.deminiaturize(nil); reply(["ok": true])
  case "full", "unfull": windows[p[1]]?.toggleFullScreen(nil); reply(["ok": true])
  case "close":
    guard let w = windows[p[1]] else { return reply(["ok": false]) }
    w.close()
    closed.append(w)
    windows[p[1]] = nil
    reply(["ok": true, "visible": w.isVisible])
  case "state":
    guard let w = windows[p[1]] else { return reply(["ok": false]) }
    reply(state(p[1], w))
  case "front":
    let f = NSWorkspace.shared.frontmostApplication
    reply(["ok": true, "self": Int(getpid()), "front": Int(f?.processIdentifier ?? -1), "bundle": f?.bundleIdentifier ?? ""])
  case "activate": app.activate(ignoringOtherApps: true); reply(["ok": true, "pid": getpid()])
  case "screens":
    reply(["ok": true, "screens": NSScreen.screens.map { s -> [String: Any] in
      var o: [String: Any] = ["scale": s.backingScaleFactor]
      topLeft(s.frame).forEach { o[$0.key] = $0.value }
      return o
    }])
  case "quit": exit(0)
  default: reply(["ok": false, "error": "unknown command"])
  }
}

Thread.detachNewThread {
  while let line = readLine() {
    DispatchQueue.main.async { run(line) }
  }
  DispatchQueue.main.async { exit(0) }
}
app.run()
