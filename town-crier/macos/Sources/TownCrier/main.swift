// ============================================================
// Town Crier — native macOS menu bar app (v0.2)
//
// Sole job: surface Town Crier hub notes as native macOS
// notifications + a menu-bar feed. The PWA at /crier/ is the
// v1 client; this is the v2 that never needs a browser running.
//
// Delivery: subscribes to the ntfy topic over WebSocket
// (wss://ntfy.sh/<topic>/ws) as a realtime wake-up signal, then
// fetches the hub feed — the hub stays the single source of
// truth, so notifications keep hub formatting and dedupe.
// Falls back to 30 s polling whenever the socket is down
// (and still polls every ~5 min while live, belt-and-braces).
//
// Build + install:  ./make-app.sh   (assembles TownCrier.app —
// a real bundle is REQUIRED for UNUserNotificationCenter)
//
// Config: ~/.config/crier/config, KEY=VALUE lines —
//   CRIER_TOKEN=…   hub auth (required)
//   NTFY_TOPIC=…    reserved ntfy topic (enables WebSocket)
//   NTFY_AUTH=tk_…  ntfy access token (reserved topics need it)
// Legacy ~/.config/crier/token (CRIER_TOKEN only) still works.
// ============================================================

import AppKit
import ServiceManagement
import UserNotifications

let HUB = "https://ogrady.ai/api/crier/notify"
let POLL_SECONDS: TimeInterval = 30
let LIVE_POLL_EVERY_TICKS = 10        // fallback poll cadence while WS is live (~5 min)
let WS_SILENCE_LIMIT: TimeInterval = 120 // ntfy keepalives arrive ~45 s; longer = dead socket

struct Config {
    var crierToken: String?
    var ntfyTopic: String?
    var ntfyAuth: String?

    static func load() -> Config {
        var c = Config()
        let dir = ("~/.config/crier" as NSString).expandingTildeInPath
        if let text = try? String(contentsOfFile: dir + "/config", encoding: .utf8) {
            for line in text.split(separator: "\n") {
                guard !line.hasPrefix("#") else { continue }
                let parts = line.split(separator: "=", maxSplits: 1).map(String.init)
                guard parts.count == 2 else { continue }
                let key = parts[0].trimmingCharacters(in: .whitespaces)
                let val = parts[1].trimmingCharacters(in: .whitespaces)
                switch key {
                case "CRIER_TOKEN": c.crierToken = val
                case "NTFY_TOPIC":  c.ntfyTopic = val
                case "NTFY_AUTH":   c.ntfyAuth = val
                default: break
                }
            }
        }
        if c.crierToken == nil, // legacy single-token file
           let t = try? String(contentsOfFile: dir + "/token", encoding: .utf8) {
            c.crierToken = t.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return c
    }
}

struct Note: Codable {
    let id: String
    let ts: Double
    let source: String
    let title: String
    let body: String?
    let url: String?
    let priority: String?
}

struct Feed: Codable { let ok: Bool; let notes: [Note] }

@MainActor
final class Crier: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    var statusItem: NSStatusItem!
    var timer: Timer?
    var lastSeenTs: Double = Date().timeIntervalSince1970 * 1000 // only notify for NEW notes
    var recent: [Note] = []
    var config = Config.load()

    var ws: URLSessionWebSocketTask?
    var wsLive = false
    var wsBackoff: TimeInterval = 2
    var lastWsEvent = Date()
    var tick = 0

    func applicationDidFinishLaunching(_ n: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "📯"
        rebuildMenu()

        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }

        timer = Timer.scheduledTimer(withTimeInterval: POLL_SECONDS, repeats: true) { _ in
            Task { @MainActor in await self.tickPoll() }
        }
        Task { await poll() }
        connectWS()
    }

    // Show banners even while "active" (menu bar apps are always active)
    nonisolated func userNotificationCenter(_ c: UNUserNotificationCenter, willPresent n: UNNotification,
        withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([.banner, .sound, .list])
    }

    nonisolated func userNotificationCenter(_ c: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler done: @escaping () -> Void) {
        if let url = response.notification.request.content.userInfo["url"] as? String,
           let u = URL(string: url) {
            DispatchQueue.main.async { NSWorkspace.shared.open(u) }
        }
        done()
    }

    // ---- ntfy WebSocket: realtime "check the hub now" signal ----

    func connectWS() {
        guard ws == nil else { return }
        guard let topic = config.ntfyTopic, !topic.isEmpty,
              let url = URL(string: "wss://ntfy.sh/\(topic)/ws") else { return }
        var req = URLRequest(url: url)
        if let auth = config.ntfyAuth, !auth.isEmpty {
            req.setValue("Bearer \(auth)", forHTTPHeaderField: "Authorization")
        }
        let task = URLSession.shared.webSocketTask(with: req)
        ws = task
        task.resume()
        receiveLoop(task)
    }

    func receiveLoop(_ task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            Task { @MainActor in
                guard let self, task === self.ws else { return }
                switch result {
                case .success(let msg):
                    self.lastWsEvent = Date()
                    if !self.wsLive { // (re)connected — catch up on anything missed
                        self.wsLive = true
                        self.wsBackoff = 2
                        self.rebuildMenu()
                        await self.poll()
                    }
                    if case .string(let s) = msg,
                       let data = s.data(using: .utf8),
                       let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                       obj["event"] as? String == "message" {
                        await self.poll()
                    }
                    self.receiveLoop(task)
                case .failure:
                    self.wsDown()
                }
            }
        }
    }

    func wsDown() {
        ws?.cancel()
        ws = nil
        wsLive = false
        rebuildMenu()
        let delay = wsBackoff
        wsBackoff = min(wsBackoff * 2, 60)
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            self.connectWS()
        }
    }

    // ---- hub polling (fallback + WS-triggered fetch) ----

    func tickPoll() async {
        tick += 1
        if wsLive, Date().timeIntervalSince(lastWsEvent) > WS_SILENCE_LIMIT {
            wsDown() // socket went quiet — ntfy keepalives should be steady
        }
        if !wsLive || tick % LIVE_POLL_EVERY_TICKS == 0 { await poll() }
    }

    func poll() async {
        guard let token = config.crierToken else {
            setError("no token — add CRIER_TOKEN to ~/.config/crier/config"); return
        }
        guard var comps = URLComponents(string: HUB) else { return }
        comps.queryItems = [.init(name: "limit", value: "20")]
        var req = URLRequest(url: comps.url!)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard (resp as? HTTPURLResponse)?.statusCode == 200 else {
                setError("hub \( (resp as? HTTPURLResponse)?.statusCode ?? 0 )"); return
            }
            let feed = try JSONDecoder().decode(Feed.self, from: data)
            recent = feed.notes
            let fresh = feed.notes.filter { $0.ts > lastSeenTs }
            if let newest = feed.notes.first { lastSeenTs = max(lastSeenTs, newest.ts) }
            for note in fresh.reversed() { deliver(note) }
            statusItem.button?.title = fresh.isEmpty ? "📯" : "📯•"
            rebuildMenu()
        } catch {
            setError(error.localizedDescription)
        }
    }

    func deliver(_ note: Note) {
        let content = UNMutableNotificationContent()
        content.title = note.source == "ogrady.ai" ? note.title : "\(note.source) — \(note.title)"
        content.body = note.body ?? ""
        content.sound = (note.priority == "high" || note.priority == "urgent")
            ? .defaultCritical : .default
        if let url = note.url { content.userInfo = ["url": url] }
        UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: note.id, content: content, trigger: nil))
    }

    func setError(_ msg: String) {
        statusItem.button?.title = "📯⚠︎"
        statusItem.button?.toolTip = msg
    }

    func rebuildMenu() {
        let menu = NSMenu()

        let mode = wsLive ? "⚡︎ Live — ntfy WebSocket"
                 : (config.ntfyTopic?.isEmpty ?? true)
                 ? "Polling every 30 s (no NTFY_TOPIC in config)"
                 : "Polling every 30 s — WebSocket reconnecting…"
        menu.addItem(withTitle: mode, action: nil, keyEquivalent: "")
        menu.addItem(.separator())

        if recent.isEmpty {
            menu.addItem(withTitle: "No notes yet", action: nil, keyEquivalent: "")
        }
        for note in recent.prefix(10) {
            let age = Int((Date().timeIntervalSince1970 * 1000 - note.ts) / 60000)
            let item = NSMenuItem(title: "[\(note.source)] \(note.title) — \(age)m",
                                  action: #selector(openNote(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = note.url ?? "https://ogrady.ai/crier/"
            menu.addItem(item)
        }
        menu.addItem(.separator())
        menu.addItem(withTitle: "Open Crier hub", action: #selector(openHub), keyEquivalent: "o").target = self
        menu.addItem(withTitle: "Check now", action: #selector(checkNow), keyEquivalent: "r").target = self
        menu.addItem(.separator())
        let login = NSMenuItem(title: "Start at Login", action: #selector(toggleLoginItem), keyEquivalent: "")
        login.target = self
        login.state = SMAppService.mainApp.status == .enabled ? .on : .off
        menu.addItem(login)
        menu.addItem(withTitle: "Quit Town Crier", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        statusItem.menu = menu
    }

    @objc func toggleLoginItem() {
        do {
            if SMAppService.mainApp.status == .enabled {
                try SMAppService.mainApp.unregister()
            } else {
                try SMAppService.mainApp.register()
            }
        } catch {
            setError("login item: \(error.localizedDescription)")
        }
        rebuildMenu()
    }

    @objc func openNote(_ sender: NSMenuItem) {
        if let s = sender.representedObject as? String, let u = URL(string: s) {
            NSWorkspace.shared.open(u)
        }
    }
    @objc func openHub() { NSWorkspace.shared.open(URL(string: "https://ogrady.ai/crier/")!) }
    @objc func checkNow() { Task { await poll() } }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // menu bar only, no Dock icon
let delegate = Crier()
app.delegate = delegate
app.run()
