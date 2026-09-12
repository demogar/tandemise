import Foundation

/// Block the main thread until `condition` holds, *while still servicing the
/// main run loop*.
///
/// Every op runs on the main thread (AppKit and the Accessibility API both want
/// that). Several of them - launching an app, taking a ScreenCaptureKit
/// screenshot - depend on a callback that is itself delivered to the main queue,
/// so a plain `DispatchSemaphore.wait()` here would deadlock. Spinning the run
/// loop lets those callbacks land. Re-entrancy is not a concern: the reader
/// thread never submits a second request before the first has answered.
enum RunLoopWait {
    static func until(timeout: TimeInterval, poll: TimeInterval = 0.02, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() >= deadline { return condition() }
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(poll))
        }
        return true
    }
}
