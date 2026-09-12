import Foundation

/// tandemise-helper - newline-delimited JSON over stdin/stdout.
///
/// One request per line in, one response per line out, correlated by `id`.
/// A process boundary with a text protocol is deliberately the *only* coupling
/// between Tandemise's TypeScript core and native macOS APIs (MVP.md §33): the
/// core never links a Swift library, the helper is independently runnable, and
/// the whole surface is testable by piping JSON at it.
///
/// Threading: AppKit and the Accessibility API both expect the main thread, and
/// several ops depend on main-queue callbacks. So the main thread runs the run
/// loop and executes every op, while a reader thread does the blocking stdin
/// read and hands work over. Requests are processed strictly one at a time -
/// serialising them costs nothing at this scale and removes any question of two
/// AX traversals interleaving.

let reader = Thread {
    while let line = readLine(strippingNewline: true) {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { continue }

        guard let data = trimmed.data(using: .utf8) else {
            Wire.write(.failure(id: "", .validation("Request line was not valid UTF-8")))
            continue
        }

        let request: HelperRequest
        do {
            request = try JSONDecoder().decode(HelperRequest.self, from: data)
        } catch {
            // Without a decodable `id` there is nobody to correlate the failure
            // to, but staying silent would hang a client that is waiting.
            Wire.write(.failure(id: "", .validation("Malformed request: \(error.localizedDescription)")))
            continue
        }

        var response: HelperResponse?
        DispatchQueue.main.async {
            response = Dispatcher.handle(request)
        }
        // Blocking here is what keeps execution serial: the next line is not
        // even read until this response has been written.
        while response == nil { Thread.sleep(forTimeInterval: 0.002) }
        guard let response else { continue }

        Wire.write(response)
        if Dispatcher.shutdownRequested {
            exit(0)
        }
    }
    // stdin closed: the parent went away.
    exit(0)
}

reader.name = "tandemise-helper.stdin"
reader.stackSize = 1 << 20
reader.start()

RunLoop.main.run()
