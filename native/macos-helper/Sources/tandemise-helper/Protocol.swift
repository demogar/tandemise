import Foundation

/// One newline-delimited JSON request. `params` is op-specific and validated by
/// each op through `Params`.
struct HelperRequest: Decodable {
    let id: String
    let op: String
    let params: JSONValue?
}

/// One newline-delimited JSON response. Exactly one of `result`/`error` is set,
/// discriminated by `ok`, so the client never has to guess.
struct HelperResponse: Encodable {
    let id: String
    let ok: Bool
    let result: JSONValue?
    let error: ErrorBody?

    struct ErrorBody: Encodable {
        let code: String
        let message: String
        let details: [String: JSONValue]
    }

    static func success(id: String, _ result: JSONValue) -> HelperResponse {
        HelperResponse(id: id, ok: true, result: result, error: nil)
    }

    static func failure(id: String, _ error: HelperError) -> HelperResponse {
        HelperResponse(id: id, ok: false, result: nil,
                       error: ErrorBody(code: error.code, message: error.message, details: error.details))
    }
}

/// stdout carries the protocol and nothing else; every diagnostic goes to stderr.
enum Wire {
    private static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        // Escaped slashes would be legal but make base64 PNG payloads noisier.
        e.outputFormatting = [.withoutEscapingSlashes]
        return e
    }()

    static func write(_ response: HelperResponse) {
        let data: Data
        do {
            data = try encoder.encode(response)
        } catch {
            // Encoding a response must never take the process down, and the
            // client is blocked waiting on this id.
            let fallback = HelperResponse.failure(
                id: response.id,
                .internalError("Failed to encode the response: \(error.localizedDescription)"))
            guard let recovered = try? encoder.encode(fallback) else { return }
            emit(recovered)
            return
        }
        emit(data)
    }

    static func log(_ message: String) {
        guard let data = ("[tandemise-helper] " + message + "\n").data(using: .utf8) else { return }
        FileHandle.standardError.write(data)
    }

    private static func emit(_ data: Data) {
        var line = data
        line.append(0x0A)
        FileHandle.standardOutput.write(line)
    }
}
