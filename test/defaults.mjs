// Regression (0.1.1): the Gateway materialises configSchema defaults into the plugin config. With configFile set,
// those default-valued keys must not be rejected as inline settings; explicitly different values still must be.
import assert from "node:assert";
import fs from "node:fs";
import { resolveConfig } from "../index.mjs";
import { tempSetup } from "./lib.mjs";

const manifest = JSON.parse(fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
const defaults = Object.fromEntries(
  Object.entries(manifest.configSchema.properties)
    .filter(([k, v]) => k !== "configFile" && "default" in v)
    .map(([k, v]) => [k, v.default]),
);
const { configPath } = tempSetup("defaults", { port: 0, hookPort: 1 });

assert.ok(resolveConfig({ ...defaults, configFile: configPath, service_name: "photo-relay" }), "defaults + configFile resolves");
assert.throws(() => resolveConfig({ ...defaults, configFile: configPath, quiet_period: 999 }), /quiet_period/,
  "a non-default inline value is still rejected");
console.log("defaults: 2/2 passed");
