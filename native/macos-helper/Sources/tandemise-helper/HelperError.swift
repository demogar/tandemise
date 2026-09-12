import ApplicationServices
import Foundation

/// A failure with a machine-readable code.
///
/// The codes are deliberately a subset of `@tandemise/shared`'s `ErrorCode` so
/// the TypeScript client can rethrow them as `TandemiseError` without a
/// translation table. The distinction that matters most in practice is
/// `PERMISSION_DENIED` vs `NOT_FOUND`: a missing Accessibility grant makes every
/// app look empty, and reporting that as "not found" sends the user hunting for
/// a bug instead of opening System Settings.
struct HelperError: Error {
    let code: String
    let message: String
    let details: [String: JSONValue]

    init(_ code: String, _ message: String, details: [String: JSONValue] = [:]) {
        self.code = code
        self.message = message
        self.details = details
    }

    static func validation(_ message: String, details: [String: JSONValue] = [:]) -> HelperError {
        HelperError("VALIDATION", message, details: details)
    }

    static func notFound(_ message: String, details: [String: JSONValue] = [:]) -> HelperError {
        HelperError("NOT_FOUND", message, details: details)
    }

    static func permissionDenied(_ message: String, permission: String) -> HelperError {
        HelperError("PERMISSION_DENIED", message, details: ["permission": .string(permission)])
    }

    static func unsupported(_ message: String, details: [String: JSONValue] = [:]) -> HelperError {
        HelperError("UNSUPPORTED", message, details: details)
    }

    static func timeout(_ message: String, details: [String: JSONValue] = [:]) -> HelperError {
        HelperError("TIMEOUT", message, details: details)
    }

    static func internalError(_ message: String, details: [String: JSONValue] = [:]) -> HelperError {
        HelperError("INTERNAL", message, details: details)
    }

    static let accessibilityHint =
        "Grant Accessibility in System Settings \u{2192} Privacy & Security \u{2192} Accessibility."
    static let screenRecordingHint =
        "Grant Screen Recording in System Settings \u{2192} Privacy & Security \u{2192} Screen Recording."

    /// Translate an `AXError` into a coded failure.
    ///
    /// `.apiDisabled` and `.notImplemented` both show up when the process is not
    /// trusted, which is why the caller should have checked `AXIsProcessTrusted()`
    /// first - this mapping is the second line of defence, not the first.
    static func fromAX(_ err: AXError, while context: String) -> HelperError {
        switch err {
        case .success:
            return .internalError("AX call for \(context) reported success in a failure path")
        case .apiDisabled:
            return .permissionDenied(
                "The Accessibility API is disabled for this process (while \(context)). \(accessibilityHint)",
                permission: "accessibility")
        case .notImplemented:
            return .permissionDenied(
                "The target process did not respond to the Accessibility API (while \(context)). "
                    + "This is usually a missing Accessibility grant. \(accessibilityHint)",
                permission: "accessibility")
        case .invalidUIElement, .invalidUIElementObserver:
            return .notFound("The accessibility element is no longer valid (while \(context)); the window or app probably closed")
        case .attributeUnsupported, .actionUnsupported, .parameterizedAttributeUnsupported:
            return .unsupported("The element does not support that attribute or action (while \(context))")
        case .noValue:
            return .notFound("The element has no value for that attribute (while \(context))")
        case .cannotComplete:
            return HelperError("TARGET_UNAVAILABLE",
                               "The target application did not respond in time (while \(context)); it may be busy or hung")
        case .illegalArgument:
            return .validation("Illegal argument passed to the Accessibility API (while \(context))")
        case .failure, .notEnoughPrecision:
            return .internalError("The Accessibility API failed (while \(context)); AXError=\(err.rawValue)")
        @unknown default:
            return .internalError("Unknown AXError \(err.rawValue) (while \(context))")
        }
    }
}
