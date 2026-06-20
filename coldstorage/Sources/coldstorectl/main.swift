import Foundation
import ColdStorageCore

// Thin CLI over the daemon's control socket — drives coldstored until the Electron panel exists,
// and what the Taskfile/tests poke. Newline-delimited JSON; prints the daemon's response line.
//   coldstorectl <socket> <method> [k=v ...]
//   coldstorectl <socket> watch                 # stream live events (Ctrl-C to stop)
// e.g.  coldstorectl coldstored.sock getStatus
//       coldstorectl coldstored.sock addSource path=/Users/ben/Pictures/Export
let args = CommandLine.arguments
guard args.count >= 3 else {
    FileHandle.standardError.write(Data("usage: coldstorectl <socket> <method> [k=v ...]\n".utf8))
    exit(2)
}
let socketPath = args[1]
let method = args[2]
var params: [String: String] = [:]
for kv in args.dropFirst(3) {
    guard let eq = kv.firstIndex(of: "=") else { continue }
    params[String(kv[..<eq])] = String(kv[kv.index(after: eq)...])
}

let client = try ControlClient(path: socketPath)
defer { client.disconnect() }

// `watch`: subscribe and stream every pushed event line until interrupted. Write unbuffered (via the
// fd, not `print`) so a `kill`/Ctrl-C can't drop lines still sitting in stdio's block buffer.
if method == "watch" {
    try client.send(ControlRequest(id: 1, method: "ping"))
    while let line = client.readLine() {
        FileHandle.standardOutput.write(line + Data([0x0A]))
    }
    exit(0)
}

let reqId = 1
try client.send(ControlRequest(id: reqId, method: method, params: params.isEmpty ? nil : params))

// Read lines until our response (matching id) arrives; events may interleave, so skip them.
while let line = client.readLine() {
    guard let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
    if let id = obj["id"] as? Int, id == reqId {
        print(String(data: line, encoding: .utf8) ?? "")
        exit(obj["error"] == nil ? 0 : 1)
    }
    // else: a pushed event — ignore while waiting for the response
}
FileHandle.standardError.write(Data("coldstorectl: connection closed before a response\n".utf8))
exit(1)
