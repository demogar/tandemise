import ApplicationServices
import CoreGraphics
import Foundation

/// Synthetic keyboard and mouse input via CGEvent.
///
/// Posting to `.cghidEventTap` requires the same Accessibility grant as the AX
/// API, and silently does nothing without it - which is the worst possible
/// failure mode for an agent, since the action *appears* to succeed. Every entry
/// point therefore checks the grant first and fails loudly.
enum Input {
    static func requireEventPermission(_ what: String) throws {
        guard AXIsProcessTrusted() else {
            throw HelperError.permissionDenied(
                "Accessibility permission is required to \(what); without it synthetic events are silently discarded. "
                    + HelperError.accessibilityHint,
                permission: "accessibility")
        }
    }

    private static func makeSource() throws -> CGEventSource {
        guard let source = CGEventSource(stateID: .hidSystemState) else {
            throw HelperError.internalError("Could not create a CGEventSource; the window server rejected the request")
        }
        return source
    }

    // MARK: - type

    static func type(_ params: Params) throws -> JSONValue {
        let text = try params.requiredString("text")
        try requireEventPermission("type text")
        let source = try makeSource()
        let perKeyDelay = TimeInterval(params.clampedInt("delayMs", default: 4, min: 0, max: 500)) / 1000

        var sentEvents = 0
        // Split on newlines so line breaks arrive as a real Return keypress;
        // a U+000A delivered through keyboardSetUnicodeString is ignored by many
        // text views and never submits a form.
        let lines = text.components(separatedBy: "\n")
        for (index, line) in lines.enumerated() {
            if index > 0 {
                try tap(source: source, keyCode: KeyMap.returnKey, flags: [], delay: perKeyDelay)
                sentEvents += 2
            }
            for chunk in chunked(line, maxUTF16: 16) {
                try emitUnicode(chunk, source: source, delay: perKeyDelay)
                sentEvents += 2
            }
        }

        return .object(["typedCharacters": .int(text.count), "events": .int(sentEvents)])
    }

    /// `keyboardSetUnicodeString` takes a bounded buffer, so long text is split -
    /// but never mid-grapheme, or combining marks and emoji arrive corrupted.
    private static func chunked(_ text: String, maxUTF16: Int) -> [String] {
        var chunks: [String] = []
        var current = ""
        var currentUnits = 0
        for character in text {
            let units = String(character).utf16.count
            if currentUnits + units > maxUTF16, !current.isEmpty {
                chunks.append(current)
                current = ""
                currentUnits = 0
            }
            current.append(character)
            currentUnits += units
        }
        if !current.isEmpty { chunks.append(current) }
        return chunks
    }

    private static func emitUnicode(_ text: String, source: CGEventSource, delay: TimeInterval) throws {
        let units = Array(text.utf16)
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else {
            throw HelperError.internalError("Could not create a keyboard event for '\(text)'")
        }
        down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
        up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
        if delay > 0 { Thread.sleep(forTimeInterval: delay) }
    }

    // MARK: - shortcut

    static func shortcut(_ params: Params) throws -> JSONValue {
        guard let keys = try params.stringArray("keys"), !keys.isEmpty else {
            throw HelperError.validation("shortcut requires a non-empty 'keys' array, e.g. [\"CMD\", \"R\"]")
        }
        try requireEventPermission("send a keyboard shortcut")

        var flags: CGEventFlags = []
        var modifierNames: [String] = []
        var mainKey: (name: String, code: CGKeyCode)?

        for key in keys {
            if let modifier = KeyMap.modifier(key) {
                flags.insert(modifier)
                modifierNames.append(key.uppercased())
                continue
            }
            guard let code = KeyMap.keyCode(key) else {
                throw HelperError.validation("Unknown key '\(key)'. Use a letter, digit, F1-F20, or one of: "
                                                + KeyMap.namedKeyList,
                                             details: ["key": .string(key)])
            }
            guard mainKey == nil else {
                throw HelperError.validation("A shortcut may contain at most one non-modifier key; got '\(mainKey?.name ?? "")' and '\(key)'")
            }
            mainKey = (key, code)
        }

        guard let mainKey else {
            throw HelperError.validation("A shortcut needs one non-modifier key, e.g. [\"CMD\", \"R\"]")
        }

        let source = try makeSource()
        try tap(source: source, keyCode: mainKey.code, flags: flags,
                delay: TimeInterval(params.clampedInt("delayMs", default: 12, min: 0, max: 500)) / 1000)

        return .object([
            "modifiers": .array(modifierNames.map(JSONValue.string)),
            "key": .string(mainKey.name.uppercased()),
            "keyCode": .int(Int(mainKey.code)),
        ])
    }

    private static func tap(source: CGEventSource, keyCode: CGKeyCode, flags: CGEventFlags,
                            delay: TimeInterval) throws {
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false) else {
            throw HelperError.internalError("Could not create a keyboard event for key code \(keyCode)")
        }
        down.flags = flags
        up.flags = flags
        down.post(tap: .cghidEventTap)
        if delay > 0 { Thread.sleep(forTimeInterval: delay) }
        up.post(tap: .cghidEventTap)
        if delay > 0 { Thread.sleep(forTimeInterval: delay) }
    }

    // MARK: - mouse

    static func click(at point: CGPoint, button: String, clickCount: Int) throws {
        let (downType, upType, mouseButton): (CGEventType, CGEventType, CGMouseButton)
        switch button.lowercased() {
        case "left": (downType, upType, mouseButton) = (.leftMouseDown, .leftMouseUp, .left)
        case "right": (downType, upType, mouseButton) = (.rightMouseDown, .rightMouseUp, .right)
        case "middle": (downType, upType, mouseButton) = (.otherMouseDown, .otherMouseUp, .center)
        default:
            throw HelperError.validation("Unknown mouse button '\(button)'; expected left, right or middle")
        }

        let source = try makeSource()
        guard let move = CGEvent(mouseEventSource: source, mouseType: .mouseMoved,
                                 mouseCursorPosition: point, mouseButton: mouseButton) else {
            throw HelperError.internalError("Could not create a mouse-move event")
        }
        move.post(tap: .cghidEventTap)

        for index in 1...clickCount {
            guard let down = CGEvent(mouseEventSource: source, mouseType: downType,
                                     mouseCursorPosition: point, mouseButton: mouseButton),
                  let up = CGEvent(mouseEventSource: source, mouseType: upType,
                                   mouseCursorPosition: point, mouseButton: mouseButton) else {
                throw HelperError.internalError("Could not create a mouse-click event")
            }
            // Without the click-state field a second click is a second single
            // click, not a double click.
            down.setIntegerValueField(.mouseEventClickState, value: Int64(index))
            up.setIntegerValueField(.mouseEventClickState, value: Int64(index))
            down.post(tap: .cghidEventTap)
            up.post(tap: .cghidEventTap)
            if index < clickCount { Thread.sleep(forTimeInterval: 0.05) }
        }
    }
}
