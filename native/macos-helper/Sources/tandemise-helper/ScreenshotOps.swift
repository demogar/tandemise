import AppKit
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

/// A thread-safe one-shot slot, used to bring an `async` ScreenCaptureKit call
/// back onto the main thread without a semaphore (see `RunLoopWait`).
private final class ResultBox<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Result<T, Error>?

    var isSettled: Bool {
        lock.lock(); defer { lock.unlock() }
        return stored != nil
    }

    func settle(_ value: Result<T, Error>) {
        lock.lock(); defer { lock.unlock() }
        if stored == nil { stored = value }
    }

    func take() -> Result<T, Error>? {
        lock.lock(); defer { lock.unlock() }
        return stored
    }
}

/// Window-scoped screen capture (MVP.md §13.3).
///
/// ScreenCaptureKit is the *only* capture path here. The obvious fallback,
/// `CGWindowListCreateImage`, is not merely deprecated on the macOS 15 target -
/// it is marked `obsoleted: 15.0` and will not compile against that SDK, so a
/// "deprecated but functional" fallback is no longer available to a modern
/// deployment target. What replaces it is a second ScreenCaptureKit strategy:
/// when SCK will not enumerate a window (it omits some off-screen and
/// non-standard windows), capture the display it sits on and crop to the window
/// bounds reported by `CGWindowListCopyWindowInfo`. The response always names
/// the strategy that produced the image.
enum ScreenshotOps {
    static func capture(_ params: Params) throws -> JSONValue {
        guard CGPreflightScreenCaptureAccess() else {
            throw HelperError.permissionDenied(
                "Screen Recording permission is required to take screenshots. " + HelperError.screenRecordingHint,
                permission: "screenRecording")
        }

        let target = try resolveTarget(params)
        let capture = try run(target, timeout: TimeInterval(params.clampedInt("timeoutMs", default: 15_000, min: 1_000, max: 60_000)) / 1000)
        let png = try encodePNG(capture.image)

        return .object([
            "target": .string(target.described),
            "api": .string("ScreenCaptureKit"),
            "method": .string(capture.method),
            "fallbackReason": .optionalString(capture.fallbackReason),
            "width": .int(capture.image.width),
            "height": .int(capture.image.height),
            "bytes": .int(png.count),
            "format": .string("png"),
            "base64": .string(png.base64EncodedString()),
        ])
    }

    // MARK: - Target

    private enum Target {
        case window(id: CGWindowID, label: String)
        case display(id: CGDirectDisplayID)

        var described: String {
            switch self {
            case .window(let id, let label): return "window \(id) (\(label))"
            case .display(let id): return "display \(id)"
            }
        }
    }

    private static func resolveTarget(_ params: Params) throws -> Target {
        if let windowId = params.int("windowId") {
            return .window(id: CGWindowID(windowId), label: "explicit")
        }
        if params.has("bundleId") || params.has("appName") || params.has("pid") {
            let app = try AppOps.resolveRunningApplication(params)
            guard let windowId = try WindowOps.primaryWindowId(pid: app.processIdentifier) else {
                throw HelperError.notFound(
                    "\(app.localizedName ?? "The application") has no on-screen window to capture; "
                        + "it may be minimised or hidden",
                    details: ["pid": .int(Int(app.processIdentifier))])
            }
            return .window(id: CGWindowID(windowId), label: app.localizedName ?? app.bundleIdentifier ?? "app")
        }
        if let displayId = params.int("displayId") {
            return .display(id: CGDirectDisplayID(displayId))
        }
        return .display(id: CGMainDisplayID())
    }

    // MARK: - Capture

    private struct Capture {
        let image: CGImage
        let method: String
        let fallbackReason: String?
    }

    private static func run(_ target: Target, timeout: TimeInterval) throws -> Capture {
        let box = ResultBox<Capture>()
        Task.detached {
            do {
                box.settle(.success(try await captureAsync(target)))
            } catch {
                box.settle(.failure(error))
            }
        }
        guard RunLoopWait.until(timeout: timeout, { box.isSettled }), let outcome = box.take() else {
            throw HelperError.timeout("ScreenCaptureKit did not return an image within \(Int(timeout))s")
        }
        switch outcome {
        case .success(let capture): return capture
        case .failure(let error as HelperError): throw error
        case .failure(let error):
            throw HelperError("TARGET_UNAVAILABLE", "ScreenCaptureKit failed: \(error.localizedDescription)")
        }
    }

    private static func captureAsync(_ target: Target) async throws -> Capture {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)

        switch target {
        case .display(let id):
            guard let display = content.displays.first(where: { $0.displayID == id }) else {
                throw HelperError.notFound("No display with id \(id)", details: ["displayId": .int(Int(id))])
            }
            let filter = SCContentFilter(display: display, excludingWindows: [])
            return Capture(image: try await image(for: filter), method: "display", fallbackReason: nil)

        case .window(let id, let label):
            if let window = content.windows.first(where: { $0.windowID == id }) {
                let filter = SCContentFilter(desktopIndependentWindow: window)
                return Capture(image: try await image(for: filter), method: "window", fallbackReason: nil)
            }
            return try await captureByCropping(windowId: id, label: label, content: content)
        }
    }

    /// Last resort for a window ScreenCaptureKit will not enumerate: shoot the
    /// display and cut the window's rectangle out of it.
    private static func captureByCropping(windowId: CGWindowID, label: String,
                                          content: SCShareableContent) async throws -> Capture {
        guard let record = CGWindowRecord.onScreen().first(where: { $0.windowId == Int(windowId) }) else {
            throw HelperError.notFound("No window with id \(windowId) (\(label)); it may have closed",
                                       details: ["windowId": .int(Int(windowId))])
        }
        guard let display = content.displays.first(where: { $0.frame.intersects(record.bounds) })
            ?? content.displays.first else {
            throw HelperError.notFound("No display contains window \(windowId) (\(label))")
        }

        let filter = SCContentFilter(display: display, excludingWindows: [])
        let full = try await image(for: filter)
        let scale = CGFloat(filter.pointPixelScale)
        let cropRect = CGRect(x: (record.bounds.minX - display.frame.minX) * scale,
                              y: (record.bounds.minY - display.frame.minY) * scale,
                              width: record.bounds.width * scale,
                              height: record.bounds.height * scale)
            .intersection(CGRect(x: 0, y: 0, width: CGFloat(full.width), height: CGFloat(full.height)))

        guard !cropRect.isNull, cropRect.width >= 1, cropRect.height >= 1, let cropped = full.cropping(to: cropRect) else {
            throw HelperError.notFound("Window \(windowId) (\(label)) is not visible on any display")
        }
        return Capture(image: cropped, method: "display-crop",
                       fallbackReason: "ScreenCaptureKit does not enumerate window \(windowId); cropped from display \(display.displayID)")
    }

    private static func image(for filter: SCContentFilter) async throws -> CGImage {
        let configuration = SCStreamConfiguration()
        configuration.showsCursor = false
        configuration.captureResolution = .best
        // `contentRect` is in points; a Retina capture wants the backing pixels.
        let scale = CGFloat(filter.pointPixelScale)
        configuration.width = max(1, Int(filter.contentRect.width * scale))
        configuration.height = max(1, Int(filter.contentRect.height * scale))
        return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
    }

    // MARK: - Encoding

    private static func encodePNG(_ image: CGImage) throws -> Data {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            data, UTType.png.identifier as CFString, 1, nil) else {
            throw HelperError.internalError("Could not create a PNG encoder")
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else {
            throw HelperError.internalError("PNG encoding failed")
        }
        return data as Data
    }
}
