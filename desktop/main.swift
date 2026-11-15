import AppKit
import WebKit

// Local cockpit shell; the only native capture bridge is scoped to its main frame.
final class Desktop: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var webView: WKWebView!
    let address: URL

    init(address: URL) { self.address = address }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        menu.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit YXNHarness", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        let editItem = NSMenuItem()
        menu.addItem(editItem)
        let editMenu = NSMenu(title: "Edit")
        for (title, action, key) in [("Undo", "undo:", "z"), ("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            editMenu.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        editItem.submenu = editMenu
        NSApp.mainMenu = menu

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1360, height: 880),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "YXNHarness"
        window.minSize = NSSize(width: 960, height: 640)
        window.setFrameAutosaveName("YXNHarness.Desktop")
        window.center()
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(self, name: "captureProject")
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.uiDelegate = self
        webView.navigationDelegate = self
        window.contentView = webView
        webView.load(URLRequest(url: address))
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = false
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.urls : nil) }
    }

    func captureResult(_ result: [String: String]) {
        guard let data = try? JSONSerialization.data(withJSONObject: result),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('yxn:desktop-capture', {detail: \(json)}))", completionHandler: nil)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "captureProject", message.frameInfo.isMainFrame,
              message.frameInfo.securityOrigin.host == address.host,
              message.frameInfo.securityOrigin.port == address.port,
              message.frameInfo.securityOrigin.protocol == "http" else { return }
        // Determine the project rectangle ourselves; never accept arbitrary screen coordinates.
        webView.evaluateJavaScript("""
        (() => {
          const root = document.getElementById('yxn-workbench');
          if (!root || root.querySelector('.workspace').hidden || root.querySelector('#screen-preview').hidden) return null;
          const live = root.querySelector('#live-preview');
          const target = live && !live.hidden ? live : root.querySelector('#demo-preview');
          const r = target.getBoundingClientRect();
          return {x: Math.max(0,r.x), y: Math.max(0,r.y), width: Math.min(innerWidth,r.right)-Math.max(0,r.x), height: Math.min(innerHeight,r.bottom)-Math.max(0,r.y)};
        })()
        """) { [weak self] value, error in
            guard let self = self, let rect = value as? [String: Double],
                  let x = rect["x"], let y = rect["y"], let width = rect["width"], let height = rect["height"],
                  width > 0, height > 0 else {
                self?.captureResult(["error": "Open a visible project Preview first."])
                return
            }
            let config = WKSnapshotConfiguration()
            config.rect = CGRect(x: x, y: y, width: width, height: height)
            self.webView.takeSnapshot(with: config) { [weak self] image, error in
                guard let tiff = image?.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
                      let png = bitmap.representation(using: .png, properties: [:]) else {
                    self?.captureResult(["error": "Screenshot could not be captured."])
                    return
                }
                self?.captureResult(["data": png.base64EncodedString()])
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // Embedded project previews retain their normal navigation. The cockpit itself
        // stays on this local server; external links open in the default browser.
        if action.targetFrame?.isMainFrame == true, let url = action.request.url,
           url.scheme != address.scheme || url.host != address.host || url.port != address.port {
            if ["http", "https"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }
}

guard CommandLine.arguments.count == 2,
      let address = URL(string: CommandLine.arguments[1]),
      address.scheme == "http", address.host == "127.0.0.1" else {
    fputs("Expected a local cockpit URL.\n", stderr)
    exit(1)
}
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = Desktop(address: address)
app.delegate = delegate
app.run()
