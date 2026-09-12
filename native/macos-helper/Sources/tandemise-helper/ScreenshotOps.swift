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
/// ScreenCaptureKit is the supported API and the one that keeps working as
/// CoreGraphics capture is withdrawn; `CGWindowListCreateImage` is kept as a
/// fallback because SCK has no way to capture an off-screen or minimised window
/// and occasionally fails on virtual displays. The response always names which
/// path produced the image - a caller comparing screenshots across runs needs to
/// know when the source changed.
enum ScreenshotOps {
    static func capture(_ params: Params) throws -> JSONValue {
        guard CGPreflightScreenCaptureAccess() else {
            throw HelperError.permissionDenied(
                "Screen Recording permission is required to take screenshots. " + HelperError.screenRecordingHint,
                permission: "screenRecording")
        }

        let target = try resolveTarget(params)
        let allowFallback = params.bool("allowDeprecatedFallback") ?? true

        var image: CGImage?
        var method = "ScreenCaptureKit"
        var fallbackReason: String?

        do {
            image = try captureWithScreenCaptureKit(target, timeout: 15)
        } catch let error as HelperError {
            guard allowFallback else { throw error }
            fallbackReason = "\(error.code): \(error.message)"
        }

        if image == nil {
            guard allowFallback else {
                throw HelperError.internalError("ScreenCaptureKit returned no image")
            }
            method = "CGWindowListCreateImage"
            image = try captureWithCoreGraphics(target)
        }

        guard let image else {
            throw HelperError.internalError("Screen capture produced no image for \(target.describedTarget)")
        }
        let png = try encodePNG(image)

        return .object([
            "target": .string(target.describedTarget),
            "method": .string(method),
            "deprecatedApi": .bool(method == "CGWindowListCreateImage"),
            "fallbackReason": .optionalString(fallbackReason),
            "width": .int(image.width),
            "height": .int(image.height),
            "bytes": .int(png.count),
            "format": .string("png"),
            "base64": .string(png.base64EncodedString()),
        ])
    }

    // MARK: - Target

    private enum Target {
        case window(id: CGWindowID, label: String)
        case display(id: CGDirectDisplayID)

        var describedTarget: String {
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

    // MARK: - ScreenCaptureKit

    private static func captureWithScreenCaptureKit(_ target: Target, timeout: TimeInterval) throws -> CGImage {
        let box = ResultBox<CGImage>()
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
        case .success(let image): return image
        case .failure(let error as HelperError): throw error
        case .failure(let error):
            throw HelperError("TARGET_UNAVAILABLE",
                              "ScreenCaptureKit failed: \(error.localizedDescription)")
        }
    }

    private static func captureAsync(_ target: Target) async throws -> CGImage {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let filter: SCContentFilter
        let configuration = SCStreamConfiguration()
        configuration.showsCursor = false
        configuration.captureResolution = .best

        switch target {
        case .window(let id, _):
            guard let window = content.windows.first(where: { $0.windowID == id }) else {
                throw HelperError.notFound("ScreenCaptureKit does not see window \(id); it may be off-screen",
                                           details: ["windowId": .int(Int(id))])
            }
            filter = SCContentFilter(desktopIndependentWindow: window)
        case .display(let id):
            guard let display = content.displays.first(where: { $0.displayID == id }) else {
                throw HelperError.notFound("No display with id \(id)", details: ["displayId": .int(Int(id))])
            }
            filter = SCContentFilter(display: display, excludingWindows: [])
        }

        // `contentRect` is in points; a Retina capture wants the backing pixels.
        let scale = filter.pointPixelScale
        configuration.width = max(1, Int(filter.contentRect.width * CGFloat(scale)))
        configuration.height = max(1, Int(filter.contentRect.height * CGFloat(scale)))

        return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
    }

    // MARK: - CoreGraphics fallback

    private static func captureWithCoreGraphics(_ target: Target) throws -> CGImage {
        switch target {
        case .window(let id, let label):
            // Deprecated since macOS 14 but still functional, and the only way to
            // reach a window ScreenCaptureKit will not enumerate.
            guard let image = CGWindowListCreateImage(.null, .optionIncludingWindow, id,
                                                      [.boundsIgnoreFraming, .bestResolution]) else {
                throw HelperError.notFound("Could not capture window \(id) (\(label)); it may have closed",
                                           details: ["windowId": .int(Int(id))])
            }
            return image
        case .display(let id):
            guard let image = CGDisplayCreateImage(id) else {
                throw HelperError.notFound("Could not capture display \(id)", details: ["displayId": .int(Int(id))])
            }
            return image
        }
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
