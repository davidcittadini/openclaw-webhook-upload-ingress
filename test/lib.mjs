// Shared test helpers: raw HTTP exchanges (status line and header order visible), multipart bodies, tiny images,
// a fake Gateway hook / incident intake server, and temp setups under the OS temp dir. Nothing here touches a real
// Gateway or any directory outside the temp dir.
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
export const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=", "base64");
export const PNG2 = Buffer.concat([PNG, Buffer.from("second")]); // another SHA-256, still a PNG container

/** One raw request; resolves {status, reason, proto, headers: [[k, v]], body, raw}. */
export function rawRequest(port, method, p, { headers = [], body = null, rawHead = null } = {}) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1");
    const chunks = [];
    s.on("data", (d) => chunks.push(d));
    s.on("error", (e) => (chunks.length ? null : reject(e)));
    s.on("close", () => {
      const raw = Buffer.concat(chunks);
      const i = raw.indexOf("\r\n\r\n");
      const head = raw.subarray(0, i < 0 ? raw.length : i).toString("latin1").split("\r\n");
      const m = /^(HTTP\/\d\.\d) (\d{3}) ?(.*)$/.exec(head[0] || "");
      resolve({
        proto: m && m[1], status: m ? Number(m[2]) : null, reason: m && m[3],
        headers: head.slice(1).filter(Boolean).map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 2)]),
        body: !m ? raw : i < 0 ? Buffer.alloc(0) : raw.subarray(i + 4), raw, // no status line: an HTTP/0.9-style answer
      });
    });
    s.on("connect", () => {
      if (rawHead !== null) {
        s.end(Buffer.concat([Buffer.from(rawHead, "latin1"), body || Buffer.alloc(0)]));
        return;
      }
      const b = body === null ? null : Buffer.isBuffer(body) ? body : Buffer.from(body);
      let h = `${method} ${p} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`;
      for (const [k, v] of headers) h += `${k}: ${v}\r\n`;
      if (b !== null && !headers.some(([k]) => k.toLowerCase() === "content-length")) h += `Content-Length: ${b.length}\r\n`;
      s.write(`${h}\r\n`, "latin1");
      if (b !== null) s.write(b);
    });
  });
}

export const json = (r) => JSON.parse(r.body.toString("utf8"));
export const hdr = (r, name) => (r.headers.find(([k]) => k.toLowerCase() === name.toLowerCase()) || [])[1];

/** A multipart/form-data body from [[name, value]] or [[name, {filename, data, type}]]. */
export function multipart(parts, boundary = "----ingresstestBOUNDARY7MA4YWxk") {
  const out = [];
  for (const [name, v] of parts) {
    out.push(Buffer.from(`--${boundary}\r\n`));
    if (v && typeof v === "object" && !Buffer.isBuffer(v)) {
      out.push(Buffer.from(`Content-Disposition: form-data; name="${name}"; filename="${v.filename}"\r\nContent-Type: ${v.type || "application/octet-stream"}\r\n\r\n`));
      out.push(v.data);
    } else {
      out.push(Buffer.from(`Content-Disposition: form-data; name="${name}"\r\n\r\n`));
      out.push(Buffer.from(String(v)));
    }
    out.push(Buffer.from("\r\n"));
  }
  out.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(out), ctype: `multipart/form-data; boundary=${boundary}` };
}

/** A fake Gateway (/hooks/agent) and incident intake; records every request. */
export async function fakeHookServer(port = 0) {
  const rec = { requests: [], status: 200 };
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => {
      rec.requests.push({ method: req.method, url: req.url, headers: req.headers, rawHeaders: req.rawHeaders, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(rec.status, { "Content-Type": "application/json" });
      res.end(rec.status < 300 ? '{"ok":true}' : '{"ok":false}');
    });
  });
  await new Promise((r) => srv.listen(port, "127.0.0.1", r));
  rec.port = srv.address().port;
  rec.close = () => new Promise((r) => srv.close(r));
  rec.waitFor = async (pred, ms = 10000) => {
    const end = Date.now() + ms;
    for (;;) {
      const hit = rec.requests.filter(pred);
      if (hit.length) return hit;
      if (Date.now() > end) throw new Error("timed out waiting for a hook request");
      await sleep(50);
    }
  };
  return rec;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A temp setup: dirs, 0600 token file, openclaw config with an env-placeholder hook token + .env. */
export function tempSetup(label, { port, hookPort, quietPeriod = 1, dispatchAttempts = 5, hookTokenVar = "WUI_TEST_HOOK_TOKEN" }) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `wui-${label}-`));
  const dirs = { base, inbox: path.join(base, "inbox"), outgoing: path.join(base, "outgoing"), state: path.join(base, "state"), oc: path.join(base, "oc") };
  fs.mkdirSync(dirs.oc, { mode: 0o700 });
  const token = "ingress-test-token-0123456789abcdef";
  const tokenFile = path.join(base, "relay.token");
  fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  fs.chmodSync(tokenFile, 0o600);
  const ocConfig = path.join(dirs.oc, "openclaw.json");
  fs.writeFileSync(ocConfig, JSON.stringify({ hooks: { enabled: true, token: `\${${hookTokenVar}}` } }));
  fs.writeFileSync(path.join(dirs.oc, ".env"), `OTHER=x\n${hookTokenVar}="hook-test-token-fedcba9876543210"\n`, { mode: 0o600 });
  const config = {
    _doc: "temp test config",
    listen: { host: "127.0.0.1", port },
    allowed_logins: ["user@example.com"],
    token_file: tokenFile,
    openclaw_config: ocConfig,
    gateway_url: `http://127.0.0.1:${hookPort}/`,
    inbox: dirs.inbox,
    outgoing: dirs.outgoing,
    state_dir: dirs.state,
    max_file_bytes: 1024 * 1024,
    max_request_bytes: 4 * 1024 * 1024,
    quiet_period: quietPeriod,
    dispatch_attempts: dispatchAttempts,
    intake_url: `http://127.0.0.1:${hookPort}/cron/output`,
    hook: { agentId: "main", deliver: true, channel: "example-channel", accountId: "default", to: "recipient-placeholder",
      instruction: "New files arrived through the upload ingress; review them." },
  };
  const configPath = path.join(base, "config.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  return { ...dirs, configPath, config, token, hookToken: "hook-test-token-fedcba9876543210" };
}

/** Every file under root: [{rel, mode, size, data}] sorted, with dir entries marked. */
export function tree(root) {
  const out = [];
  const walk = (d, rel) => {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n);
      const r = rel ? `${rel}/${n}` : n;
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) {
        out.push({ rel: r, mode: "link", size: 0, data: Buffer.from(`-> ${path.basename(fs.readlinkSync(p))}`) });
      } else if (st.isDirectory()) {
        out.push({ rel: `${r}/`, mode: (st.mode & 0o7777).toString(8) });
        walk(p, r);
      } else {
        out.push({ rel: r, mode: (st.mode & 0o7777).toString(8), size: st.size, data: fs.readFileSync(p) });
      }
    }
  };
  walk(root, "");
  return out;
}

export function makeChecker() {
  const results = [];
  const check = (name, cond, detail = "") => {
    results.push({ name, ok: !!cond, detail });
    process.stdout.write(`${cond ? "PASS" : "FAIL"} ${name}${!cond && detail ? ` — ${detail}` : ""}\n`);
  };
  return { results, check };
}
