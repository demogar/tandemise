import CoreGraphics
import Foundation

/// Key-name to virtual-key-code translation for `shortcut`.
///
/// These are ANSI (US layout) virtual key codes. The alternative - resolving
/// through the active keyboard layout via `UCKeyTranslate` - would honour Dvorak
/// and non-US layouts, but macOS itself defines menu shortcuts against these
/// same physical codes, so `["CMD","R"]` reaches the Run menu item on every
/// layout. That is the behaviour callers want; a per-layout mapping is a
/// deliberate non-goal.
enum KeyMap {
    static let returnKey: CGKeyCode = 36

    static func modifier(_ name: String) -> CGEventFlags? {
        switch name.uppercased() {
        case "CMD", "COMMAND", "META": return .maskCommand
        case "SHIFT": return .maskShift
        case "ALT", "OPT", "OPTION": return .maskAlternate
        case "CTRL", "CONTROL": return .maskControl
        case "FN", "FUNCTION": return .maskSecondaryFn
        case "CAPS", "CAPSLOCK": return .maskAlphaShift
        default: return nil
        }
    }

    static func keyCode(_ name: String) -> CGKeyCode? {
        let key = name.uppercased()
        if let code = named[key] { return code }
        // F1-F20
        if key.hasPrefix("F"), let index = Int(key.dropFirst()), (1...20).contains(index) {
            return functionKeys[index - 1]
        }
        return nil
    }

    static var namedKeyList: String {
        named.keys.sorted().joined(separator: ", ")
    }

    private static let functionKeys: [CGKeyCode] = [
        122, 120, 99, 118, 96, 97, 98, 100, 101, 109,
        103, 111, 105, 107, 113, 106, 64, 79, 80, 90,
    ]

    private static let named: [String: CGKeyCode] = [
        "A": 0, "B": 11, "C": 8, "D": 2, "E": 14, "F": 3, "G": 5, "H": 4, "I": 34,
        "J": 38, "K": 40, "L": 37, "M": 46, "N": 45, "O": 31, "P": 35, "Q": 12,
        "R": 15, "S": 1, "T": 17, "U": 32, "V": 9, "W": 13, "X": 7, "Y": 16, "Z": 6,

        "0": 29, "1": 18, "2": 19, "3": 20, "4": 21,
        "5": 23, "6": 22, "7": 26, "8": 28, "9": 25,

        "RETURN": 36, "ENTER": 36, "TAB": 48, "SPACE": 49, "DELETE": 51,
        "BACKSPACE": 51, "FORWARDDELETE": 117, "ESCAPE": 53, "ESC": 53,
        "HOME": 115, "END": 119, "PAGEUP": 116, "PAGEDOWN": 121,
        "LEFT": 123, "RIGHT": 124, "DOWN": 125, "UP": 126,

        "MINUS": 27, "EQUAL": 24, "LEFTBRACKET": 33, "RIGHTBRACKET": 30,
        "BACKSLASH": 42, "SEMICOLON": 41, "QUOTE": 39, "COMMA": 43,
        "PERIOD": 47, "SLASH": 44, "GRAVE": 50,
    ]
}
