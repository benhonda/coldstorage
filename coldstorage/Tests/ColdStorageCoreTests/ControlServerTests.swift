import XCTest
import Foundation
@testable import ColdStorageCore

/// End-to-end over a *real* unix socket: a request gets a matching response, and a bus event is
/// pushed to the connected client. Exercises the actual transport (bind/listen/accept/read/write),
/// not a mock — the control plane is the daemon's command surface, so it's worth proving for real.
final class ControlServerTests: XCTestCase {
    private func tempSocketPath() -> String {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("cs-\(ProcessInfo.processInfo.processIdentifier)-\(UUID().uuidString).sock").path
    }

    func testRequestResponseAndPushedEvent() throws {
        let bus = EventBus()
        let path = tempSocketPath()
        // Stub handler echoes the method back — keeps the test on the transport, not daemon logic.
        let server = ControlServer(path: path, bus: bus) { req in
            ControlResponseLine(id: req.id, result: AnyEncodable(["echo": req.method]), error: nil)
        }
        try server.start()
        defer { server.stop() }

        let client = try ControlClient(path: path)
        defer { client.disconnect() }

        // 1. request → response (matching id, echoed method)
        try client.send(ControlRequest(id: 7, method: "hello"))
        let respLine = try XCTUnwrap(client.readLine(), "expected a response line")
        let resp = try XCTUnwrap(try JSONSerialization.jsonObject(with: respLine) as? [String: Any])
        XCTAssertEqual(resp["id"] as? Int, 7)
        XCTAssertEqual((resp["result"] as? [String: Any])?["echo"] as? String, "hello")

        // 2. a bus event is pushed to the live connection
        bus.publish(DaemonEvent("fileArchived", ["file": "a.jpg"]))
        let evtLine = try XCTUnwrap(client.readLine(), "expected an event line")
        let evt = try XCTUnwrap(try JSONSerialization.jsonObject(with: evtLine) as? [String: Any])
        XCTAssertEqual(evt["event"] as? String, "fileArchived")
        XCTAssertEqual((evt["data"] as? [String: Any])?["file"] as? String, "a.jpg")
    }

    func testMalformedRequestGetsError() throws {
        let bus = EventBus()
        let path = tempSocketPath()
        let server = ControlServer(path: path, bus: bus) { req in
            ControlResponseLine(id: req.id, result: AnyEncodable(["ok": true]), error: nil)
        }
        try server.start()
        defer { server.stop() }

        let client = try ControlClient(path: path)
        defer { client.disconnect() }

        // raw garbage line → error response, server stays up
        try client.sendRaw(Data("{not json}\n".utf8))
        let line = try XCTUnwrap(client.readLine())
        let obj = try XCTUnwrap(try JSONSerialization.jsonObject(with: line) as? [String: Any])
        XCTAssertNotNil(obj["error"])
    }
}
