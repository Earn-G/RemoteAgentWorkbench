import Foundation
import OSLog

enum AppDebugLog {
    private static let logger = Logger(subsystem: WorkbenchAppDefaults.logSubsystem, category: "Debug")

    static func info(_ message: String) {
        let line = "[RemoteAgentWorkbench] \(message)"
        logger.info("\(line, privacy: .public)")
    }

    static func error(_ message: String) {
        let line = "[RemoteAgentWorkbench][Error] \(message)"
        logger.error("\(line, privacy: .public)")
    }

    static func preview(data: Data, limit: Int = 240) -> String {
        guard !data.isEmpty else {
            return "<empty>"
        }

        let raw = String(decoding: data, as: UTF8.self)
        if raw.count <= limit {
            return raw.replacingOccurrences(of: "\n", with: "\\n")
        }

        let endIndex = raw.index(raw.startIndex, offsetBy: limit)
        let preview = String(raw[..<endIndex])
            .replacingOccurrences(of: "\n", with: "\\n")
        return "\(preview)..."
    }
}
