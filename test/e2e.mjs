// e2e: the plugin's service on loopback :18897 with a temp config (temp inbox/outgoing/state under the OS temp dir,
// 0600 token file, gateway_url -> a local fake hook server, quiet_period 1 s). Run: node test/e2e.mjs
import fs from "node:fs";
import path from "node:path";
import plugin from "../index.mjs";
import { JPEG, PNG, PNG2, fakeHookServer, hdr, json, makeChecker, multipart, rawRequest, sleep, tempSetup } from "./lib.mjs";

const PORT = Number(process.env.E2E_PORT || 18897);
const { results, check } = makeChecker();
const hook = await fakeHookServer();
const t = tempSetup("e2e", { port: PORT, hookPort: hook.port, quietPeriod: 1 });
delete process.env.WUI_TEST_HOOK_TOKEN; // the hook token must come from the .env next to the openclaw config
const logs = [];
// through the plugin entry, as the Gateway runs it: register() -> registerService -> start()
let service = null;
const { _doc, ...inline } = t.config; // inline settings (the configFile form is covered by test/config.mjs)
plugin.register({
  registrationMode: "full",
  pluginConfig: inline,
  logger: { info: (m) => logs.push(m), warn: (m) => logs.push(`WARN ${m}`) },
  registerService: (s) => (service = s),
});
await service.start();
const relay = { stop: () => service.stop() };
const bearer = ["Authorization", `Bearer ${t.token}`];
const req = (method, p, opts = {}) => rawRequest(PORT, method, p, opts);
const upload = (parts, extra = [bearer]) => {
  const mp = multipart(parts);
  return req("POST", "/v1/photos", { headers: [...extra, ["Content-Type", mp.ctype]], body: mp.body });
};

try {
  // health, without auth
  let r = await req("GET", "/v1/health");
  check("health 200 {ok:true}", r.status === 200 && r.body.toString() === '{"ok":true}', r.body.toString());
  check("response is HTTP/1.0 with http.server-style headers", r.proto === "HTTP/1.0" && r.reason === "OK" &&
    r.headers.map(([k]) => k).join(",") === "Server,Date,Content-Type,Content-Length,Connection" && hdr(r, "Server") === "webhook-upload-ingress ",
  JSON.stringify(r.headers));

  // auth failures
  r = await req("GET", "/v1/config");
  check("no auth -> 401", r.status === 401 && json(r).error === "unauthorized");
  r = await req("GET", "/v1/config", { headers: [["Authorization", `Bearer ${t.hookToken}`]] });
  check("hook token is not a relay token -> 401", r.status === 401);
  r = await req("GET", "/v1/config", { headers: [["Tailscale-User-Login", "user@example.com"]] });
  check("allowed identity header -> 200", r.status === 200);

  // config mode
  r = await req("GET", "/v1/config", { headers: [bearer] });
  check("config mode album by default", r.status === 200 && r.body.toString() === '{"mode":"album"}', r.body.toString());
  fs.writeFileSync(path.join(t.state, "mode"), "auto\n");
  r = await req("GET", "/v1/config", { headers: [bearer] });
  check("config mode auto from <state_dir>/mode", r.body.toString() === '{"mode":"auto"}', r.body.toString());

  // upload PNG + JPEG in one session
  r = await upload([["session", "s1"], ["source", "album"], ["note", "hello note"], ["key", "k-png"],
    ["file", { filename: "IMG_0001.png", data: PNG, type: "image/png" }], ["key", "k-jpg"],
    ["file", { filename: "IMG 0002.jpg", data: JPEG, type: "image/jpeg" }]]);
  let out = json(r);
  const batch1 = out.batch;
  check("upload png+jpeg -> 200, 2 accepted", r.status === 200 && out.accepted.length === 2 && out.duplicates.length === 0, r.body.toString());
  check("safe names on disk", fs.existsSync(path.join(t.inbox, batch1, "IMG_0001.png")) && fs.existsSync(path.join(t.inbox, batch1, "IMG_0002.jpg")));
  check("batch id format", /^\d{8}T\d{6}Z-[0-9a-f]{8}$/.test(batch1), batch1);
  check("uploaded file mode 0600", (fs.statSync(path.join(t.inbox, batch1, "IMG_0001.png")).mode & 0o777) === 0o600);
  check("batch dir mode 0700", (fs.statSync(path.join(t.inbox, batch1)).mode & 0o777) === 0o700);
  const st = JSON.parse(fs.readFileSync(path.join(t.state, "relay-state.json"), "utf8"));
  check("state records shas and keys", st.keys["k-png"] === batch1 && Object.keys(st.shas).length === 2 && st.sessions.s1 === batch1);

  // not an image
  r = await upload([["file", { filename: "x.png", data: Buffer.from("not an image at all") }]]);
  check("non-image -> 415", r.status === 415 && json(r).error === "not an image", r.body.toString());

  // dedupe by sha and by key
  r = await upload([["session", "s1"], ["key", "k-other"], ["file", { filename: "again.png", data: PNG }]]);
  out = json(r);
  check("dedupe by sha256", r.status === 200 && out.accepted.length === 0 && out.duplicates[0].reason === "sha256", r.body.toString());
  r = await upload([["session", "s1"], ["key", "k-png"], ["file", { filename: "new.png", data: PNG2 }]]);
  out = json(r);
  check("dedupe by key", r.status === 200 && out.duplicates[0].reason === "key" && out.accepted.length === 0, r.body.toString());

  // wanted
  const wf = multipart([["keys", "k-png\nk-jpg\nk-new\nk-new\nk-other"]]);
  r = await req("POST", "/v1/photos/wanted", { headers: [bearer, ["Content-Type", wf.ctype]], body: wf.body });
  check("wanted answers unknown keys", r.status === 200 && json(r).wanted === "k-new\nk-other", r.body.toString());
  r = await req("POST", "/v1/photos/wanted", { headers: [bearer, ["Content-Type", "application/x-www-form-urlencoded"]], body: "keys=k-png%0Ak-zz" });
  check("wanted (urlencoded)", r.status === 200 && json(r).wanted === "k-zz", r.body.toString());

  // quiet-period flush
  const hooks = await hook.waitFor((h) => h.url === "/hooks/agent", 8000);
  const hb = JSON.parse(hooks[0].body);
  check("quiet period flush posts /hooks/agent", hooks.length === 1);
  check("hook idempotencyKey == batch id", hb.idempotencyKey === batch1, hb.idempotencyKey);
  check("hook body has no sessionKey", !("sessionKey" in hb));
  check("hook body keys/order", Object.keys(hb).join(",") === "message,agentId,deliver,channel,accountId,to,idempotencyKey", Object.keys(hb).join(","));
  check("hook auth = hook token from .env", hooks[0].headers.authorization === `Bearer ${t.hookToken}`);
  check("hook message lists files + quoted note", hb.message.includes(`Batch: ${batch1}`) && hb.message.includes("Source: album") &&
    hb.message.includes(path.join(t.inbox, batch1, "IMG_0001.png")) && hb.message.includes("> hello note"), hb.message);
  await sleep(200);
  const st2 = JSON.parse(fs.readFileSync(path.join(t.state, "relay-state.json"), "utf8"));
  check("dispatched batch leaves state; sha/key stay", !(batch1 in st2.batches) && st2.keys["k-png"] === batch1);

  // done -> immediate dispatch
  r = await upload([["session", "s2"], ["file", { filename: "two.png", data: PNG2 }]]);
  const batch2 = json(r).batch;
  r = await req("POST", "/v1/photos/done", { headers: [bearer, ["Content-Type", "application/x-www-form-urlencoded"]], body: "session=s2" });
  check("done -> 202 pending", r.status === 202 && r.body.toString() === `{"batch":"${batch2}","state":"pending"}`, r.body.toString());
  const h2 = await hook.waitFor((h) => h.url === "/hooks/agent" && JSON.parse(h.body).idempotencyKey === batch2, 3000);
  check("done dispatches its batch", h2.length === 1);
  r = await req("POST", "/v1/photos/done", { headers: [bearer, ["Content-Type", "application/x-www-form-urlencoded"]], body: "session=nope" });
  check("done for unknown session -> 200 {batch:null}", r.status === 200 && r.body.toString() === '{"batch":null}');

  // outgoing files: list/get/ack
  fs.writeFileSync(path.join(t.outgoing, "mock-1.png"), PNG);
  fs.writeFileSync(path.join(t.outgoing, "notes.txt"), "ignored");
  r = await req("GET", "/v1/mockups", { headers: [bearer] });
  out = json(r);
  check("outgoing list", r.status === 200 && out.mockups.length === 1 && out.mockups[0].name === "mock-1.png" &&
    out.mockups[0].size === PNG.length && out.mockups[0].url === "/v1/mockups/mock-1.png", r.body.toString());
  r = await req("GET", "/v1/mockups/mock-1.png", { headers: [bearer] });
  check("outgoing get streams bytes", r.status === 200 && hdr(r, "Content-Type") === "image/png" && r.body.equals(PNG));
  r = await req("GET", "/v1/mockups/..%2Fstate%2Fmode.png", { headers: [bearer] });
  check("outgoing path escape -> 404", r.status === 404);
  r = await req("POST", "/v1/mockups/ack", { headers: [bearer, ["Content-Type", "application/json"]], body: '{"names":["mock-1.png"]}' });
  check("outgoing ack", r.status === 200 && r.body.toString() === '{"saved":["mock-1.png"]}' && fs.existsSync(path.join(t.outgoing, "saved", "mock-1.png")), r.body.toString());
  r = await req("GET", "/v1/mockups", { headers: [bearer] });
  check("outgoing empty after ack", r.body.toString() === '{"mockups":[]}');

  // errors
  r = await req("PUT", "/v1/photos", { headers: [bearer], body: "" });
  check("wrong method -> 405", r.status === 405);
  r = await req("GET", "/nope", { headers: [bearer] });
  check("unknown path -> 404", r.status === 404 && json(r).error === "not found");
  r = await req("POST", "/v1/photos", { headers: [bearer, ["Content-Type", "text/plain"]], body: "x" });
  check("upload without multipart -> 400", r.status === 400);
  r = await req("PATCH", "/v1/health");
  check("unsupported method -> 501 (http.server page)", r.status === 501 && r.reason === "Unsupported method ('PATCH')");

  // 429 lockout (login bucket, then peer bucket)
  for (let i = 0; i < 20; i++) await req("GET", "/v1/config", { headers: [["Tailscale-User-Login", "evil@example.com"]] });
  r = await req("GET", "/v1/config", { headers: [["Tailscale-User-Login", "evil@example.com"]] });
  check("20 failures/min -> 429 with Retry-After", r.status === 429 && Number(hdr(r, "Retry-After")) >= 1 &&
    json(r).error === "too many failed authentications", `${r.status} ${hdr(r, "Retry-After")}`);
  r = await req("GET", "/v1/config", { headers: [bearer] });
  check("other client unaffected", r.status === 200);

  check("logs never carry tokens/notes/keys", !logs.some((l) => l.includes(t.token) || l.includes(t.hookToken) || l.includes("hello note") || l.includes("k-png")), logs.join("\n"));
} catch (e) {
  check("no exception", false, e.stack);
} finally {
  await relay.stop();
  await hook.close();
}
const r = await rawRequest(PORT, "GET", "/v1/health").catch(() => null);
check("stop() closes the listener", r === null);
const failed = results.filter((x) => !x.ok);
process.stdout.write(`\ne2e: ${results.length - failed.length}/${results.length} passed\n`);
fs.rmSync(t.base, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
