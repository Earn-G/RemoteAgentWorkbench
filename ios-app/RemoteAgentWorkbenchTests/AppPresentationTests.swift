import XCTest
@testable import RemoteAgentWorkbench

final class AppPresentationTests: XCTestCase {
    func testGreetingFollowsLocalHour() {
        XCTAssertEqual(TimeOfDayGreeting.title(hour: 9), "Good morning 👋")
        XCTAssertEqual(TimeOfDayGreeting.title(hour: 14), "Good afternoon 👋")
        XCTAssertEqual(TimeOfDayGreeting.title(hour: 21), "Good evening 👋")
        XCTAssertEqual(TimeOfDayGreeting.title(hour: 2), "Good night 👋")
    }

    func testFeaturedProjectsKeepAVisibleBaseFolderIcon() {
        XCTAssertEqual(ProjectDisplay.folderSystemImage, "folder.fill")
    }

    func testProjectInfoTilesUseASingleFixedHeight() {
        XCTAssertEqual(ProjectInfoGridMetrics.tileHeight, 172)
    }

    func testMissingLatestEndpointRemainsVisible() {
        let error = APIError.requestFailed(statusCode: 404, message: "Route GET://v1/approvals not found")

        XCTAssertEqual(error.errorDescription, "Request failed (404): Route GET://v1/approvals not found")
    }
}
