// pycompat.mjs — the few Python standard-library behaviours the ingress's wire and on-disk formats follow,
// reproduced exactly so it reads and writes the same bytes as a Python stdlib service would: json.loads/json.dumps
// (ensure_ascii, float repr, sort_keys), str.strip/isprintable/len on code points, urllib.parse unquote/parse_qsl,
// os.path expanduser/normpath/splitext/realpath.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------- strings

// str.isspace() code points (CPython: Unicode White_Space plus bidi B/S/WS; not U+FEFF).
const PY_SPACE = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029,
  0x202f, 0x205f, 0x3000]);

/** str.strip() (no argument) or str.strip(chars). */
export function pyStrip(s, chars) {
  const cps = Array.from(s);
  const strip = chars === undefined ? (c) => PY_SPACE.has(c.codePointAt(0)) : (c) => chars.includes(c);
  let i = 0;
  let j = cps.length;
  while (i < j && strip(cps[i])) i++;
  while (j > i && strip(cps[j - 1])) j--;
  return cps.slice(i, j).join("");
}

/** bytes.strip(): ASCII whitespace only. */
export function pyBytesStrip(buf) {
  const ws = (b) => b === 0x20 || (b >= 0x09 && b <= 0x0d);
  let i = 0;
  let j = buf.length;
  while (i < j && ws(buf[i])) i++;
  while (j > i && ws(buf[j - 1])) j--;
  return buf.subarray(i, j);
}

export const pyLen = (s) => Array.from(s).length;
export const pySliceCp = (s, n) => Array.from(s).slice(0, n).join("");

const NOT_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;
/** str.isprintable(): no Cc/Cf/Cs/Co/Cn/Zl/Zp/Zs code point except the ASCII space. */
export function pyIsPrintable(s) {
  for (const ch of s) if (ch !== " " && NOT_PRINTABLE.test(ch)) return false;
  return true;
}

/** Code-point string order (Python's str comparison), not UTF-16 unit order. */
export function pyCompare(a, b) {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d) return d < 0 ? -1 : 1;
  }
  return x.length - y.length < 0 ? -1 : x.length === y.length ? 0 : 1;
}

/** "%s" % v for the scalar values the relay formats. */
export function pyStr(v) {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : pyFloatRepr(v);
  return String(v);
}

const UTF8 = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
/** bytes.decode("utf-8", "replace"). */
export const decodeReplace = (buf) => UTF8.decode(buf);

export class PyError extends Error {
  constructor(pyType, message) {
    super(message || pyType);
    this.pyType = pyType;
  }
}

/** bytes.decode("utf-8") (strict); raises UnicodeDecodeError. */
export function decodeStrict(buf) {
  try {
    return UTF8_STRICT.decode(buf);
  } catch {
    throw new PyError("UnicodeDecodeError", "'utf-8' codec can't decode bytes");
  }
}

/** open(path).read() in text mode: strict UTF-8 with universal newlines; OSError names like Python's. */
export function readText(p) {
  let buf;
  try {
    buf = fs.readFileSync(p);
  } catch (e) {
    throw osError(e);
  }
  return decodeStrict(buf).replace(/\r\n?/g, "\n");
}

const ERRNO_TYPES = {
  ENOENT: "FileNotFoundError", EACCES: "PermissionError", EPERM: "PermissionError", EISDIR: "IsADirectoryError",
  ENOTDIR: "NotADirectoryError", EEXIST: "FileExistsError", ECONNREFUSED: "ConnectionRefusedError",
  ECONNRESET: "ConnectionResetError", EPIPE: "BrokenPipeError", ETIMEDOUT: "TimeoutError",
};
const STRERROR = {
  ENOENT: "No such file or directory", EACCES: "Permission denied", EPERM: "Operation not permitted",
  EISDIR: "Is a directory", ENOTDIR: "Not a directory", EEXIST: "File exists", ELOOP: "Too many levels of symbolic links",
  EADDRINUSE: "Address already in use", EADDRNOTAVAIL: "Cannot assign requested address",
  EAFNOSUPPORT: "Address family not supported by protocol", ENAMETOOLONG: "File name too long",
};

/** A Node fs/net error as a Python OSError-like error (pyType = the OSError subclass name, strerror). */
export function osError(e) {
  if (e instanceof PyError) return e;
  const err = new PyError(ERRNO_TYPES[e && e.code] || "OSError", e && e.message);
  err.code = e && e.code;
  err.strerror = STRERROR[e && e.code] || (e && e.code) || "error";
  return err;
}

export const pyTypeName = (e) => (e && e.pyType) || (e && e.code && ERRNO_TYPES[e.code]) || (e instanceof SyntaxError ? "JSONDecodeError" : "Exception");

// ---------------------------------------------------------------- JSON (json.loads / json.dumps)

/** A JSON number written as a float literal; only produced when wrapFloats is set (config validation). */
export class PyFloat {
  constructor(v) {
    this.value = v;
  }
}

/**
 * json.loads(text): NaN/Infinity/-Infinity accepted, control characters in strings refused, objects without a
 * prototype (so "__proto__" is an ordinary key), duplicate keys last-wins, "Extra data" refused.
 * wrapFloats: float literals become PyFloat so int/float stays distinguishable, as isinstance(v, int) needs.
 */
export function pyJsonParse(text, { wrapFloats = false } = {}) {
  let i = 0;
  const fail = (msg, pos = i) => {
    const line = text.slice(0, pos).split("\n").length;
    const col = pos - text.lastIndexOf("\n", pos - 1);
    throw new PyError("JSONDecodeError", `${msg}: line ${line} column ${col} (char ${pos})`);
  };
  const ws = () => {
    while (i < text.length && " \t\n\r".includes(text[i])) i++;
  };
  const value = () => {
    const c = text[i];
    if (c === "{") return object();
    if (c === "[") return array();
    if (c === '"') return string();
    if (text.startsWith("null", i)) return (i += 4), null;
    if (text.startsWith("true", i)) return (i += 4), true;
    if (text.startsWith("false", i)) return (i += 5), false;
    if (text.startsWith("NaN", i)) return (i += 3), wrapFloats ? new PyFloat(NaN) : NaN;
    if (text.startsWith("Infinity", i)) return (i += 8), wrapFloats ? new PyFloat(Infinity) : Infinity;
    if (text.startsWith("-Infinity", i)) return (i += 9), wrapFloats ? new PyFloat(-Infinity) : -Infinity;
    const m = /^(-?(?:0|[1-9]\d*))(\.\d+)?([eE][-+]?\d+)?/.exec(text.slice(i, i + 4096));
    if (!m || !m[0]) fail("Expecting value");
    i += m[0].length;
    const v = Number(m[0]);
    if (m[2] || m[3]) return wrapFloats ? new PyFloat(v) : v;
    return v;
  };
  const string = () => {
    i++;
    let out = "";
    for (;;) {
      if (i >= text.length) fail("Unterminated string starting at");
      const c = text[i];
      const code = c.charCodeAt(0);
      if (c === '"') {
        i++;
        return out;
      }
      if (code < 0x20) fail("Invalid control character at");
      if (c !== "\\") {
        out += c;
        i++;
        continue;
      }
      const e = text[i + 1];
      const simple = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
      if (e in simple) {
        out += simple[e];
        i += 2;
      } else if (e === "u") {
        const hex = text.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("Invalid \\uXXXX escape");
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
      } else {
        fail("Invalid \\escape");
      }
    }
  };
  const array = () => {
    i++;
    const out = [];
    ws();
    if (text[i] === "]") return i++, out;
    for (;;) {
      ws();
      out.push(value());
      ws();
      if (text[i] === "]") return i++, out;
      if (text[i] !== ",") fail("Expecting ',' delimiter");
      i++;
    }
  };
  const object = () => {
    i++;
    const out = Object.create(null);
    ws();
    if (text[i] === "}") return i++, out;
    for (;;) {
      ws();
      if (text[i] !== '"') fail("Expecting property name enclosed in double quotes");
      const k = string();
      ws();
      if (text[i] !== ":") fail("Expecting ':' delimiter");
      i++;
      ws();
      out[k] = value();
      ws();
      if (text[i] === "}") return i++, out;
      if (text[i] !== ",") fail("Expecting ',' delimiter");
      i++;
    }
  };
  ws();
  const v = value();
  ws();
  if (i !== text.length) fail("Extra data");
  return v;
}

export const isDict = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof PyFloat);

/** repr(float). */
export function pyFloatRepr(x) {
  if (Number.isNaN(x)) return "NaN";
  if (x === Infinity) return "Infinity";
  if (x === -Infinity) return "-Infinity";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const [mant, expStr] = x.toExponential().split("e");
  const exp = Number(expStr);
  const neg = mant.startsWith("-");
  const digits = mant.replace("-", "").replace(".", "");
  let s;
  if (exp >= -4 && exp < 16) {
    if (exp >= 0) {
      const ip = digits.slice(0, exp + 1).padEnd(exp + 1, "0");
      const fp = digits.slice(exp + 1);
      s = `${ip}.${fp || "0"}`;
    } else {
      s = `0.${"0".repeat(-exp - 1)}${digits}`;
    }
  } else {
    const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    s = `${m}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
  }
  return neg ? `-${s}` : s;
}

function pyJsonString(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += "\\\\";
    else if (c >= 0x20 && c <= 0x7e) out += s[i];
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0d) out += "\\r";
    else if (c === 0x09) out += "\\t";
    else if (c === 0x08) out += "\\b";
    else if (c === 0x0c) out += "\\f";
    else out += `\\u${c.toString(16).padStart(4, "0")}`;
  }
  return `${out}"`;
}

/**
 * json.dumps(obj, ensure_ascii=True): compact=True is separators=(",", ":"), else (", ", ": ");
 * sortKeys is sort_keys=True; values under a key in floatKeys are written as floats (Python stores them as
 * float, JSON.parse cannot tell 1.0 from 1). Maps are dicts.
 */
export function pyDumps(obj, { compact = false, sortKeys = false, floatKeys = null } = {}) {
  const itemSep = compact ? "," : ", ";
  const keySep = compact ? ":" : ": ";
  const enc = (v, asFloat) => {
    if (v === null || v === undefined) return "null";
    if (v === true) return "true";
    if (v === false) return "false";
    if (v instanceof PyFloat) return pyFloatRepr(v.value);
    if (typeof v === "number") return asFloat || !Number.isInteger(v) ? pyFloatRepr(v) : String(v);
    if (typeof v === "bigint") return String(v);
    if (typeof v === "string") return pyJsonString(v);
    if (Array.isArray(v)) return v.length ? `[${v.map((x) => enc(x, false)).join(itemSep)}]` : "[]";
    const entries = v instanceof Map ? [...v.entries()] : Object.keys(v).map((k) => [k, v[k]]);
    if (sortKeys) entries.sort((a, b) => pyCompare(a[0], b[0]));
    if (!entries.length) return "{}";
    return `{${entries.map(([k, x]) => `${pyJsonString(k)}${keySep}${enc(x, !!(floatKeys && floatKeys.has(k)))}`).join(itemSep)}}`;
  };
  return enc(obj, false);
}

// ---------------------------------------------------------------- urllib.parse

/** urllib.parse.unquote(s) (utf-8, errors="replace"). */
export function pyUnquote(s) {
  if (!s.includes("%")) return s;
  let out = "";
  let bytes = [];
  const flush = () => {
    if (bytes.length) out += decodeReplace(Buffer.from(bytes));
    bytes = [];
  };
  for (let i = 0; i < s.length; ) {
    const c = s.charCodeAt(i);
    if (c === 0x25 && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 1, i + 3))) {
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 3;
    } else if (c < 0x80) {
      bytes.push(c);
      i++;
    } else {
      flush();
      const cp = s.codePointAt(i);
      out += String.fromCodePoint(cp);
      i += cp > 0xffff ? 2 : 1;
    }
  }
  flush();
  return out;
}

/** urllib.parse.parse_qsl(qs, keep_blank_values=True). */
export function pyParseQsl(qs) {
  const out = [];
  for (const nv of qs.split("&")) {
    if (!nv) continue;
    const eq = nv.indexOf("=");
    const name = eq < 0 ? nv : nv.slice(0, eq);
    const value = eq < 0 ? "" : nv.slice(eq + 1);
    out.push([pyUnquote(name.replace(/\+/g, " ")), pyUnquote(value.replace(/\+/g, " "))]);
  }
  return out;
}

// ---------------------------------------------------------------- os.path

function passwdHome(name) {
  try {
    for (const line of fs.readFileSync("/etc/passwd", "utf8").split("\n")) {
      const f = line.split(":");
      if (f[0] === name && f.length >= 6) return f[5];
    }
  } catch {}
  return null;
}

/** os.path.expanduser (POSIX). */
export function pyExpanduser(p) {
  if (!p.startsWith("~")) return p;
  let i = p.indexOf("/", 1);
  if (i < 0) i = p.length;
  let home;
  if (i === 1) {
    home = process.env.HOME !== undefined ? process.env.HOME : os.userInfo().homedir;
  } else {
    home = passwdHome(p.slice(1, i));
    if (home === null) return p;
  }
  home = home.replace(/\/+$/, "");
  return home + p.slice(i) || "/";
}

/** os.path.normpath (POSIX). */
export function pyNormpath(p) {
  if (p === "") return ".";
  let initial = p.startsWith("/") ? 1 : 0;
  if (initial && p.startsWith("//") && !p.startsWith("///")) initial = 2;
  const comps = [];
  for (const c of p.split("/")) {
    if (c === "" || c === ".") continue;
    if (c !== ".." || (!initial && !comps.length) || (comps.length && comps[comps.length - 1] === "..")) comps.push(c);
    else if (comps.length) comps.pop();
  }
  const out = "/".repeat(initial) + comps.join("/");
  return out || ".";
}

/** os.path.abspath. */
export const pyAbspath = (p) => pyNormpath(p.startsWith("/") ? p : `${process.cwd()}/${p}`);

/** os.path.splitext. */
export function pySplitext(p) {
  const sep = p.lastIndexOf("/");
  const dot = p.lastIndexOf(".");
  if (dot > sep) {
    let f = sep + 1;
    while (f < dot) {
      if (p[f] !== ".") return [p.slice(0, dot), p.slice(dot)];
      f++;
    }
  }
  return [p, ""];
}

/** os.path.realpath (non-strict: a missing tail stays as written). */
export function pyRealpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    const parent = path.dirname(p);
    if (parent === p) return p;
    return path.join(pyRealpath(parent), path.basename(p));
  }
}

/** os.path.lexists. */
export function pyLexists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** os.makedirs(d, mode, exist_ok=True): intermediate directories 0o777 & ~umask, the leaf `mode`. */
export function pyMakedirs(d, mode) {
  const parent = path.dirname(d);
  if (parent !== d && !pyLexists(parent)) pyMakedirs(parent, 0o777);
  try {
    fs.mkdirSync(d, mode);
  } catch (e) {
    if (!(e.code === "EEXIST" && fs.statSync(d).isDirectory())) throw osError(e);
  }
}

/** str.split() with no argument: split on runs of str.isspace() characters. */
export function pySplitWs(s) {
  const out = [];
  let cur = "";
  for (const ch of s) {
    if (PY_SPACE.has(ch.codePointAt(0))) {
      if (cur) out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// ---------------------------------------------------------------- http.server request heads

const HEADER_RE = /^(From |[\x21-\x39\x3b-\x7e]*:|[\t ])/;

/**
 * http.client.parse_headers + email.feedparser (compat32) over a latin-1 header block: [[name, value]] in order.
 * Folded lines stay in the value (with their line ends), a line that is not a header ends the headers.
 */
export function pyParseHeaders(block) {
  const lines = block.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g).filter((l) => l !== "");
  const out = [];
  let last = null;
  const store = () => {
    if (!last) return;
    const first = last[0];
    const c = first.indexOf(":");
    const value = (first.slice(c + 1).replace(/^[ \t]+/, "") + last.slice(1).join("")).replace(/[\r\n]+$/, "");
    out.push([first.slice(0, c), value]);
  };
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    if (!HEADER_RE.test(line)) break; // the end of the headers (blank line or a non-header line)
    if (line[0] === " " || line[0] === "\t") {
      if (last) last.push(line);
      continue;
    }
    store();
    last = null;
    if (line.startsWith("From ")) continue;
    if (line.indexOf(":") === 0) continue;
    last = [line];
  }
  store();
  return out;
}
