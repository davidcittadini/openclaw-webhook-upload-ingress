// config: plugin-config resolution (inline settings vs configFile), generic options (identity_header, service_name,
// optional hook fields, no intake_url) and defaults. Uses temp dirs and a loopback spare port (18897).
// Run: node test/config.mjs
import fs from "node:fs";
import path from "node:path";
import { resolveConfig } from "../index.mjs";
import { ConfigError, startIngress } from "../src/ingress.mjs";
import { PNG, fakeHookServer, hdr, json, makeChecker, multipart, rawRequest, tempSetup } from "./lib.mjs";

const PORT = Number(process.env.E2E_PORT || 18897);
const { results, check } = makeChecker();
const hook = await fakeHookServer();
const t = tempSetup("config", { port: PORT, hookPort: hook.port, quietPeriod: 0 });
delete process.env.WUI_TEST_HOOK_TOKEN;
const throws = (fn, re) => {
  try {
    fn();
    return false;
  } catch (e) {
    return e instanceof ConfigError && re.test(e.message);
  }
};

try {
  const fromFile = resolveConfig({ configFile: t.configPath });
  const { _doc, ...inline } = t.config;
  const fromInline = resolveConfig(inline);
  check("configFile and inline give the same config", JSON.stringify({ ...fromFile, allowedLogins: [...fromFile.allowedLogins] }) ===
    JSON.stringify({ ...fromInline, allowedLogins: [...fromInline.allowedLogins] }));
  check("defaults: service_name, identity_header", fromFile.serviceName === "webhook-upload-ingress" && fromFile.identityHeader === "tailscale-user-login");
  check("configFile + inline setting refused", throws(() => resolveConfig({ configFile: t.configPath, quiet_period: 5 }), /excludes inline settings/));
  const ov = resolveConfig({ configFile: t.configPath, service_name: "uploads", identity_header: "X-Auth-User" });
  check("configFile + overrides", ov.serviceName === "uploads" && ov.identityHeader === "x-auth-user");
  check("missing configFile -> ConfigError", throws(() => resolveConfig({ configFile: path.join(t.base, "nope.json") }), /cannot read config/));
  check("empty plugin config -> listen error", throws(() => resolveConfig({}), /^listen must be/));
  check("non-loopback listen refused", throws(() => resolveConfig({ ...inline, listen: { host: "0.0.0.0", port: PORT } }), /loopback/));
  check("hook needs agentId + instruction", throws(() => resolveConfig({ ...inline, hook: { agentId: "main" } }), /hook must name agentId, instruction/));
  check("unknown hook key refused", throws(() => resolveConfig({ ...inline, hook: { ...inline.hook, sessionKey: "x" } }), /unknown hook keys: sessionKey/));
  check("unknown key refused", throws(() => resolveConfig({ ...inline, bogus: 1 }), /unknown config keys: bogus/));
  check("bad identity_header refused", throws(() => resolveConfig({ ...inline, identity_header: "bad header" }), /identity_header/));
  const dflt = resolveConfig({ listen: { host: "127.0.0.1", port: PORT }, hook: { agentId: "main", instruction: "x" } });
  check("defaults: gateway_url, no intake_url, dirs under the state root", dflt.gatewayUrl === "http://127.0.0.1:18789" &&
    dflt.intakeUrl === null && dflt.inbox.endsWith(path.join("webhook-upload-ingress", "inbox")) && dflt.openclawConfig.endsWith("openclaw.json"));

  // a minimal hook config, a custom identity header and service name, no intake_url, served for real
  const cfg = resolveConfig({ ...inline, intake_url: null, identity_header: "X-Auth-User", service_name: "uploads",
    hook: { agentId: "main", instruction: "Files arrived.", name: "Uploads", deliver: false, timeoutSeconds: 120 } });
  const logs = [];
  const h = await startIngress(cfg, { log: (m) => logs.push(m), logError: (m) => logs.push(m) });
  try {
    let r = await rawRequest(PORT, "GET", "/v1/health");
    check("Server header carries service_name", hdr(r, "Server") === "uploads ");
    r = await rawRequest(PORT, "GET", "/v1/config", { headers: [["X-Auth-User", "user@example.com"]] });
    check("custom identity header accepted", r.status === 200);
    r = await rawRequest(PORT, "GET", "/v1/config", { headers: [["Tailscale-User-Login", "user@example.com"]] });
    check("default identity header ignored when another is configured", r.status === 401);
    const mp = multipart([["file", { filename: "a.png", data: PNG }]]);
    r = await rawRequest(PORT, "POST", "/v1/photos", { headers: [["X-Auth-User", "user@example.com"], ["Content-Type", mp.ctype]], body: mp.body });
    const bid = json(r).batch;
    const hb = JSON.parse((await hook.waitFor((x) => x.url === "/hooks/agent", 8000))[0].body);
    check("only configured hook fields are sent, in order", Object.keys(hb).join(",") === "message,name,agentId,deliver,timeoutSeconds,idempotencyKey" &&
      hb.name === "Uploads" && hb.deliver === false && hb.timeoutSeconds === 120 && hb.idempotencyKey === bid, Object.keys(hb).join(","));
    hook.status = 500;
  } finally {
    await h.stop();
  }
  // failing dispatch with no intake_url: retries are recorded, no incident request is made
  const cfg2 = { ...cfg, dispatchAttempts: 1 };
  const h2 = await startIngress(cfg2, { log: () => {}, logError: () => {} });
  try {
    const mp = multipart([["file", { filename: "b.png", data: Buffer.concat([PNG, Buffer.from("b")]) }]]);
    await rawRequest(PORT, "POST", "/v1/photos", { headers: [["X-Auth-User", "user@example.com"], ["Content-Type", mp.ctype]], body: mp.body });
    await hook.waitFor((x) => x.url === "/hooks/agent" && JSON.parse(x.body).message.includes("b.png"), 8000);
    await new Promise((r) => setTimeout(r, 1500));
    const st = JSON.parse(fs.readFileSync(path.join(t.state, "relay-state.json"), "utf8"));
    const b = Object.values(st.batches)[0];
    check("failed dispatch recorded; no incident without intake_url", b && b.attempts >= 1 && b.last_error === "HTTP 500" &&
      b.incident_sent === false && !hook.requests.some((x) => x.url !== "/hooks/agent"));
  } finally {
    await h2.stop();
  }
} catch (e) {
  check("no exception", false, e.stack);
} finally {
  await hook.close();
}
const failed = results.filter((x) => !x.ok);
process.stdout.write(`\nconfig: ${results.length - failed.length}/${results.length} passed\n`);
fs.rmSync(t.base, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
