import assert from "node:assert/strict";
import JSZip from "jszip";
import { compileMigrationModules } from "./migration-ts-loader.mjs";

const runtime = await compileMigrationModules();
try {
  const { buildSullyV3MigrationPackage } = runtime.requireModule("sully-v3/convert-package.js");
  const { verifyFloatMigrationPackage } = runtime.requireModule("format/verify-package.js");

  const source = new JSZip();
  const sourceManifest = {
    formatVersion: 3,
    mode: "full",
    createdAt: 1788191389452,
    stores: {
      characters: { parts: 1, count: 1 },
      messages: { parts: 1, count: 2 },
      socialPosts: { parts: 1, count: 1 },
      memoryNodes: { parts: 1, count: 2 },
      memoryLinks: { parts: 1, count: 1 },
      eventBoxes: { parts: 1, count: 0 },
      apiPresets: { parts: 1, count: 1 },
      assets: { parts: 1, count: 1 },
      hotNewsSnapshots: { parts: 1, count: 2 },
    },
  };
  source.file("manifest.json", JSON.stringify(sourceManifest));
  source.file("metadata.json", JSON.stringify({
    userProfile: { id: "me", name: "Tester", avatar: "assets/user.png", bio: "profile", apiKey: "SECRET-METADATA" },
    apiConfig: { apiKey: "SECRET-GLOBAL" },
  }));
  source.file("stores/characters.000.json", JSON.stringify([{
    id: "char-1", name: "Character", avatar: "assets/avatar.png", description: "persona", systemPrompt: "prompt",
    emotionConfig: { api: { apiKey: "SECRET-CHAR", baseUrl: "https://example.invalid" } },
  }]));
  source.file("stores/messages.000.json", JSON.stringify([
    { id: 1, charId: "char-1", role: "user", type: "image", content: "assets/avatar.png", timestamp: 1788191300000 },
    { id: 2, charId: "char-1", role: "assistant", type: "text", content: "ok", replyTo: { id: 1, content: "image" }, timestamp: 1788191301000 },
  ]));
  source.file("stores/socialPosts.000.json", JSON.stringify([{ id: "post-1", authorCharId: "char-1", title: "post", content: "body", images: ["🌿"], timestamp: 1788191302000 }]));
  source.file("stores/memoryNodes.000.json", JSON.stringify([
    { id: "mem-1", charId: "char-1", content: "下周日一起吃饭", room: "windowsill", boxId: "system_personality_detect", createdAt: 1788191303000 },
    { id: "mem-2", charId: "char-1", content: "过去发生的事", room: "bedroom", createdAt: 1788191304000 },
  ]));
  source.file("stores/memoryLinks.000.json", JSON.stringify([{ id: "link-1", sourceId: "mem-1", targetId: "mem-2", type: "temporal", strength: 1 }]));
  source.file("stores/eventBoxes.000.json", JSON.stringify([]));
  source.file("stores/apiPresets.000.json", JSON.stringify([{ id: "preset-1", config: { apiKey: "SECRET-PRESET" } }]));
  source.file("stores/assets.000.json", JSON.stringify([{ id: "mirror", data: { serialized: '{"apiKey":"SECRET-IN-STRING"}' } }]));
  source.file("stores/hotNewsSnapshots.000.json", JSON.stringify([{ id: "h1" }, { id: "h2" }]));
  source.file("assets/user.png", new Uint8Array([1, 2, 3]));
  source.file("assets/avatar.png", new Uint8Array([4, 5, 6, 7]));
  source.file("blobs/index.json", JSON.stringify([{ id: "blob-1", type: "image/jpeg", size: 2 }]));
  source.file("blobs/blob-1", new Uint8Array([8, 9]));

  const sourceBytes = await source.generateAsync({ type: "uint8array" });
  const built = await buildSullyV3MigrationPackage(sourceBytes, {
    packageId: "pkg-test-m2",
    createdAt: "2026-09-01T00:00:00.000Z",
  });
  assert.equal(built.fileName, "Tester_sully-to-float_2026-09-01.float-migration.zip");
  assert.equal(built.manifest.counts.characters, 1);
  assert.equal(built.manifest.counts.messages, 2);
  assert.equal(built.manifest.counts.futureIntents, 1);
  assert.equal(built.manifest.assets.count, 3);
  assert.equal(built.manifest.skippedByPolicy.hotNewsSnapshots, 2);

  const verification = await verifyFloatMigrationPackage(built.bytes);
  assert.equal(verification.ok, true, verification.errors.join("\n"));
  assert.deepEqual(verification.orphanReferences, []);
  assert.deepEqual(verification.missingAssetPaths, []);

  const output = await JSZip.loadAsync(built.bytes);
  const chats = JSON.parse(await output.file("data/chats.json").async("string"));
  assert.equal(chats.messages.length, 2);
  assert.equal(chats.messages[1].replyTo, chats.messages[0].migrationId);
  assert.equal(chats.messages[0].media.length, 1);
  assert.equal(chats.messages[0].media[0].packagePath.startsWith("assets/files/"), true);

  const memories = JSON.parse(await output.file("data/memories.json").async("string"));
  assert.equal(memories[0].eventBoxRef, undefined);
  assert.equal(memories[0].metadata.sourceBoxId, "system_personality_detect");

  const compat = JSON.parse(await output.file("compat/stores.json").async("string"));
  assert.equal(compat.some((entry) => entry.store === "apiPresets"), false);
  assert.equal(compat.some((entry) => entry.store === "assets"), false);

  const assetIndex = JSON.parse(await output.file("assets/index.json").async("string"));
  assert.equal(assetIndex.length, 3);
  for (const asset of assetIndex) assert.ok(output.file(asset.packagePath));

  const jsonText = (await Promise.all(Object.keys(output.files)
    .filter((name) => name.endsWith(".json"))
    .map((name) => output.file(name).async("string")))).join("\n");
  assert.equal(jsonText.includes("SECRET-METADATA"), false);
  assert.equal(jsonText.includes("SECRET-GLOBAL"), false);
  assert.equal(jsonText.includes("SECRET-CHAR"), false);
  assert.equal(jsonText.includes("SECRET-PRESET"), false);
  assert.equal(jsonText.includes("SECRET-IN-STRING"), false);

  console.log("Sully migration package M2 tests passed");
} finally {
  await runtime.cleanup();
}
