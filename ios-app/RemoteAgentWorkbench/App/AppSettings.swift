import Combine
import Foundation

enum WorkbenchAppDefaults {
    enum UserDefaultsKeys {
        static let serverURL = "remote-agent-workbench.server-url"
        static let userBearerToken = "remote-agent-workbench.user-bearer-token"
    }

    static let bundleIdentifierPrefix = "com.remoteagentworkbench"
    static let legacyLocalDevelopmentServerURLs = [
        "http://127.0.0.1:8787",
        "http://localhost:8787"
    ]
    static let defaultServerURL = "http://127.0.0.1:8787"
    static let productionServerURLPlaceholder = "https://workbench.example.com"
    static let logSubsystem = Bundle.main.bundleIdentifier ?? "\(bundleIdentifierPrefix).app"
}

final class AppSettings: ObservableObject {
    @Published var serverURL: String
    @Published var userBearerToken: String

    private var cancellables = Set<AnyCancellable>()

    init() {
        AppDebugLog.info("AppSettings init started.")
        let storedServerURL = UserDefaults.standard.string(forKey: WorkbenchAppDefaults.UserDefaultsKeys.serverURL)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let storedUserBearerToken = UserDefaults.standard.string(forKey: WorkbenchAppDefaults.UserDefaultsKeys.userBearerToken)?
            .trimmingCharacters(in: .whitespacesAndNewlines)

        if let storedServerURL, !storedServerURL.isEmpty {
            if WorkbenchAppDefaults.legacyLocalDevelopmentServerURLs.contains(storedServerURL) {
                self.serverURL = WorkbenchAppDefaults.defaultServerURL
                UserDefaults.standard.set(
                    WorkbenchAppDefaults.defaultServerURL,
                    forKey: WorkbenchAppDefaults.UserDefaultsKeys.serverURL
                )
                AppDebugLog.info("Migrated legacy local server URL \(storedServerURL) to \(WorkbenchAppDefaults.defaultServerURL)")
            } else {
                self.serverURL = storedServerURL
                AppDebugLog.info("Loaded stored server URL: \(storedServerURL)")
            }
        } else {
            self.serverURL = WorkbenchAppDefaults.defaultServerURL
            AppDebugLog.info("No stored server URL found. Using default URL: \(WorkbenchAppDefaults.defaultServerURL)")
        }

        self.userBearerToken = storedUserBearerToken ?? ""
        AppDebugLog.info("Loaded stored user bearer token presence: \(self.userBearerToken.isEmpty ? "empty" : "configured")")

        $serverURL
            .dropFirst()
            .removeDuplicates()
            .sink { value in
                UserDefaults.standard.set(value, forKey: WorkbenchAppDefaults.UserDefaultsKeys.serverURL)
                AppDebugLog.info("Persisted server URL change: \(value)")
            }
            .store(in: &cancellables)

        $userBearerToken
            .dropFirst()
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .removeDuplicates()
            .sink { value in
                if value.isEmpty {
                    UserDefaults.standard.removeObject(forKey: WorkbenchAppDefaults.UserDefaultsKeys.userBearerToken)
                } else {
                    UserDefaults.standard.set(value, forKey: WorkbenchAppDefaults.UserDefaultsKeys.userBearerToken)
                }
                AppDebugLog.info("Persisted user bearer token presence: \(value.isEmpty ? "empty" : "configured")")
            }
            .store(in: &cancellables)

        AppDebugLog.info("AppSettings init finished with effective server URL: \(serverURL)")
    }
}
