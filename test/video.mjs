// video: .mov/.mp4/.m4v uploads (ISO-BMFF ftyp sniff) are accepted next to images, and outgoing videos are
// listed and served with a video Content-Type. Runs the ingress directly on loopback :18898 with a temp config.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveConfig } from "../index.mjs";
import { isImage, isMedia, isVideo, startIngress } from "../src/ingress.mjs";
import { JPEG, fakeHookServer, hdr, json, makeChecker, multipart, rawRequest, tempSetup } from "./lib.mjs";

const PORT = Number(process.env.VIDEO_PORT || 18898);
const { results, check } = makeChecker();
const hook = await fakeHookServer();
const t = tempSetup("video", { port: PORT, hookPort: hook.port, quietPeriod: 0 });
delete process.env.WUI_TEST_HOOK_TOKEN;
// room for the 60 MB video (the shared temp config caps files at 1 MB)
fs.writeFileSync(t.configPath, JSON.stringify({ ...t.config, max_file_bytes: 200 * 1024 * 1024, max_request_bytes: 256 * 1024 * 1024 }, null, 2), { mode: 0o600 });

/** An ISO-BMFF file: a ftyp box with the given major brand, then random bytes (unique sha256 each call). */
const bmff = (brand, size = 64 * 1024) => {
  const b = crypto.randomBytes(size);
  b.writeUInt32BE(24, 0);
  b.write("ftyp", 4, "latin1");
  b.write(brand, 8, "latin1");
  b.writeUInt32BE(0, 12);
  b.write(brand, 16, "latin1");
  b.write("isom", 20, "latin1");
  return b;
};
const bearer = ["Authorization", `Bearer ${t.token}`];
const upload = (parts) => {
  const mp = multipart(parts);
  return rawRequest(PORT, "POST", "/v1/photos", { headers: [bearer, ["Content-Type", mp.ctype]], body: mp.body });
};

try {
  // sniffing
  check("QuickTime (qt  ) is video", isVideo(bmff("qt  ")) && isMedia(bmff("qt  ")) && !isImage(bmff("qt  ")));
  for (const brand of ["isom", "mp41", "mp42", "avc1", "iso5", "M4V ", "3gp5"]) check(`${brand.trim()} is video`, isVideo(bmff(brand)));
  for (const brand of ["heic", "heix", "mif1", "msf1", "avif"]) check(`${brand} stays an image, not a video`, isImage(bmff(brand)) && !isVideo(bmff(brand)));
  check("unknown ftyp brand is neither", !isMedia(bmff("zzzz")));
  const bad = bmff("mp42"); bad.writeUInt32BE(7, 0);
  check("malformed ftyp box size is not video", !isVideo(bad));
  check("truncated 12-byte ftyp is not video", !isVideo(bmff("mp42").subarray(0, 12)));
  check("JPEG is media", isMedia(JPEG));

  const cfg = resolveConfig({ configFile: t.configPath });
  const h = await startIngress(cfg, { log: () => {}, logError: () => {} });
  try {
    const mov = bmff("qt  ");
    const mp4 = bmff("mp42");
    let r = await upload([["source", "album"], ["file", { filename: "IMG_0101.MOV", data: mov, type: "video/quicktime" }],
      ["file", { filename: "IMG_0102.mp4", data: mp4, type: "video/mp4" }], ["file", { filename: "clip.m4v", data: bmff("M4V "), type: "video/x-m4v" }]]);
    let out = json(r);
    check("upload mov+mp4+m4v -> 200, 3 accepted", r.status === 200 && out.accepted.length === 3, r.body.toString());
    const dir = path.join(t.inbox, out.batch || "");
    const names = out.batch && fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    const saved = names.filter((n) => /\.(mov|mp4)$/i.test(n)).map((n) => fs.readFileSync(path.join(dir, n)));
    check("videos saved byte-for-byte", saved.length === 2 && saved.some((b) => b.equals(mov)) && saved.some((b) => b.equals(mp4)), names.join(","));

    const big = bmff("qt  ", 60 * 1024 * 1024);
    r = await upload([["file", { filename: "IMG_0103.MOV", data: big, type: "video/quicktime" }]]);
    check("60 MB video -> 200", r.status === 200 && json(r).accepted.length === 1, r.body.toString().slice(0, 300));

    r = await upload([["file", { filename: "x.mp4", data: bmff("zzzz") }]]);
    check("unknown ftyp brand -> 415", r.status === 415 && json(r).error === "not an image or video", r.body.toString());
    r = await upload([["file", { filename: "x.mov", data: Buffer.from("not a video at all, just text") }]]);
    check("non-media -> 415", r.status === 415 && json(r).error === "not an image or video", r.body.toString());

    const outMp4 = bmff("mp42", 4096);
    const outMov = bmff("qt  ", 4096);
    fs.writeFileSync(path.join(t.outgoing, "clip-1.mp4"), outMp4);
    fs.writeFileSync(path.join(t.outgoing, "clip-2.mov"), outMov);
    fs.writeFileSync(path.join(t.outgoing, "clip-3.M4V"), outMp4);
    r = await rawRequest(PORT, "GET", "/v1/mockups", { headers: [bearer] });
    out = json(r);
    const listed = (out.mockups || []).map((m) => m.name).sort();
    check("outgoing list includes videos", r.status === 200 && listed.join(",") === "clip-1.mp4,clip-2.mov,clip-3.M4V", r.body.toString());
    r = await rawRequest(PORT, "GET", "/v1/mockups/clip-1.mp4", { headers: [bearer] });
    check("outgoing mp4 served as video/mp4", r.status === 200 && hdr(r, "Content-Type") === "video/mp4" && r.body.equals(outMp4));
    r = await rawRequest(PORT, "GET", "/v1/mockups/clip-2.mov", { headers: [bearer] });
    check("outgoing mov served as video/quicktime", r.status === 200 && hdr(r, "Content-Type") === "video/quicktime" && r.body.equals(outMov));
    r = await rawRequest(PORT, "GET", "/v1/mockups/clip-3.M4V", { headers: [bearer] });
    check("outgoing upper-case .M4V served as video/x-m4v", r.status === 200 && hdr(r, "Content-Type") === "video/x-m4v");
  } finally {
    await h.stop();
  }
} catch (e) {
  check("no exception", false, e.stack);
} finally {
  await hook.close();
}
const failed = results.filter((x) => !x.ok);
process.stdout.write(`\nvideo: ${results.length - failed.length}/${results.length} passed\n`);
fs.rmSync(t.base, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
