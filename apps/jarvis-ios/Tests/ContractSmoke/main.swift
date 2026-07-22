// /v1 contract smoke test for the Jarvis iOS client (tasklist P7.10).
//
// Compiled against the REAL client model + networking types (Sources/Models/* +
// Sources/Networking/{ServerConfig,JarvisAPI}.swift) by Tests/run-contract-smoke.sh
// — no Xcode / simulator needed (the models are Foundation-only). It guards that
// the iOS Codable models still decode the server's `/v1` wire shapes.
//
// The golden samples below are the AUTHORITATIVE contract: they mirror what the
// Rust `harness-server` emits (and what the web client consumes) — a bare JSON
// array for the conversation list, snake_case keys, optional enrichment fields.
//
// Two modes:
//   - offline (default): decode the embedded goldens → the gate (exit code).
//   - live (opt-in): set JARVIS_SMOKE_BASE_URL to hit a running server and decode
//     real responses. Diagnostic by default; set JARVIS_SMOKE_STRICT=1 to also
//     fold live failures into the exit code.
import Foundation

// MARK: - tiny assert harness

var failures = 0
var passes = 0

func check(_ name: String, _ condition: @autoclosure () -> Bool) {
    if condition() {
        passes += 1
        print("  ok   \(name)")
    } else {
        failures += 1
        print("  FAIL \(name)")
    }
}

func checkNoThrow(_ name: String, _ body: () throws -> Void) {
    do {
        try body()
        passes += 1
        print("  ok   \(name)")
    } catch {
        failures += 1
        print("  FAIL \(name): \(error)")
    }
}

func data(_ json: String) -> Data { Data(json.utf8) }

// MARK: - base-URL switch (ServerConfig resolver precedence)

print("ServerConfig.resolve precedence:")
check("runtime UserDefaults override wins",
      ServerConfig.resolve(userDefault: "http://10.0.0.2:7001", env: "http://env:7001", plist: "http://plist:7001")
        == "http://10.0.0.2:7001")
check("env beats plist + fallback",
      ServerConfig.resolve(userDefault: nil, env: "http://env:7001", plist: "http://plist:7001")
        == "http://env:7001")
check("plist is the build-time default",
      ServerConfig.resolve(userDefault: nil, env: nil, plist: "http://plist:7001") == "http://plist:7001")
check("empty / whitespace candidates are skipped",
      ServerConfig.resolve(userDefault: "   ", env: "", plist: nil) == ServerConfig.fallback)
check("fallback is loopback :7001",
      ServerConfig.resolve(userDefault: nil, env: nil, plist: nil) == "http://localhost:7001")
check("one trailing slash is trimmed",
      ServerConfig.resolve(userDefault: "http://x:7001/", env: nil, plist: nil) == "http://x:7001")
check("chatSocketURL derives ws + /v1/chat/ws", {
    UserDefaults.standard.set("https://host:8443", forKey: ServerConfig.defaultsKey)
    defer { UserDefaults.standard.removeObject(forKey: ServerConfig.defaultsKey) }
    return ServerConfig.chatSocketURL?.absoluteString == "wss://host:8443/v1/chat/ws"
}())

// MARK: - GET /v1/conversations  (bare array — NOT an { "conversations": [...] } envelope)

print("\nGET /v1/conversations decodes a bare array:")
checkNoThrow("full + minimal rows") {
    let golden = """
    [
      {"id":"abc-123","created_at":"2026-06-19T00:00:00Z","updated_at":"2026-06-19T01:02:03.500Z",
       "message_count":4,"title":"Hello","project_id":"p1","source":"chat","lifecycle":"active"},
      {"id":"def-456","created_at":null,"updated_at":null,"message_count":0,
       "title":null,"project_id":null,"source":null,"lifecycle":"archived"},
      {"id":"ghi-789"}
    ]
    """
    let rows = try JSONDecoder().decode([ConversationSummary].self, from: data(golden))
    guard rows.count == 3 else { throw Err("expected 3 rows, got \(rows.count)") }
    guard rows[0].id == "abc-123", rows[0].messageCount == 4, rows[0].title == "Hello",
          rows[0].source == "chat", rows[0].lifecycle == "active" else { throw Err("row0 fields") }
    guard rows[0].updatedDate != nil else { throw Err("row0 fractional rfc3339 parse") }
    guard rows[2].displayTitle == "ghi-789".prefix(8).description else { throw Err("title fallback") }
}
// Regression guard: the Node server once wrapped the list in {conversations:[...]},
// which the bare-array decode must reject (so the contract drift can't return).
check("envelope-wrapped body does NOT decode as the list contract", {
    let wrapped = data(#"{"conversations":[{"id":"x"}]}"#)
    return (try? JSONDecoder().decode([ConversationSummary].self, from: wrapped)) == nil
}())

// MARK: - GET /v1/conversations/:id  (detail + all four message roles)

print("\nGET /v1/conversations/:id decodes detail + every message role:")
checkNoThrow("detail with system/user/assistant(tool_calls)/tool") {
    let golden = """
    {"id":"abc-123","project_id":"p1","messages":[
      {"role":"system","content":"you are jarvis"},
      {"role":"user","content":"list files"},
      {"role":"assistant","content":null,"tool_calls":[
        {"id":"call_1","name":"fs.list","arguments":{"path":"."}}]},
      {"role":"tool","tool_call_id":"call_1","content":"a.txt\\nb.txt"}
    ]}
    """
    let detail = try JSONDecoder().decode(ConversationDetail.self, from: data(golden))
    guard detail.id == "abc-123", detail.projectId == "p1", detail.messages.count == 4
    else { throw Err("detail fields") }
    guard case .assistant(let content, let calls) = detail.messages[2], content == nil,
          calls.first?.name == "fs.list", calls.first?.arguments["path"]?.stringValue == "."
    else { throw Err("assistant tool_call shape") }
    guard case .tool(let tcid, _) = detail.messages[3], tcid == "call_1"
    else { throw Err("tool message shape") }
}

// MARK: - GET /v1/providers

print("\nGET /v1/providers decodes the catalog:")
checkNoThrow("providers with + without optional kind") {
    let golden = """
    {"default":"openai","providers":[
      {"name":"openai","default_model":"gpt-4o-mini","models":["gpt-4o-mini","gpt-4o"],
       "is_default":true,"kind":"openai"},
      {"name":"legacy","default_model":"m","models":["m"],"is_default":false}
    ]}
    """
    let resp = try JSONDecoder().decode(ProvidersResponse.self, from: data(golden))
    guard resp.default == "openai", resp.providers.count == 2,
          resp.providers[0].defaultModel == "gpt-4o-mini", resp.providers[0].isDefault,
          resp.providers[1].kind == nil else { throw Err("providers fields") }
}

// MARK: - GET /v1/chat/ws  (AgentEvent + transport frames)

print("\nWS /v1/chat/ws frames decode to the right cases:")
func decodeEvent(_ json: String) -> ServerEvent? { ServerEvent.decode(json)?.event }
check("delta", { if case .delta(let c)? = decodeEvent(#"{"type":"delta","content":"hi"}"#) { return c == "hi" }; return false }())
check("tool_start", { if case .toolStart(let id, let name, _)? = decodeEvent(#"{"type":"tool_start","id":"t1","name":"fs.read","arguments":{}}"#) { return id == "t1" && name == "fs.read" }; return false }())
check("tool_end", { if case .toolEnd(_, _, let body)? = decodeEvent(#"{"type":"tool_end","id":"t1","name":"fs.read","content":"ok"}"#) { return body == "ok" }; return false }())
check("usage", { if case .usage(let m, let p, let comp, _)? = decodeEvent(#"{"type":"usage","model":"gpt-4o","prompt_tokens":10,"completion_tokens":5}"#) { return m == "gpt-4o" && p == 10 && comp == 5 }; return false }())
check("plan_update item", { if case .planUpdate(let items)? = decodeEvent(#"{"type":"plan_update","items":[{"id":"1","title":"do it","status":"in_progress"}]}"#) { return items.first?.status == .inProgress }; return false }())
check("approval_request", { if case .approvalRequest(let id, _, _)? = decodeEvent(#"{"type":"approval_request","id":"a1","name":"shell.exec","arguments":{"cmd":"ls"}}"#) { return id == "a1" }; return false }())
check("assistant_message", { if case .assistantMessage(let msg)? = decodeEvent(#"{"type":"assistant_message","message":{"role":"assistant","content":"hi"}}"#) { if case .assistant(let c, _) = msg { return c == "hi" } }; return false }())
check("started", { if case .started(let id)? = decodeEvent(#"{"type":"started","id":"c1"}"#) { return id == "c1" }; return false }())
// The Node server acks a `new` frame with `session` (the Rust server used
// `started`); both must decode to `.started` so the new-conversation handshake
// isn't mistaken for an unknown frame. See #492.
check("session (new-conversation ack) decodes to .started", { if case .started(let id)? = decodeEvent(#"{"type":"session","id":"c1"}"#) { return id == "c1" }; return false }())
check("resumed", { if case .resumed(_, let n, let live)? = decodeEvent(#"{"type":"resumed","id":"c1","message_count":3,"live":true}"#) { return n == 3 && live }; return false }())
check("done", { if case .done? = decodeEvent(#"{"type":"done"}"#) { return true }; return false }())
check("error", { if case .error(let m)? = decodeEvent(#"{"type":"error","message":"boom"}"#) { return m == "boom" }; return false }())
check("seq high-water mark is surfaced", ServerEvent.decode(#"{"type":"delta","content":"x","seq":42}"#)?.seq == 42)
check("unknown frame degrades to .ignored (forward-compat)", { if case .ignored(let t)? = decodeEvent(#"{"type":"brand_new_frame"}"#) { return t == "brand_new_frame" }; return false }())

// MARK: - WS /v1/chat/ws  client frame vocabulary (must match chat-routes.ts switch)

// The Node `/v1/chat/ws` handler (packages/server/src/chat-routes.ts) switches on
// exactly this set; any other frame is answered `unknown frame type: …` and
// dropped. The Rust-only `start_turn` frame (which carried the first user
// message) was removed in P8, so the first turn now goes out as the
// `new`/`resume` handshake followed by `user`. This guards that every frame the
// app can hand the socket is one the server understands. See #492.
print("\nWS client frames the app emits are all understood by the Node server:")
let serverAcceptedFrameTypes: Set<String> = ["user", "reset", "resume", "new", "approve", "deny"]

func frameType(_ frame: ClientFrame) -> String? {
    guard let raw = try? frame.encoded(),
          let obj = try? JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any]
    else { return nil }
    return obj["type"] as? String
}

check("`new` handshake frame emits type=new", frameType(.new(id: "c1")) == "new")
check("`resume` handshake frame emits type=resume", frameType(.resume(id: "c1", afterSeq: 7)) == "resume")
check("`user` turn frame emits type=user", frameType(.user(content: "hi")) == "user")
let emittedFrames: [(label: String, frame: ClientFrame)] = [
    ("new", .new(id: "c1")),
    ("resume", .resume(id: "c1", afterSeq: nil)),
    ("user", .user(content: "hi")),
    ("approve", .approve(toolCallId: "t1")),
    ("deny", .deny(toolCallId: "t1", reason: "no")),
]
for entry in emittedFrames {
    check("first-turn/approval frame `\(entry.label)` is in the server's accepted set",
          frameType(entry.frame).map(serverAcceptedFrameTypes.contains) == true)
}

// MARK: - optional live mode

if let base = ProcessInfo.processInfo.environment["JARVIS_SMOKE_BASE_URL"], !base.isEmpty {
    let strict = ProcessInfo.processInfo.environment["JARVIS_SMOKE_STRICT"] == "1"
    print("\nLIVE mode against \(base) (strict=\(strict)):")
    UserDefaults.standard.set(base, forKey: ServerConfig.defaultsKey)
    let api = JarvisAPI()
    var liveFailures = 0
    func live(_ name: String, _ body: () async throws -> Void) async {
        do { try await body(); print("  ok   live:\(name)") }
        catch { liveFailures += 1; print("  FAIL live:\(name): \(error)") }
    }
    await live("GET /health") { try await api.health() }
    await live("GET /v1/conversations decodes as [ConversationSummary]") { _ = try await api.listConversations(limit: 5) }
    await live("GET /v1/providers decodes as ProvidersResponse") { _ = try await api.listProviders() }
    if strict { failures += liveFailures }
    else if liveFailures > 0 { print("  (live failures are diagnostic; set JARVIS_SMOKE_STRICT=1 to gate on them)") }
}

// MARK: - summary

print("\ncontract smoke: \(passes) passed, \(failures) failed")
exit(failures == 0 ? 0 : 1)

struct Err: Error, CustomStringConvertible { let m: String; init(_ m: String) { self.m = m }; var description: String { m } }
