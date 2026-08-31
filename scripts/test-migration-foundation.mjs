import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as ts from "typescript";

async function loadTs(path) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler },
  });
  const url = `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString("base64")}`;
  return import(url);
}

const foundation = await loadTs("../lib/migrations/sully-v3/foundation.ts");
const validator = await loadTs("../lib/migrations/format/validate-package.ts");

const safeWorldbook = foundation.sanitizeMigrationValue({ key: "lore-key", content: "keep", nested: { apiKey: "SECRET" } }, { rootPath: "stores.worldbooks" });
assert.equal(safeWorldbook.value.key, "lore-key");
assert.equal(safeWorldbook.value.nested.apiKey, undefined);
assert.equal(safeWorldbook.redactedPaths.length, 1);

const safePreset = foundation.sanitizeMigrationValue({ config: { key: "SECRET", baseUrl: "https://example.invalid" } }, { rootPath: "stores.apiPresets" });
assert.equal(safePreset.value.config.key, undefined);
assert.equal(safePreset.value.config.baseUrl, "https://example.invalid");

assert.equal(foundation.classifySullyStore("messages"), "canonical");
assert.equal(foundation.classifySullyStore("hotNewsSnapshots"), "policy-skip");
assert.equal(foundation.classifySullyStore("apiPresets"), "sensitive-config");
assert.equal(foundation.classifySullyStore("brandNewStore"), "unknown");

const map = foundation.createEmptySullyMigrationIdMap();
const allocator = (collection, sourceId) => `${collection}:${sourceId}:new`;
assert.equal(foundation.mapSullyId(map, "memories", "a", allocator), "memories:a:new");
assert.equal(foundation.mapSullyId(map, "memories", "a", () => "different"), "memories:a:new");
assert.notEqual(foundation.mapSullyId(map, "memories", "b", allocator), foundation.mapSullyId(map, "memories", "a", allocator));

const raw = new TextEncoder().encode("stable fingerprint input");
assert.equal(await foundation.sha256Fingerprint(raw), `sha256:${createHash("sha256").update(raw).digest("hex")}`);
assert.notEqual(await foundation.sha256Fingerprint(raw), await foundation.sha256Fingerprint(new TextEncoder().encode("changed")));

class Entry {
  constructor(value, binary = false) { this.value = value; this.binary = binary; this.dir = false; }
  async async(type) {
    if (type === "string") return typeof this.value === "string" ? this.value : JSON.stringify(this.value);
    if (type === "uint8array") return this.binary ? this.value : new TextEncoder().encode(typeof this.value === "string" ? this.value : JSON.stringify(this.value));
    throw new Error("unsupported test type");
  }
}
function fakeZip(files) {
  const entries = Object.fromEntries(Object.entries(files).map(([path, value]) => [path, value instanceof Entry ? value : new Entry(value)]));
  return { files: entries, file(path) { return entries[path] ?? null; } };
}

const manifest = {
  formatVersion: 3,
  mode: "full",
  createdAt: 1788191389452,
  stores: {
    messages: { parts: 1, count: 2 },
    worldbooks: { parts: 1, count: 1 },
    apiPresets: { parts: 1, count: 1 },
    hotNewsSnapshots: { parts: 1, count: 12 },
    brandNewStore: { parts: 1, count: 1 },
    memoryNodes: { parts: 1, count: 2 },
    memoryLinks: { parts: 1, count: 1 },
  },
  vectors: { count: 1, byteLength: 4096 },
  assetCount: 1,
};
const zip = fakeZip({
  "manifest.json": manifest,
  "stores/messages.000.json": [{ id:"m1",type:"text",content:"hello" },{ id:"m2",type:"image",content:"", apiKey:"leak" }],
  "stores/worldbooks.000.json": [{ id:"w1", key:"dragon", content:"lore" }],
  "stores/apiPresets.000.json": [{ id:"p1",config:{apiKey:"secret",key:"secret2",baseUrl:"x"} }],
  "stores/hotNewsSnapshots.000.json": Array.from({length:12}, (_,i) => ({id:`h${i}`})),
  "stores/brandNewStore.000.json": [{ id:"u1", token:"secret", payload:"preserve" }],
  "stores/memoryNodes.000.json": [{ id:"n1",room:"windowsill",content:"later" },{ id:"n2",room:"bedroom",content:"past" }],
  "stores/memoryLinks.000.json": [{ id:"l1",type:"temporal",fromId:"n1",toId:"n2" }],
  "stores/memory_vectors.index.json": [{ memoryId:"n1",dimensions:1024,model:"BAAI/bge-m3",byteOffset:0,byteLength:4096 }],
  "assets/a.png": new Entry(new Uint8Array([1,2,3]), true),
  "blobs/index.json": [{ id:"b1",type:"image/jpeg",size:2 }],
  "blobs/b1": new Entry(new Uint8Array([8,9]), true),
});
const parsed = await foundation.parseSullyV3Backup(raw, { zipLoader: async () => zip });
assert.equal(parsed.ok, true);
assert.equal(parsed.report.distributions.messageTypes.text, 1);
assert.equal(parsed.report.distributions.messageTypes.image, 1);
assert.equal(parsed.report.distributions.memoryRooms.windowsill, 1);
assert.equal(parsed.report.distributions.memoryLinkTypes.temporal, 1);
assert.equal(parsed.report.skippedByPolicy.hotNewsSnapshots, 12);
assert.deepEqual(parsed.report.unknownStores, ["brandNewStore"]);
assert.equal(parsed.report.assets.assetFiles, 1);
assert.equal(parsed.report.assets.blobFiles, 1);
assert.equal(parsed.report.vectors.activeEmbeddingReusable, false);
assert.equal(parsed.stores.worldbooks.records[0].key, "dragon");
assert.equal(parsed.stores.messages.records[1].apiKey, undefined);
assert.equal(parsed.stores.apiPresets.records[0].config.apiKey, undefined);
assert.equal(parsed.stores.apiPresets.records[0].config.key, undefined);
assert.equal(parsed.compat.some((entry) => entry.store === "brandNewStore"), true);
assert.equal(parsed.stores.hotNewsSnapshots.records.length, 0);
assert.equal(parsed.stores.hotNewsSnapshots.parsedCount, 12);

const malformed = await foundation.parseSullyV3Backup(raw, { zipLoader: async () => fakeZip({}) });
assert.deepEqual(malformed.ok, false);
assert.equal(malformed.errors.includes("manifest.json is missing"), true);

const validManifest = {
  format:"float_migration", formatVersion:1, packageId:"pkg-1", createdAt:"2026-09-01T00:00:00.000Z",
  source:{platform:"sully",format:"sully_v3",formatVersion:3,backupFingerprint:`sha256:${"a".repeat(64)}`},
  counts:{messages:2},assets:{count:1,totalBytes:3},skippedByPolicy:{hotNewsSnapshots:12},warnings:[],
};
assert.deepEqual(validator.validateFloatMigrationManifest(validManifest), { valid:true, errors:[] });
const invalidManifest = structuredClone(validManifest);
invalidManifest.apiKey = "must-not-exist";
assert.equal(validator.validateFloatMigrationManifest(invalidManifest).valid, false);

console.log("migration foundation tests passed");
