import Foundation

/// Stand-in product store. Real apps wrap their own model instead.
public final class ExampleStore {
    public private(set) var screen: String = "home"
    public private(set) var title: String = "Demo"

    public init() {}

    public func setTitle(_ value: String) {
        title = value
    }

    public func openDetails() {
        screen = "details"
    }

    public func snapshot() -> [String: Any] {
        [
            "screen": screen,
            "title": title,
        ]
    }
}
