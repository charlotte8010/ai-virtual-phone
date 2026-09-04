import assert from "node:assert/strict";

const requests = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  requests.push({ url: String(url), init });
  return new Response(JSON.stringify({ ret: 0 }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

try {
  const { getIlinkErrorCode, notifyIlinkStart } = await import(
    "../tools/weixin-local-assistant/assistant-core.mjs"
  );

  assert.equal(getIlinkErrorCode({ errcode: -14 }), -14);
  assert.equal(getIlinkErrorCode({ error_code: -14 }), -14);
  assert.equal(getIlinkErrorCode({ ret: -2 }), -2);
  assert.equal(getIlinkErrorCode({ errcode: 0, error_code: 0 }), undefined);

  await notifyIlinkStart("wc_live_test_token");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://ilinkai.weixin.qq.com/ilink/bot/msg/notifystart");
  assert.equal(requests[0].init.headers["iLink-App-Id"], "bot");
  assert.equal(requests[0].init.headers.Authorization, "Bearer wc_live_test_token");
  assert.equal(requests[0].init.headers.AuthorizationType, "ilink_bot_token");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    base_info: { channel_version: "1.0.2" },
  });
} finally {
  globalThis.fetch = originalFetch;
}

console.log("weixin iLink boundary tests passed");
