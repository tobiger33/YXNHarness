import Foundation

/// Language-neutral harness contract, Swift binding.
/// Mirrors docs/platforms.md and the web `window.__harness` shape.
public protocol HarnessControlling: AnyObject {
    var version: Int { get }
    func state() -> [String: Any]
    func commands() -> [HarnessCommandDescriptor]
    func command(_ name: String, payload: Any?) async -> HarnessCommandResult
    func on(_ event: HarnessEvent, handler: @escaping (HarnessEventPayload) -> Void)
    func off(_ event: HarnessEvent, handler: @escaping (HarnessEventPayload) -> Void)
    var clock: HarnessClockControlling { get }
}

public struct HarnessCommandDescriptor {
    public let name: String
    public let description: String
    /// Optional JSON Schema object (same idea as the web binding).
    public let payloadSchema: [String: Any]?

    public init(name: String, description: String, payloadSchema: [String: Any]? = nil) {
        self.name = name
        self.description = description
        self.payloadSchema = payloadSchema
    }
}

public enum HarnessCommandResult {
    case ok(value: Any?)
    case error(code: String, message: String, validCommands: [String]?)
}

public enum HarnessEvent: String {
    case statechange
    case animationend
    case error
}

public struct HarnessEventPayload {
    public let type: HarnessEvent
    public let detail: [String: Any]

    public init(type: HarnessEvent, detail: [String: Any] = [:]) {
        self.type = type
        self.detail = detail
    }
}

public protocol HarnessClockControlling: AnyObject {
    func pause()
    func resume()
    @discardableResult func advance(_ milliseconds: Double) -> [String: Any]
    @discardableResult func seek(_ milliseconds: Double) -> [String: Any]
    func now() -> Double
}

/// Host apps must set this (or an equivalent flag) before exposing a bridge.
public enum HarnessOptIn {
    public static var yxnHarnessEnabled: Bool = false
}
