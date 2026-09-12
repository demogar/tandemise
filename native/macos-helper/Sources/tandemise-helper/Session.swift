import CoreGraphics
import Foundation

/// Login-session state.
///
/// A locked screen degrades the Accessibility API in a uniquely confusing way:
/// calls keep succeeding, but every application reports zero windows and hands
/// back its own element in place of a window list. Without this check a caller
/// sees an empty UI and concludes the app is broken. Detecting the lock turns a
/// mystery into one sentence.
enum Session {
    static var isScreenLocked: Bool {
        guard let dictionary = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
        return (dictionary["CGSSessionScreenIsLocked"] as? NSNumber)?.boolValue ?? false
    }

    static func requireUnlocked(_ what: String) throws {
        guard isScreenLocked else { return }
        throw HelperError("PRECONDITION_FAILED",
                          "The screen is locked, so macOS hides every application's user interface; "
                              + "\(what) cannot work until the session is unlocked.",
                          details: ["screenLocked": .bool(true)])
    }
}
