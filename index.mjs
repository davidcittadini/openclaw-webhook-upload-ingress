// webhook-upload-ingress — OpenClaw plugin entry. Registers one background service that runs the ingress's own
// loopback HTTP listener (not a Gateway route: an authenticating reverse proxy exposes that port). The ingress logic
// lives in src/ingress.mjs and also runs without the Gateway.
//
// The entry is the object definePluginEntry() returns (id, name, description, configSchema, register), written out
// so the plain-JS plugin needs neither a build step nor a resolvable "openclaw" package.
import fs from "node:fs";
import { ConfigError, configFromDoc, readConfigFile, startIngress } from "./src/ingress.mjs";
import { pyAbspath, pyExpanduser } from "./src/pycompat.mjs";

const manifest = JSON.parse(fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"));

/** Keys the plugin config may set next to configFile: they override the file's values. */
export const FILE_OVERRIDES = ["service_name", "identity_header"];

/**
 * The ingress config from the plugin config: EITHER inline settings (the config-file keys) OR
 * { configFile, [service_name], [identity_header] }. Throws ConfigError.
 */
export function resolveConfig(pluginConfig) {
  const pc = pluginConfig || {};
  if (pc.configFile === undefined || pc.configFile === null) {
    return configFromDoc(Object.fromEntries(Object.entries(pc).filter(([k]) => k !== "configFile")));
  }
  if (typeof pc.configFile !== "string" || !pc.configFile) throw new ConfigError("configFile must be a path");
  const extra = Object.keys(pc).filter((k) => k !== "configFile" && !FILE_OVERRIDES.includes(k)).sort();
  if (extra.length)
    throw new ConfigError(`configFile excludes inline settings (only ${FILE_OVERRIDES.join(", ")} may override it): ${extra.join(", ")}`);
  const file = pyAbspath(pyExpanduser(pc.configFile));
  const doc = readConfigFile(file);
  if (doc !== null && typeof doc === "object" && !Array.isArray(doc))
    for (const k of FILE_OVERRIDES) if (pc[k] !== undefined) doc[k] = pc[k];
  return configFromDoc(doc);
}

export default {
  id: manifest.id,
  name: manifest.name,
  description: manifest.description,
  configSchema: manifest.configSchema,
  register(api) {
    if (api.registrationMode && api.registrationMode !== "full") return; // no listeners outside a Gateway run
    const log = api.logger;
    let handle = null;
    api.registerService({
      id: "webhook-upload-ingress",
      async start() {
        if (handle) return;
        // ConfigError / listen errors reject start(): the Gateway records the service failure.
        const cfg = resolveConfig(api.pluginConfig);
        handle = await startIngress(cfg, {
          log: (msg) => log.info(`${cfg.serviceName}: ${msg}`),
          logError: (msg) => log.warn(`${cfg.serviceName}: ${msg}`),
        });
      },
      async stop() {
        const h = handle;
        handle = null;
        if (h) await h.stop();
      },
    });
  },
};
