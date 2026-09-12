import ApplicationServices
import CoreGraphics
import Foundation

/// TCC status reporting and (only when explicitly asked) prompting.
///
/// `permissions` must never prompt: it is called on every health check and a
/// surprise system dialog during a background probe is hostile. Prompting lives
/// behind `requestPermissions`, which a human has chosen to trigger.
enum Permissions {
    static func report() -> JSONValue {
        let accessibility = AXIsProcessTrusted()
        let screenRecording = CGPreflightScreenCaptureAccess()
        return .object([
            "accessibility": .bool(accessibility),
            "screenRecording": .bool(screenRecording),
            "hints": .object([
                "accessibility": .string(accessibility ? "granted" : HelperError.accessibilityHint),
                "screenRecording": .string(screenRecording ? "granted" : HelperError.screenRecordingHint),
            ]),
            // TCC is granted to the *responsible* process, which for a spawned
            // helper is usually the app that launched it (Terminal, the daemon's
            // bundle...). Surfacing the binary path makes "I granted it but it
            // still says no" diagnosable.
            "executablePath": .string(CommandLine.arguments.first ?? ""),
        ])
    }

    static func request(_ params: Params) -> JSONValue {
        let wantAccessibility = params.bool("accessibility") ?? true
        let wantScreenRecording = params.bool("screenRecording") ?? true

        var accessibility = AXIsProcessTrusted()
        if wantAccessibility && !accessibility {
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            accessibility = AXIsProcessTrustedWithOptions(options)
        }

        var screenRecording = CGPreflightScreenCaptureAccess()
        if wantScreenRecording && !screenRecording {
            // Returns false the first time even on success: the grant only takes
            // effect after the process restarts.
            screenRecording = CGRequestScreenCaptureAccess()
        }

        return .object([
            "accessibility": .bool(accessibility),
            "screenRecording": .bool(screenRecording),
            "prompted": .bool((wantAccessibility && !accessibility) || (wantScreenRecording && !screenRecording)),
            "note": .string("A newly granted permission may require this helper to be restarted before it takes effect."),
        ])
    }
}
