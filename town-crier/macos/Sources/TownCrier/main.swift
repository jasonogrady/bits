// ============================================================
// Town Crier — native macOS menu bar app (scaffold, v0.1)
//
// Sole job: poll the Town Crier hub (/api/crier/notify on
// ogrady.ai) and surface new notes as native macOS notifications
// + a menu-bar feed. The PWA at /crier/ is the v1 client; this
// is the v2 that never needs a browser running.
//
// Build + install:  ./make-app.sh   (assembles TownCrier.app —
// a real bundle is REQUIRED for UNUserNotificationCenter)
//
// Config: token read from ~/.config/crier/token (one line).
// ============================================================

import AppKit
import UserNotifications

let HUB = "https://ogrady.ai/api/crier/notify"
let POLL_SECONDS: TimeInterval = 30

func loadToken() -> String? {
    let path = ("~/.config/crier/token" as NSString).expandingTildeInPath
    return (try? String(contentsOfFile: path, encoding: .utf8))?
        .trimmingCharacters(in: .whitespacesAndNewlines)
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
    var token: String? = loadToken()

    func applicationDidFinishLaunching(_ n: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "📯"
        rebuildMenu()

        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }

        timer = Timer.scheduledTimer(withTimeInterval: POLL_SECONDS, repeats: true) { _ in
            Task { @MainActor in await self.poll() }
        }
        Task { await poll() }
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

    func poll() async {
        guard let token else { setError("no token — echo TOKEN > ~/.config/crier/token"); return }
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
        menu.addItem(withTitle: "Quit Town Crier", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        statusItem.menu = menu
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
