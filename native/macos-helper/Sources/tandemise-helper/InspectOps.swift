import AppKit
import ApplicationServices
import Foundation

/// Semantic inspection and activation (MVP.md §13.4).
///
/// The agent-facing contract is: describe the UI by role/label/identifier, act on
/// it by the same, and only ever fall back to coordinates when explicitly told
/// to - and then prove what happened.
enum InspectOps {
    /// A full accessibility tree is unbounded. Xcode's runs to hundreds of
    /// thousands of nodes, which would blow up the transport, the model context
    /// and the caller's memory long before it became useful. Every traversal is
    /// budgeted, and the response says so when the budget bit.
    static let defaultMaxDepth = 12
    static let maxMaxDepth = 40
    static let defaultMaxNodes = 2_000
    static let maxMaxNodes = 20_000

    // MARK: - inspect

    static func inspect(_ params: Params) throws -> JSONValue {
        try AX.requireTrusted("inspect an application's accessibility tree")
        let app = try AppOps.resolveRunningApplication(params)
        let axApp = AX.application(pid: app.processIdentifier)
        let maxDepth = params.clampedInt("maxDepth", default: defaultMaxDepth, min: 1, max: maxMaxDepth)
        let maxNodes = params.clampedInt("maxNodes", default: defaultMaxNodes, min: 1, max: maxMaxNodes)

        let root: AXUIElement
        let rootPath: String
        var windowIndex: Int?
        if params.has("window") || params.has("windowIndex") {
            guard let selected = try WindowOps.selectWindow(of: axApp, params: params) else {
                throw HelperError.notFound("\(app.localizedName ?? "The application") has no accessible windows")
            }
            root = selected.element
            windowIndex = selected.index
            // A window's path is relative to the window, so `click` given the
            // same window selector resolves it identically.
            rootPath = ""
        } else {
            root = axApp
            rootPath = ""
        }

        var budget = Budget(remaining: maxNodes)
        let tree = try node(root, path: rootPath, depth: 0, maxDepth: maxDepth, budget: &budget)

        return .object([
            "bundleId": .optionalString(app.bundleIdentifier),
            "pid": .int(Int(app.processIdentifier)),
            "windowIndex": .optionalInt(windowIndex),
            "root": .string(windowIndex == nil ? "application" : "window"),
            "tree": tree,
            "nodeCount": .int(maxNodes - budget.remaining),
            "truncated": .bool(budget.truncated),
            "limits": .object(["maxDepth": .int(maxDepth), "maxNodes": .int(maxNodes)]),
        ])
    }

    private struct Budget {
        var remaining: Int
        var truncated = false

        mutating func take() -> Bool {
            guard remaining > 0 else { truncated = true; return false }
            remaining -= 1
            return true
        }
    }

    private static func node(_ element: AXUIElement, path: String, depth: Int, maxDepth: Int,
                             budget: inout Budget) throws -> JSONValue {
        guard budget.take() else { return .object(["truncated": .bool(true)]) }
        var fields = try AX.describe(element, path: path.isEmpty ? nil : path)

        if depth >= maxDepth {
            let kids = try AX.children(element)
            if !kids.isEmpty {
                fields["children"] = .array([])
                fields["truncated"] = .bool(true)
                fields["childCount"] = .int(kids.count)
                budget.truncated = true
            }
            return .object(fields)
        }

        let kids = try AX.children(element)
        var encoded: [JSONValue] = []
        encoded.reserveCapacity(kids.count)
        for (index, child) in kids.enumerated() {
            if budget.remaining == 0 {
                budget.truncated = true
                fields["truncated"] = .bool(true)
                break
            }
            encoded.append(try node(child, path: AXPath.child(path, index), depth: depth + 1,
                                    maxDepth: maxDepth, budget: &budget))
        }
        if !kids.isEmpty { fields["children"] = .array(encoded) }
        return .object(fields)
    }

    // MARK: - find

    /// A selector over the accessibility tree. All supplied criteria must match.
    struct Selector {
        let role: String?
        let subrole: String?
        let label: String?
        let identifier: String?
        let titleContains: String?

        init(_ params: Params) {
            role = params.string("role")
            subrole = params.string("subrole")
            label = params.string("label")
            identifier = params.string("identifier")
            titleContains = params.string("titleContains")
        }

        var isEmpty: Bool {
            role == nil && subrole == nil && label == nil && identifier == nil && titleContains == nil
        }

        var described: String {
            var parts: [String] = []
            if let role { parts.append("role=\(role)") }
            if let subrole { parts.append("subrole=\(subrole)") }
            if let label { parts.append("label=\(label)") }
            if let identifier { parts.append("identifier=\(identifier)") }
            if let titleContains { parts.append("titleContains=\(titleContains)") }
            return parts.joined(separator: " ")
        }

        /// `label` matches AXTitle, AXDescription or AXValue: which of the three
        /// carries the human-visible text is entirely up to the app, and callers
        /// should not have to know or care.
        func matches(_ element: AXUIElement) throws -> Bool {
            if let role, try AX.string(element, kAXRoleAttribute) != role { return false }
            if let subrole, try AX.string(element, kAXSubroleAttribute) != subrole { return false }
            if let identifier, try AX.string(element, kAXIdentifierAttribute) != identifier { return false }

            if let label {
                let candidates = [try AX.string(element, kAXTitleAttribute),
                                  try AX.string(element, kAXDescriptionAttribute),
                                  try AX.string(element, kAXValueAttribute)].compactMap { $0 }
                guard candidates.contains(where: { $0.compare(label, options: .caseInsensitive) == .orderedSame })
                else { return false }
            }
            if let titleContains {
                let candidates = [try AX.string(element, kAXTitleAttribute),
                                  try AX.string(element, kAXDescriptionAttribute),
                                  try AX.string(element, kAXValueAttribute),
                                  try AX.string(element, kAXHelpAttribute)].compactMap { $0 }
                guard candidates.contains(where: { $0.localizedCaseInsensitiveContains(titleContains) })
                else { return false }
            }
            return true
        }
    }

    static func find(_ params: Params) throws -> JSONValue {
        try AX.requireTrusted("search an application's accessibility tree")
        let selector = Selector(params)
        guard !selector.isEmpty else {
            throw HelperError.validation("find requires at least one of 'role', 'subrole', 'label', 'identifier' or 'titleContains'")
        }
        let context = try resolveSearchRoot(params)
        let limit = params.clampedInt("limit", default: 25, min: 1, max: 500)
        let maxDepth = params.clampedInt("maxDepth", default: defaultMaxDepth, min: 1, max: maxMaxDepth)
        let maxNodes = params.clampedInt("maxNodes", default: defaultMaxNodes * 5, min: 1, max: maxMaxNodes)

        var budget = Budget(remaining: maxNodes)
        var matches: [(AXUIElement, String)] = []
        try search(context.root, path: "", depth: 0, maxDepth: maxDepth, selector: selector,
                   limit: limit, budget: &budget, into: &matches)

        return .object([
            "bundleId": .optionalString(context.app.bundleIdentifier),
            "pid": .int(Int(context.app.processIdentifier)),
            "windowIndex": .optionalInt(context.windowIndex),
            "selector": .string(selector.described),
            "matches": .array(try matches.map { .object(try AX.describe($0.0, path: $0.1)) }),
            "count": .int(matches.count),
            "truncated": .bool(budget.truncated || matches.count >= limit),
        ])
    }

    private static func search(_ element: AXUIElement, path: String, depth: Int, maxDepth: Int,
                               selector: Selector, limit: Int, budget: inout Budget,
                               into matches: inout [(AXUIElement, String)]) throws {
        guard matches.count < limit, budget.take() else { return }
        if try selector.matches(element) {
            matches.append((element, path))
            if matches.count >= limit { return }
        }
        guard depth < maxDepth else {
            if !(try AX.children(element).isEmpty) { budget.truncated = true }
            return
        }
        for (index, child) in try AX.children(element).enumerated() {
            try search(child, path: AXPath.child(path, index), depth: depth + 1, maxDepth: maxDepth,
                       selector: selector, limit: limit, budget: &budget, into: &matches)
            if matches.count >= limit { return }
        }
    }

    // MARK: - click

    static func click(_ params: Params) throws -> JSONValue {
        let allowCoordinates = params.bool("allowCoordinates") ?? false
        let hasCoordinates = params.has("x") && params.has("y")

        // Coordinate clicking is the documented fallback, not a peer: it must be
        // asked for by name so no selector typo silently degrades into blind
        // clicking at (0, 0).
        if hasCoordinates && !allowCoordinates {
            throw HelperError.validation(
                "Coordinate clicking is a fallback and must be requested explicitly with allowCoordinates: true. "
                    + "Prefer a semantic selector (role/label/identifier).")
        }
        if hasCoordinates { return try clickAtCoordinates(params) }

        try AX.requireTrusted("click an element")
        let context = try resolveSearchRoot(params)

        let element: AXUIElement
        let path: String
        if let requested = params.string("path") {
            element = try AXPath.resolve(requested, from: context.root)
            path = requested
            // A path is a positional handle; layout moves. If the caller also
            // gave a selector, re-check it so we never press the wrong control.
            let selector = Selector(params)
            if !selector.isEmpty, !(try selector.matches(element)) {
                throw HelperError.notFound(
                    "Element at path '\(requested)' no longer matches the selector (\(selector.described)); "
                        + "the UI changed. Re-run find.",
                    details: ["path": .string(requested)])
            }
        } else {
            let selector = Selector(params)
            guard !selector.isEmpty else {
                throw HelperError.validation(
                    "click requires a semantic selector ('role'/'label'/'identifier'), a 'path' from find, "
                        + "or explicit coordinates with allowCoordinates: true")
            }
            var budget = Budget(remaining: maxMaxNodes)
            var matches: [(AXUIElement, String)] = []
            try search(context.root, path: "", depth: 0,
                       maxDepth: params.clampedInt("maxDepth", default: maxMaxDepth, min: 1, max: maxMaxDepth),
                       selector: selector, limit: 2, budget: &budget, into: &matches)
            guard let first = matches.first else {
                throw HelperError.notFound("No element matches (\(selector.described)) in \(context.describedTarget)",
                                           details: ["selector": .string(selector.described)])
            }
            if matches.count > 1 {
                throw HelperError.validation(
                    "Selector (\(selector.described)) is ambiguous - it matches more than one element in "
                        + "\(context.describedTarget). Narrow it, or use the 'path' from find.",
                    details: ["selector": .string(selector.described)])
            }
            element = first.0
            path = first.1
        }

        if (try AX.bool(element, kAXEnabledAttribute)) == false {
            throw HelperError("PRECONDITION_FAILED", "The matched element is disabled and cannot be pressed",
                              details: ["path": .string(path)])
        }

        let available = try AX.actionNames(element)
        let action = params.string("action") ?? preferredAction(from: available)
        guard available.contains(action) else {
            throw HelperError.unsupported(
                "The matched element does not support '\(action)'. It supports: \(available.joined(separator: ", "))",
                details: ["path": .string(path), "actions": .array(available.map(JSONValue.string))])
        }
        try AX.perform(element, action: action)

        return .object([
            "method": .string("accessibility"),
            "action": .string(action),
            "path": .string(path),
            // Verification snapshot: the caller can diff this against what it
            // found before the press without a second round trip.
            "element": .object(try AX.describe(element, path: path)),
        ])
    }

    private static func preferredAction(from available: [String]) -> String {
        for candidate in [kAXPressAction, kAXConfirmAction, kAXPickAction, kAXIncrementAction] where available.contains(candidate) {
            return candidate
        }
        return kAXPressAction
    }

    private static func clickAtCoordinates(_ params: Params) throws -> JSONValue {
        guard let x = params.int("x"), let y = params.int("y") else {
            throw HelperError.validation("Coordinate clicking requires numeric 'x' and 'y'")
        }
        let point = CGPoint(x: Double(x), y: Double(y))
        try Input.requireEventPermission("click at a coordinate")

        let button = params.string("button") ?? "left"
        try Input.click(at: point, button: button, clickCount: params.clampedInt("clickCount", default: 1, min: 1, max: 3))

        // MVP.md §13.4: a coordinate action must be followed by accessibility or
        // screenshot verification. We hit-test the point we clicked and return
        // what is actually there, so the caller can confirm it hit the intended
        // control rather than trusting the coordinate.
        _ = RunLoopWait.until(timeout: 0.25, { false })
        var verification: JSONValue = .null
        var verificationError: JSONValue = .null
        if AX.isTrusted {
            do {
                if let hit = try AX.elementAt(point) {
                    verification = .object(try AX.describe(hit, path: nil))
                }
            } catch let error as HelperError {
                verificationError = .string("\(error.code): \(error.message)")
            }
        } else {
            verificationError = .string(
                "PERMISSION_DENIED: cannot verify a coordinate click without Accessibility. \(HelperError.accessibilityHint)")
        }

        return .object([
            "method": .string("coordinates"),
            "point": .point(point),
            "button": .string(button),
            "elementAtPoint": verification,
            "verificationError": verificationError,
        ])
    }

    // MARK: - Shared target resolution

    struct SearchContext {
        let app: NSRunningApplication
        let root: AXUIElement
        let windowIndex: Int?

        var describedTarget: String {
            let name = app.localizedName ?? app.bundleIdentifier ?? "pid \(app.processIdentifier)"
            guard let windowIndex else { return name }
            return "\(name) window \(windowIndex)"
        }
    }

    static func resolveSearchRoot(_ params: Params) throws -> SearchContext {
        let app = try AppOps.resolveRunningApplication(params)
        let axApp = AX.application(pid: app.processIdentifier)
        guard params.has("window") || params.has("windowIndex") else {
            return SearchContext(app: app, root: axApp, windowIndex: nil)
        }
        guard let selected = try WindowOps.selectWindow(of: axApp, params: params) else {
            throw HelperError.notFound("\(app.localizedName ?? "The application") has no accessible windows")
        }
        return SearchContext(app: app, root: selected.element, windowIndex: selected.index)
    }
}
