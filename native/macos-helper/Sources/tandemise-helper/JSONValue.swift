import Foundation

/// A dynamic JSON value.
///
/// The helper's wire format is schemaless on the request side (params differ per
/// op) and mostly-open on the response side (an accessibility tree is not a
/// fixed shape). A single recursive value type avoids one Codable struct per op
/// and keeps `Foundation.JSONSerialization`'s `Any` out of the codebase.
indirect enum JSONValue: Codable, Equatable {
    case null
    case bool(Bool)
    case int(Int)
    case double(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .null
        } else if let v = try? c.decode(Bool.self) {
            self = .bool(v)
        } else if let v = try? c.decode(Int.self) {
            self = .int(v)
        } else if let v = try? c.decode(Double.self) {
            self = .double(v)
        } else if let v = try? c.decode(String.self) {
            self = .string(v)
        } else if let v = try? c.decode([JSONValue].self) {
            self = .array(v)
        } else if let v = try? c.decode([String: JSONValue].self) {
            self = .object(v)
        } else {
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "unrecognised JSON value")
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let v): try c.encode(v)
        case .int(let v): try c.encode(v)
        case .double(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        }
    }
}

extension JSONValue {
    var stringValue: String? { if case .string(let v) = self { return v }; return nil }

    var intValue: Int? {
        switch self {
        case .int(let v): return v
        case .double(let v): return Int(v)
        default: return nil
        }
    }

    var boolValue: Bool? { if case .bool(let v) = self { return v }; return nil }
    var arrayValue: [JSONValue]? { if case .array(let v) = self { return v }; return nil }
    var objectValue: [String: JSONValue]? { if case .object(let v) = self { return v }; return nil }

    /// `.string` for a present value, `.null` for `nil`. Used constantly when
    /// projecting optional accessibility attributes into the response.
    static func optionalString(_ v: String?) -> JSONValue { v.map(JSONValue.string) ?? .null }
    static func optionalBool(_ v: Bool?) -> JSONValue { v.map(JSONValue.bool) ?? .null }
    static func optionalInt(_ v: Int?) -> JSONValue { v.map(JSONValue.int) ?? .null }

    static func point(_ p: CGPoint?) -> JSONValue {
        guard let p else { return .null }
        return .object(["x": .double(p.x), "y": .double(p.y)])
    }

    static func size(_ s: CGSize?) -> JSONValue {
        guard let s else { return .null }
        return .object(["width": .double(s.width), "height": .double(s.height)])
    }
}

/// Typed, validating accessor over a request's `params` object. Every reader
/// either returns a well-typed value or raises `VALIDATION` - params come from
/// outside the process and are never trusted to have the right shape.
struct Params {
    private let fields: [String: JSONValue]
    private let op: String

    init(_ value: JSONValue?, op: String) {
        self.fields = value?.objectValue ?? [:]
        self.op = op
    }

    func string(_ key: String) -> String? { fields[key]?.stringValue }
    func int(_ key: String) -> Int? { fields[key]?.intValue }
    func bool(_ key: String) -> Bool? { fields[key]?.boolValue }
    func has(_ key: String) -> Bool { fields[key] != nil && fields[key] != .null }

    func requiredString(_ key: String) throws -> String {
        guard let v = fields[key]?.stringValue, !v.isEmpty else {
            throw HelperError.validation("op '\(op)' requires a non-empty string param '\(key)'")
        }
        return v
    }

    func stringArray(_ key: String) throws -> [String]? {
        guard let raw = fields[key], raw != .null else { return nil }
        guard let items = raw.arrayValue else {
            throw HelperError.validation("op '\(op)' param '\(key)' must be an array of strings")
        }
        return try items.map {
            guard let s = $0.stringValue else {
                throw HelperError.validation("op '\(op)' param '\(key)' must contain only strings")
            }
            return s
        }
    }

    func clampedInt(_ key: String, default def: Int, min lo: Int, max hi: Int) -> Int {
        guard let v = int(key) else { return def }
        return Swift.min(Swift.max(v, lo), hi)
    }
}
