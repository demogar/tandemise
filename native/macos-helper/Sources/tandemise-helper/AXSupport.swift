import AppKit
import ApplicationServices
import Foundation

/// Thin, error-checked wrappers over the C Accessibility API.
///
/// Two rules are enforced here rather than at every call site:
/// 1. A missing permission is reported as `PERMISSION_DENIED`, never as an empty
///    result - an untrusted process sees every app as a childless shell.
/// 2. "This element has no such attribute" is *not* an error (most elements lack
///    most attributes), but any other `AXError` is surfaced with context.
enum AX {
    /// Apps that are wedged will otherwise block the helper indefinitely.
    static let messagingTimeout: Float = 2.0

    static var isTrusted: Bool { AXIsProcessTrusted() }

    static func requireTrusted(_ what: String) throws {
        guard AXIsProcessTrusted() else {
            throw HelperError.permissionDenied(
                "Accessibility permission is required to \(what). \(HelperError.accessibilityHint)",
                permission: "accessibility")
        }
    }

    static func application(pid: pid_t) -> AXUIElement {
        let element = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(element, messagingTimeout)
        return element
    }

    // MARK: - Attribute reads

    /// Read an attribute that the element may legitimately not have.
    /// Returns `nil` for "unsupported"/"no value"; throws for everything else.
    static func optionalAttribute(_ element: AXUIElement, _ name: String) throws -> CFTypeRef? {
        var value: CFTypeRef?
        let err = AXUIElementCopyAttributeValue(element, name as CFString, &value)
        switch err {
        case .success: return value
        case .attributeUnsupported, .noValue: return nil
        default: throw HelperError.fromAX(err, while: "reading \(name)")
        }
    }

    static func string(_ element: AXUIElement, _ name: String) throws -> String? {
        guard let raw = try optionalAttribute(element, name) else { return nil }
        if let s = raw as? String { return s.isEmpty ? nil : s }
        // AXValue for a string attribute happens with number-ish values (e.g. a
        // slider's AXValue); render them rather than dropping the information.
        if let n = raw as? NSNumber { return n.stringValue }
        return nil
    }

    static func bool(_ element: AXUIElement, _ name: String) throws -> Bool? {
        guard let raw = try optionalAttribute(element, name) else { return nil }
        return (raw as? NSNumber)?.boolValue
    }

    static func children(_ element: AXUIElement) throws -> [AXUIElement] {
        guard let raw = try optionalAttribute(element, kAXChildrenAttribute) else { return [] }
        return raw as? [AXUIElement] ?? []
    }

    /// Children with cycles removed.
    ///
    /// The accessibility graph is not a tree. Real apps hand back an element
    /// that is already on the path from the root - macOS 15's Calculator lists
    /// *itself* among its own children - and a naive depth-first walk then burns
    /// its entire node budget re-describing the same subtree. Dropping any child
    /// that equals an ancestor keeps the traversal finite and the paths honest.
    static func acyclicChildren(_ element: AXUIElement, ancestors: [AXUIElement]) throws -> [(Int, AXUIElement)] {
        try children(element).enumerated().compactMap { index, child in
            if CFEqual(child, element) { return nil }
            if ancestors.contains(where: { CFEqual($0, child) }) { return nil }
            return (index, child)
        }
    }

    static func point(_ element: AXUIElement, _ name: String = kAXPositionAttribute) throws -> CGPoint? {
        guard let raw = try optionalAttribute(element, name), CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
        let axValue = unsafeDowncast(raw, to: AXValue.self)
        var p = CGPoint.zero
        guard AXValueGetValue(axValue, .cgPoint, &p) else { return nil }
        return p
    }

    static func size(_ element: AXUIElement, _ name: String = kAXSizeAttribute) throws -> CGSize? {
        guard let raw = try optionalAttribute(element, name), CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
        let axValue = unsafeDowncast(raw, to: AXValue.self)
        var s = CGSize.zero
        guard AXValueGetValue(axValue, .cgSize, &s) else { return nil }
        return s
    }

    static func element(_ element: AXUIElement, _ name: String) throws -> AXUIElement? {
        guard let raw = try optionalAttribute(element, name) else { return nil }
        // A CFTypeRef cannot be conditionally downcast to a CF class in Swift
        // (the cast always succeeds), so the type id check above is the check.
        guard CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
        return unsafeDowncast(raw, to: AXUIElement.self)
    }

    static func windows(of app: AXUIElement) throws -> [AXUIElement] {
        guard let raw = try optionalAttribute(app, kAXWindowsAttribute) else { return [] }
        // A locked screen (and a few apps with no open window) makes the
        // application element report *itself* as its own window list. Passing
        // that on would give callers an infinitely self-nesting "window".
        return (raw as? [AXUIElement] ?? []).filter { !CFEqual($0, app) }
    }

    static func actionNames(_ element: AXUIElement) throws -> [String] {
        var names: CFArray?
        let err = AXUIElementCopyActionNames(element, &names)
        switch err {
        case .success: return (names as? [String]) ?? []
        case .attributeUnsupported, .actionUnsupported, .noValue: return []
        default: throw HelperError.fromAX(err, while: "listing actions")
        }
    }

    static func perform(_ element: AXUIElement, action: String) throws {
        let err = AXUIElementPerformAction(element, action as CFString)
        guard err == .success else {
            throw HelperError.fromAX(err, while: "performing \(action)")
        }
    }

    /// Hit-test a screen point. Used only to verify a coordinate fallback click.
    static func elementAt(_ point: CGPoint) throws -> AXUIElement? {
        let system = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(system, messagingTimeout)
        var hit: AXUIElement?
        let err = AXUIElementCopyElementAtPosition(system, Float(point.x), Float(point.y), &hit)
        switch err {
        case .success: return hit
        case .noValue, .invalidUIElement: return nil
        default: throw HelperError.fromAX(err, while: "hit-testing (\(point.x), \(point.y))")
        }
    }

    // MARK: - Projection

    /// The flat, child-free description of an element. `inspect` nests these;
    /// `find` and `click` return them as a verification snapshot.
    static func describe(_ element: AXUIElement, path: String?) throws -> [String: JSONValue] {
        var node: [String: JSONValue] = [
            "role": .optionalString(try string(element, kAXRoleAttribute)),
            "subrole": .optionalString(try string(element, kAXSubroleAttribute)),
            "title": .optionalString(try string(element, kAXTitleAttribute)),
            "label": .optionalString(try string(element, kAXDescriptionAttribute)),
            "value": .optionalString(try string(element, kAXValueAttribute)),
            "identifier": .optionalString(try string(element, kAXIdentifierAttribute)),
            "enabled": .optionalBool(try bool(element, kAXEnabledAttribute)),
            "focused": .optionalBool(try bool(element, kAXFocusedAttribute)),
            "position": .point(try point(element)),
            "size": .size(try size(element)),
        ]
        if let path { node["path"] = .string(path) }
        return node
    }

    /// The centre of an element in screen coordinates, if it has a frame.
    static func centre(of element: AXUIElement) throws -> CGPoint? {
        guard let origin = try point(element), let extent = try size(element) else { return nil }
        return CGPoint(x: origin.x + extent.width / 2, y: origin.y + extent.height / 2)
    }
}

/// A slash-separated list of child indices from a root element, e.g. `"0/3/2"`.
///
/// This is the "stable path" that semantic selectors hand back: it survives
/// re-inspection of an unchanged window and lets `click` re-resolve an element
/// without coordinates. It is *not* durable across relayout, which is why
/// `click` re-validates role/label after resolving a path.
enum AXPath {
    static func child(_ parent: String?, _ index: Int) -> String {
        guard let parent, !parent.isEmpty else { return String(index) }
        return "\(parent)/\(index)"
    }

    static func resolve(_ path: String, from root: AXUIElement) throws -> AXUIElement {
        var current = root
        let components = path.split(separator: "/")
        for (depth, component) in components.enumerated() {
            guard let index = Int(component), index >= 0 else {
                throw HelperError.validation("Malformed element path '\(path)'")
            }
            let kids = try AX.children(current)
            guard index < kids.count else {
                throw HelperError.notFound(
                    "Element path '\(path)' no longer resolves: component \(depth) (index \(index)) "
                        + "is out of range, the UI has \(kids.count) children there. Re-run find/inspect.",
                    details: ["path": .string(path)])
            }
            current = kids[index]
        }
        return current
    }
}
