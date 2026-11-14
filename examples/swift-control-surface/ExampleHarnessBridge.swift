import Foundation

/// Thin adapter: product store first, harness second.
/// Do not scrape SwiftUI views or rewrite UI trees.
public final class ExampleHarnessBridge: HarnessControlling {
    public let version = 1
    private let store: ExampleStore
    private let harnessClock = ExampleHarnessClock()
    private var handlers: [HarnessEvent: [(HarnessEventPayload) -> Void]] = [:]

    public init(store: ExampleStore) {
        self.store = store
    }

    public var clock: HarnessClockControlling { harnessClock }

    public func state() -> [String: Any] {
        store.snapshot()
    }

    public func commands() -> [HarnessCommandDescriptor] {
        [
            HarnessCommandDescriptor(
                name: "setTitle",
                description: "Update the demo title",
                payloadSchema: [
                    "type": "object",
                    "required": ["value"],
                    "properties": ["value": ["type": "string"]],
                ]
            ),
            HarnessCommandDescriptor(
                name: "openDetails",
                description: "Navigate to the details screen"
            ),
        ]
    }

    public func command(_ name: String, payload: Any?) async -> HarnessCommandResult {
        let valid = commands().map(\.name)
        switch name {
        case "setTitle":
            guard let body = payload as? [String: Any], let value = body["value"] as? String else {
                return .error(code: "invalid_payload", message: "setTitle requires { value: string }", validCommands: valid)
            }
            store.setTitle(value)
            emit(.statechange, detail: state())
            return .ok(value: state())
        case "openDetails":
            store.openDetails()
            emit(.statechange, detail: state())
            return .ok(value: state())
        default:
            return .error(code: "unknown_command", message: "Unknown command: \(name)", validCommands: valid)
        }
    }

    public func on(_ event: HarnessEvent, handler: @escaping (HarnessEventPayload) -> Void) {
        handlers[event, default: []].append(handler)
    }

    public func off(_ event: HarnessEvent, handler: @escaping (HarnessEventPayload) -> Void) {
        // Identity-based removal is approximate in this example; production bridges
        // should store cancellable tokens.
        handlers[event] = handlers[event] ?? []
    }

    private func emit(_ event: HarnessEvent, detail: [String: Any]) {
        let payload = HarnessEventPayload(type: event, detail: detail)
        for handler in handlers[event] ?? [] {
            handler(payload)
        }
    }
}

final class ExampleHarnessClock: HarnessClockControlling {
    private var paused = false
    private var millis: Double = 0

    func pause() { paused = true }
    func resume() { paused = false }

    @discardableResult
    func advance(_ milliseconds: Double) -> [String: Any] {
        guard !paused else { return ["now": millis, "paused": true] }
        millis += max(0, milliseconds)
        return ["now": millis, "paused": false]
    }

    @discardableResult
    func seek(_ milliseconds: Double) -> [String: Any] {
        millis = max(0, milliseconds)
        return ["now": millis, "paused": paused]
    }

    func now() -> Double { millis }
}

/// Factory used only when the host opted in.
public enum ExampleHarnessFactory {
    public static func makeBridge(store: ExampleStore) -> ExampleHarnessBridge? {
        guard HarnessOptIn.yxnHarnessEnabled else { return nil }
        return ExampleHarnessBridge(store: store)
    }
}
