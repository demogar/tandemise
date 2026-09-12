import AppKit
import Foundation

/// App discovery, launch and activation - `NSWorkspace` / Launch Services
/// (MVP.md §13.3). None of this needs an Accessibility grant, which is why these
/// ops keep working (and stay useful for diagnostics) when inspection does not.
enum AppOps {
    static func listRunning() -> JSONValue {
        let apps = NSWorkspace.shared.runningApplications
            // `.prohibited` is the daemon/agent activation policy: dozens of
            // faceless helpers no agent can ever drive. Keep them out.
            .filter { $0.activationPolicy != .prohibited }
            .map { app -> JSONValue in
                .object([
                    "bundleId": .optionalString(app.bundleIdentifier),
                    "localizedName": .optionalString(app.localizedName),
                    "pid": .int(Int(app.processIdentifier)),
                    "isActive": .bool(app.isActive),
                    "isHidden": .bool(app.isHidden),
                    "activationPolicy": .string(policyName(app.activationPolicy)),
                    "bundlePath": .optionalString(app.bundleURL?.path),
                ])
            }
        return .object(["apps": .array(apps), "count": .int(apps.count)])
    }

    static func listInstalled() -> JSONValue {
        var seen = Set<String>()
        var found: [JSONValue] = []

        for root in searchRoots() {
            let contents = (try? FileManager.default.contentsOfDirectory(
                at: root, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles])) ?? []
            for url in contents where url.pathExtension == "app" {
                guard let bundle = Bundle(url: url) else { continue }
                let bundleId = bundle.bundleIdentifier
                // Two copies of the same app (e.g. /Applications and ~/Applications)
                // are one entry; without a bundle id, dedupe on path.
                let key = bundleId ?? url.path
                guard seen.insert(key).inserted else { continue }
                found.append(.object([
                    "bundleId": .optionalString(bundleId),
                    "name": .string(url.deletingPathExtension().lastPathComponent),
                    "path": .string(url.path),
                    "version": .optionalString(bundle.infoDictionary?["CFBundleShortVersionString"] as? String),
                ]))
            }
        }

        found.sort { ($0.objectValue?["name"]?.stringValue ?? "") < ($1.objectValue?["name"]?.stringValue ?? "") }
        return .object(["apps": .array(found), "count": .int(found.count)])
    }

    static func launch(_ params: Params) throws -> JSONValue {
        let url = try resolveApplicationURL(params)
        let timeout = TimeInterval(params.clampedInt("timeoutMs", default: 15_000, min: 500, max: 120_000)) / 1000

        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = params.bool("activate") ?? true

        var launched: NSRunningApplication?
        var failure: Error?
        var settled = false

        NSWorkspace.shared.openApplication(at: url, configuration: configuration) { app, error in
            launched = app
            failure = error
            settled = true
        }

        guard RunLoopWait.until(timeout: timeout, { settled }) else {
            throw HelperError.timeout("Timed out after \(Int(timeout))s waiting for \(url.lastPathComponent) to launch",
                                      details: ["path": .string(url.path)])
        }
        if let failure {
            throw HelperError("TARGET_UNAVAILABLE",
                              "Failed to launch \(url.lastPathComponent): \(failure.localizedDescription)",
                              details: ["path": .string(url.path)])
        }
        guard let app = launched else {
            throw HelperError.internalError("Launch of \(url.lastPathComponent) reported neither an app nor an error")
        }

        // "Launched" and "ready to be driven" are different things. Callers
        // almost always want the latter, so wait for the app to come forward -
        // but a miss here is informational, not fatal.
        let becameFrontmost = configuration.activates
            ? RunLoopWait.until(timeout: min(timeout, 10), {
                NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier
              })
            : false

        return .object([
            "bundleId": .optionalString(app.bundleIdentifier),
            "localizedName": .optionalString(app.localizedName),
            "pid": .int(Int(app.processIdentifier)),
            "path": .string(url.path),
            "alreadyRunning": .bool(app.launchDate.map { $0 < Date().addingTimeInterval(-1) } ?? false),
            "frontmost": .bool(becameFrontmost),
        ])
    }

    static func activate(_ params: Params) throws -> JSONValue {
        let app = try resolveRunningApplication(params)
        let activated = app.activate(options: [])
        let timeout = TimeInterval(params.clampedInt("timeoutMs", default: 5_000, min: 200, max: 60_000)) / 1000
        let frontmost = RunLoopWait.until(timeout: timeout, {
            NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier
        })
        return .object([
            "bundleId": .optionalString(app.bundleIdentifier),
            "pid": .int(Int(app.processIdentifier)),
            "activateAccepted": .bool(activated),
            "frontmost": .bool(frontmost),
        ])
    }

    // MARK: - Resolution

    /// Find a *running* app by bundle id, then pid, then localized name.
    static func resolveRunningApplication(_ params: Params) throws -> NSRunningApplication {
        if let bundleId = params.string("bundleId") {
            let matches = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId)
            guard let app = matches.first else {
                throw HelperError.notFound("No running application with bundle id '\(bundleId)'",
                                           details: ["bundleId": .string(bundleId)])
            }
            return app
        }
        if let pid = params.int("pid") {
            guard let app = NSRunningApplication(processIdentifier: pid_t(pid)) else {
                throw HelperError.notFound("No running application with pid \(pid)", details: ["pid": .int(pid)])
            }
            return app
        }
        if let name = params.string("appName") {
            let match = NSWorkspace.shared.runningApplications.first {
                $0.localizedName?.caseInsensitiveCompare(name) == .orderedSame
            }
            guard let app = match else {
                throw HelperError.notFound("No running application named '\(name)'",
                                           details: ["appName": .string(name)])
            }
            return app
        }
        throw HelperError.validation("One of 'bundleId', 'pid' or 'appName' is required")
    }

    /// Find an *installed* app bundle by bundle id, explicit path, or name.
    static func resolveApplicationURL(_ params: Params) throws -> URL {
        if let path = params.string("path") {
            let url = URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
            guard FileManager.default.fileExists(atPath: url.path) else {
                throw HelperError.notFound("No application bundle at '\(url.path)'", details: ["path": .string(url.path)])
            }
            return url
        }
        if let bundleId = params.string("bundleId") {
            guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else {
                throw HelperError.notFound("No installed application with bundle id '\(bundleId)'",
                                           details: ["bundleId": .string(bundleId)])
            }
            return url
        }
        if let name = params.string("appName") {
            let candidates = searchRoots().map {
                $0.appendingPathComponent(name.hasSuffix(".app") ? name : name + ".app")
            }
            if let url = candidates.first(where: { FileManager.default.fileExists(atPath: $0.path) }) {
                return url
            }
            throw HelperError.notFound("No installed application named '\(name)'",
                                       details: ["appName": .string(name)])
        }
        throw HelperError.validation("One of 'bundleId', 'appName' or 'path' is required")
    }

    private static func searchRoots() -> [URL] {
        var roots = [URL(fileURLWithPath: "/Applications"),
                     URL(fileURLWithPath: "/Applications/Utilities"),
                     URL(fileURLWithPath: "/System/Applications"),
                     URL(fileURLWithPath: "/System/Applications/Utilities")]
        if let home = FileManager.default.homeDirectoryForCurrentUser as URL? {
            roots.append(home.appendingPathComponent("Applications"))
        }
        return roots.filter { FileManager.default.fileExists(atPath: $0.path) }
    }

    private static func policyName(_ policy: NSApplication.ActivationPolicy) -> String {
        switch policy {
        case .regular: return "regular"
        case .accessory: return "accessory"
        case .prohibited: return "prohibited"
        @unknown default: return "unknown"
        }
    }
}
