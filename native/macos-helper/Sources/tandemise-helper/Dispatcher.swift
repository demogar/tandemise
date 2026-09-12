import Foundation

/// Maps an op name to its implementation. This is the whole public surface of
/// the helper; `packages/desktop-control` mirrors it one-for-one.
enum Dispatcher {
    static let version = "0.1.0"

    static let operations = [
        "ping", "permissions", "requestPermissions", "listApps", "listInstalledApps",
        "launch", "activate", "windows", "inspect", "find", "click", "type",
        "shortcut", "screenshot", "shutdown",
    ]

    /// Set by `shutdown`; the reader loop exits once the response is flushed.
    private(set) static var shutdownRequested = false

    static func handle(_ request: HelperRequest) -> HelperResponse {
        let params = Params(request.params, op: request.op)
        do {
            return .success(id: request.id, try run(request.op, params))
        } catch let error as HelperError {
            return .failure(id: request.id, error)
        } catch {
            return .failure(id: request.id,
                            .internalError("Unhandled failure in '\(request.op)': \(error.localizedDescription)"))
        }
    }

    private static func run(_ op: String, _ params: Params) throws -> JSONValue {
        switch op {
        case "ping":
            return .object([
                "version": .string(version),
                "pid": .int(Int(ProcessInfo.processInfo.processIdentifier)),
                "macOS": .string(ProcessInfo.processInfo.operatingSystemVersionString),
                "operations": .array(operations.map(JSONValue.string)),
            ])
        case "permissions":
            return Permissions.report()
        case "requestPermissions":
            return Permissions.request(params)
        case "listApps":
            return AppOps.listRunning()
        case "listInstalledApps":
            return AppOps.listInstalled()
        case "launch":
            return try AppOps.launch(params)
        case "activate":
            return try AppOps.activate(params)
        case "windows":
            return try WindowOps.list(params)
        case "inspect":
            return try InspectOps.inspect(params)
        case "find":
            return try InspectOps.find(params)
        case "click":
            return try InspectOps.click(params)
        case "type":
            return try Input.type(params)
        case "shortcut":
            return try Input.shortcut(params)
        case "screenshot":
            return try ScreenshotOps.capture(params)
        case "shutdown":
            shutdownRequested = true
            return .object(["stopping": .bool(true)])
        default:
            throw HelperError.validation("Unknown op '\(op)'. Supported: \(operations.joined(separator: ", "))",
                                         details: ["op": .string(op)])
        }
    }
}
