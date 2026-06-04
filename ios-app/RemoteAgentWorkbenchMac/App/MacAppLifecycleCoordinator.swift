import AppKit
import Foundation

extension Notification.Name {
    static let remoteAgentWorkbenchShowDashboard = Notification.Name("RemoteAgentWorkbench.showDashboard")
}

final class RemoteAgentWorkbenchMacAppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        guard !flag else {
            return true
        }

        sender.activate(ignoringOtherApps: true)
        NotificationCenter.default.post(name: .remoteAgentWorkbenchShowDashboard, object: nil)
        return true
    }
}
