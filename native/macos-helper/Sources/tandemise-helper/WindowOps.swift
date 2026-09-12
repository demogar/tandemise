import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

/// One on-screen window as the window server sees it. The window *number* is the
/// only handle that ScreenCaptureKit and `CGWindowListCreateImage` accept, and
/// the Accessibility API does not expose it - so every window listing joins the
/// two sources on frame geometry.
struct CGWindowRecord {
    let windowId: Int
    let pid: pid_t
    let bounds: CGRect
    let title: String?
    let layer: Int

    static func onScreen() -> [CGWindowRecord] {
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let raw = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: AnyObject]] else {
            return []
        }
        return raw.compactMap { entry in
            guard let windowId = entry[kCGWindowNumber as String] as? Int,
                  let pid = entry[kCGWindowOwnerPID as String] as? pid_t,
                  let boundsDict = entry[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary) else { return nil }
            return CGWindowRecord(
                windowId: windowId,
                pid: pid,
                bounds: bounds,
                // Window titles are gated behind Screen Recording since 10.15;
                // absence here is a permission signal, not an empty title.
                title: entry[kCGWindowName as String] as? String,
                layer: entry[kCGWindowLayer as String] as? Int ?? 0)
        }
    }
}

enum WindowOps {
    static func list(_ params: Params) throws -> JSONValue {
        try AX.requireTrusted("list an application's windows")
        try Session.requireUnlocked("window listing")
        let app = try AppOps.resolveRunningApplication(params)
        let axApp = AX.application(pid: app.processIdentifier)
        let axWindows = try AX.windows(of: axApp)
        let cgWindows = CGWindowRecord.onScreen().filter { $0.pid == app.processIdentifier && $0.layer == 0 }

        var windows: [JSONValue] = []
        for (index, window) in axWindows.enumerated() {
            let origin = try AX.point(window)
            let extent = try AX.size(window)
            let matched = origin.flatMap { o in
                extent.flatMap { s in match(cgWindows, origin: o, size: s) }
            }
            windows.append(.object([
                "index": .int(index),
                "title": .optionalString(try AX.string(window, kAXTitleAttribute)),
                "role": .optionalString(try AX.string(window, kAXRoleAttribute)),
                "subrole": .optionalString(try AX.string(window, kAXSubroleAttribute)),
                "position": .point(origin),
                "size": .size(extent),
                "focused": .bool((try AX.bool(window, kAXFocusedAttribute)) ?? false),
                "main": .bool((try AX.bool(window, kAXMainAttribute)) ?? false),
                "minimized": .bool((try AX.bool(window, kAXMinimizedAttribute)) ?? false),
                "windowId": .optionalInt(matched?.windowId),
            ]))
        }

        return .object([
            "bundleId": .optionalString(app.bundleIdentifier),
            "pid": .int(Int(app.processIdentifier)),
            "windows": .array(windows),
            "count": .int(windows.count),
        ])
    }

    /// Pick the AX window a caller means: by title, by index, else the main one.
    static func selectWindow(of axApp: AXUIElement, params: Params) throws -> (element: AXUIElement, index: Int)? {
        let windows = try AX.windows(of: axApp)
        guard !windows.isEmpty else { return nil }

        if let index = params.int("windowIndex") {
            guard index >= 0, index < windows.count else {
                throw HelperError.notFound("Window index \(index) is out of range; the app has \(windows.count) window(s)",
                                           details: ["windowIndex": .int(index)])
            }
            return (windows[index], index)
        }
        if let wanted = params.string("window") {
            for (index, window) in windows.enumerated() {
                if let title = try AX.string(window, kAXTitleAttribute),
                   title == wanted || title.localizedCaseInsensitiveContains(wanted) {
                    return (window, index)
                }
            }
            throw HelperError.notFound("No window whose title matches '\(wanted)'",
                                       details: ["window": .string(wanted)])
        }
        for (index, window) in windows.enumerated() where (try AX.bool(window, kAXMainAttribute)) == true {
            return (window, index)
        }
        return (windows[0], 0)
    }

    /// Join on geometry. The window server rounds to integer points, so compare
    /// with a tolerance rather than for equality.
    static func match(_ records: [CGWindowRecord], origin: CGPoint, size: CGSize) -> CGWindowRecord? {
        records.first { record in
            abs(record.bounds.origin.x - origin.x) <= 2
                && abs(record.bounds.origin.y - origin.y) <= 2
                && abs(record.bounds.width - size.width) <= 2
                && abs(record.bounds.height - size.height) <= 2
        }
    }

    /// Best-effort window number for an app, preferring its frontmost window.
    static func primaryWindowId(pid: pid_t) throws -> Int? {
        let records = CGWindowRecord.onScreen().filter { $0.pid == pid && $0.layer == 0 }
        guard !records.isEmpty else { return nil }
        if AX.isTrusted {
            let axApp = AX.application(pid: pid)
            for window in try AX.windows(of: axApp) {
                guard (try AX.bool(window, kAXMainAttribute)) == true,
                      let origin = try AX.point(window), let extent = try AX.size(window),
                      let matched = match(records, origin: origin, size: extent) else { continue }
                return matched.windowId
            }
        }
        // Without AX, the largest on-screen window is the best guess available.
        return records.max(by: { $0.bounds.width * $0.bounds.height < $1.bounds.width * $1.bounds.height })?.windowId
    }
}
