import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProviderError, parseConfig, silentLogger, type PublishRequest } from "@attentionos/core";
import {
  create, createWebhookHandler, idempotencyUuid, keywordVariants, mapAnalytics, mapFollowerStats, mapRetention, normalizeEvent, verifyWebhook, WebhookError,
} from "../src/index.ts";
import { fakeFetch, fixture, noSleep, type Route } from "./fake-fetch.ts";

const FIX = join(import.meta.dirname, "fixtures");
const f = (name: string) => fixture(FIX, name);
const raw = (name: string) => readFileSync(join(FIX, name), "utf8").trim();

const IG = "6a0f1c2d3e4f5a6b7c8d9e01";
const TT = "6a0f1c2d3e4f5a6b7c8d9e02";
const SECRET = "whsec_demo_examplebrand_0123456789";

function setup(routes: Route[], secrets: Record<string, string> = {}) {
  const ff = fakeFetch(routes);
  const s = noSleep();
  const provider = create({
    secret: (n) => ({ ZERNIO_API_KEY: "sk_" + "0".repeat(64), ZERNIO_WEBHOOK_SECRET: SECRET, ...secrets })[n],
    config: parseConfig({}),
    log: silentLogger,
    fetch: ff.fetch,
    sleep: s.sleep,
    now: () => new Date("2026-10-14T16:00:00Z"),
    probe: async () => ({ videoCodec: "h264", audioCodec: "aac" }),
  });
  return { provider, calls: ff.calls, sleeps: s.sleeps };
}

const reel: PublishRequest = {
  idempotencyKey: "post:0b9a3c55-8f0e-4d55-9d0f-2f7c9f6b1a01:instagram:1",
  accountId: IG,
  platform: "instagram",
  caption: "Three ways to make a hand-bound notebook last. Comment STITCH and I'll send the guide.",
  media: [{ kind: "video", url: "https://cdn.example.com/examplebrand/notebook-reel.mp4", mimeType: "video/mp4" }],
  scheduledAt: "2026-10-14T08:00:00-04:00",
  options: { instagram: { collaborators: ["@demo_reader_3"], firstComment: "Guide link in bio." } },
};

describe("zernio accounts", () => {
  it("maps accounts, platform names and reconnect status; skips platforms AttentionOS doesn't use", async () => {
    const { provider, calls } = setup([{ method: "GET", match: "/api/v1/accounts", respond: { body: f("accounts.json") } }], { ZERNIO_PROFILE_ID: "6a0f1c2d3e4f5a6b7c8d9e00" });
    const accounts = await provider.listAccounts();
    expect(accounts).toEqual([
      { providerAccountId: IG, platform: "instagram", handle: "examplebrand.studio", displayName: "Examplebrand Studio", status: "connected" },
      { providerAccountId: TT, platform: "tiktok", handle: "examplebrand.studio", status: "expired" },
      { providerAccountId: "6a0f1c2d3e4f5a6b7c8d9e03", platform: "x", handle: "examplebrandstudio", status: "connected" },
    ]);
    expect(calls[0]!.headers.authorization).toMatch(/^Bearer sk_0{64}$/);
    expect(new URL(calls[0]!.url).searchParams.get("profileId")).toBe("6a0f1c2d3e4f5a6b7c8d9e00");
  });

  it("asks for every account in one call: Zernio rejects page or limit sent alone", async () => {
    const { provider, calls } = setup([{ method: "GET", match: "/api/v1/accounts", respond: { body: { accounts: [] } } }]);
    const h = await provider.health();
    expect(h.detail).toContain("no social accounts are connected");
    const params = new URL(calls[0]!.url).searchParams;
    expect([...params.keys()]).toEqual([]);
  });

  it("health reports accounts that need reconnecting, in plain language", async () => {
    const { provider } = setup([{ method: "GET", match: "/api/v1/accounts", respond: { body: f("accounts.json") } }]);
    const h = await provider.health();
    expect(h.ok).toBe(false);
    expect(h.detail).toContain("tiktok @examplebrand.studio need reconnecting");
  });

  it("health without a key explains where to get one, without calling the API", async () => {
    const ff = fakeFetch([]);
    const provider = create({ secret: () => undefined, config: parseConfig({}), log: silentLogger, fetch: ff.fetch });
    const h = await provider.health();
    expect(h.ok).toBe(false);
    expect(h.fix).toContain("ZERNIO_API_KEY");
    expect(ff.calls).toHaveLength(0);
  });
});

describe("zernio publishing", () => {
  it("creates a scheduled reel with the documented body and a stable idempotency key", async () => {
    const { provider, calls } = setup([{ method: "POST", match: "/api/v1/posts", respond: { status: 201, body: f("post-scheduled.json") } }]);
    const res = await provider.publish(reel);
    expect(res).toEqual({ providerPostId: "6a0f1c2d3e4f5a6b7c8d9f10", status: "scheduled", scheduledAt: "2026-10-14T12:00:00.000Z" });
    const call = calls[0]!;
    expect(call.headers["idempotency-key"]).toBe(idempotencyUuid(reel.idempotencyKey));
    expect(call.headers["idempotency-key"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(call.body).toEqual({
      content: reel.caption,
      mediaItems: [{ type: "video", url: "https://cdn.example.com/examplebrand/notebook-reel.mp4", mimeType: "video/mp4" }],
      platforms: [{
        platform: "instagram",
        accountId: IG,
        platformSpecificData: { shareToFeed: true, collaborators: ["demo_reader_3"], firstComment: "Guide link in bio." },
      }],
      metadata: { attentionosKey: reel.idempotencyKey },
      scheduledFor: "2026-10-14T12:00:00.000Z",
    });
  });

  it("trial reels use trialParams and are never shared to the feed", async () => {
    const { provider, calls } = setup([{ method: "POST", match: "/api/v1/posts", respond: { status: 201, body: f("post-scheduled.json") } }]);
    await provider.publish({ ...reel, options: { instagram: { trialReel: true, shareToFeed: true } } });
    const data = (calls[0]!.body as { platforms: { platformSpecificData: Record<string, unknown> }[] }).platforms[0]!.platformSpecificData;
    expect(data).toEqual({ shareToFeed: false, trialParams: { graduationStrategy: "MANUAL" } });
  });

  it("trial reels graduate automatically only when asked (SS_PERFORMANCE), and never from a stray value", async () => {
    const { provider, calls } = setup([
      { method: "POST", match: "/api/v1/posts", respond: { status: 201, body: f("post-scheduled.json") } },
      { method: "POST", match: "/api/v1/posts", respond: { status: 201, body: f("post-scheduled.json") } },
    ]);
    await provider.publish({ ...reel, options: { instagram: { trialReel: true, trialGraduation: "SS_PERFORMANCE" } } });
    await provider.publish({ ...reel, options: { instagram: { trialReel: true, trialGraduation: "AUTO" as never } } });
    const data = (i: number) => (calls[i]!.body as { platforms: { platformSpecificData: Record<string, unknown> }[] }).platforms[0]!.platformSpecificData;
    expect(data(0)).toEqual({ shareToFeed: false, trialParams: { graduationStrategy: "SS_PERFORMANCE" } });
    expect(data(1)).toEqual({ shareToFeed: false, trialParams: { graduationStrategy: "MANUAL" } });
  });

  it("puts TikTok privacy, AI label and consent flags in root tiktokSettings and publishes now without a schedule", async () => {
    const { provider, calls } = setup([{ method: "POST", match: "/api/v1/posts", respond: { status: 201, body: f("post-scheduled.json") } }]);
    await provider.publish({ ...reel, platform: "tiktok", accountId: TT, scheduledAt: undefined, options: { tiktok: { privacy: "public", aiGenerated: false, allowDuet: false } } });
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.publishNow).toBe(true);
    expect(body.scheduledFor).toBeUndefined();
    expect(body.tiktokSettings).toEqual({
      privacy_level: "PUBLIC_TO_EVERYONE", allow_comment: true, allow_duet: false, allow_stitch: true, video_made_with_ai: false,
      content_preview_confirmed: true, express_consent_given: true,
    });
  });

  it("treats Zernio's duplicate-content 409 as the existing post (nothing is posted twice)", async () => {
    const { provider } = setup([
      { method: "POST", match: "/api/v1/posts", respond: { status: 409, body: f("error-duplicate.json") } },
      { method: "GET", match: "/api/v1/posts/6a0f1c2d3e4f5a6b7c8d9f10", respond: { body: f("post-published.json") } },
    ]);
    const res = await provider.publish(reel);
    expect(res).toMatchObject({ providerPostId: "6a0f1c2d3e4f5a6b7c8d9f10", status: "published", platformPostId: "18000000000000042" });
  });

  it("maps published and failed posts", async () => {
    const { provider } = setup([
      { method: "GET", match: "/api/v1/posts/6a0f1c2d3e4f5a6b7c8d9f10", respond: { body: f("post-published.json") } },
      { method: "GET", match: "/api/v1/posts/6a0f1c2d3e4f5a6b7c8d9f11", respond: { body: f("post-failed.json") } },
    ]);
    expect(await provider.getPost("6a0f1c2d3e4f5a6b7c8d9f10")).toEqual({
      providerPostId: "6a0f1c2d3e4f5a6b7c8d9f10", status: "published", url: "https://www.instagram.com/reel/QF0000demo/",
      platformPostId: "18000000000000042", scheduledAt: "2026-10-14T12:00:00.000Z",
    });
    expect(await provider.getPost("6a0f1c2d3e4f5a6b7c8d9f11")).toMatchObject({ status: "failed", error: "Video is shorter than 3 seconds", errorCategory: "user_content" });
  });

  it("retries 429s honoring Retry-After, then succeeds", async () => {
    const { provider, sleeps } = setup([{
      method: "GET", match: "/api/v1/posts/6a0f1c2d3e4f5a6b7c8d9f10",
      respond: [{ status: 429, body: f("error-rate.json"), headers: { "retry-after": "2" } }, { body: f("post-published.json") }],
    }]);
    await provider.getPost("6a0f1c2d3e4f5a6b7c8d9f10");
    expect(sleeps).toEqual([2000]);
  });

  it("uses details.retryAfterSeconds when the header is missing", async () => {
    const { provider, sleeps } = setup([{
      method: "GET", match: "/api/v1/posts/6a0f1c2d3e4f5a6b7c8d9f10",
      respond: [{ status: 429, body: f("error-rate.json") }, { body: f("post-published.json") }],
    }]);
    await provider.getPost("6a0f1c2d3e4f5a6b7c8d9f10");
    expect(sleeps).toEqual([3000]);
  });

  it("maps vendor errors to ProviderError codes", async () => {
    const { provider } = setup([{ method: "GET", match: /\/posts\//, respond: { status: 401, body: f("error-auth.json") } }]);
    await expect(provider.getPost("6a0f1c2d3e4f5a6b7c8d9f10")).rejects.toMatchObject({ code: "auth", provider: "zernio" });
    const { provider: p2 } = setup([{ method: "GET", match: /\/posts\//, respond: { status: 500, body: { error: "boom", type: "api_error" } } }]);
    const err = await p2.getPost("6a0f1c2d3e4f5a6b7c8d9f10").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe("upstream");
  });

  it("refuses VP9 uploads before calling the API", async () => {
    const ff = fakeFetch([]);
    const provider = create({
      secret: () => "sk_" + "1".repeat(64), config: parseConfig({}), log: silentLogger, fetch: ff.fetch,
      probe: async () => ({ videoCodec: "vp9", audioCodec: "opus" }),
    });
    await expect(provider.uploadMedia({ kind: "video", localPath: join(FIX, "..", "fake-fetch.ts").replace(/\.ts$/, ".mp4") })).rejects.toMatchObject({ code: "invalid_request" });
    expect(ff.calls).toHaveLength(0);
  });
});

describe("zernio inbox", () => {
  it("creates a post-scoped comment-to-DM automation with case variants, word matching and a follow gate", async () => {
    const { provider, calls } = setup([
      { method: "GET", match: "/api/v1/accounts", respond: { body: f("accounts.json") } },
      { method: "POST", match: "/api/v1/comment-automations", respond: { status: 201, body: f("automation-created.json") } },
    ]);
    const res = await provider.createDmAutomation({
      accountId: IG, platform: "instagram", providerPostId: "18000000000000042", keyword: "Stitch", matchMode: "exact_word",
      dmText: "Here's the stitching guide.", buttons: [{ label: "Get the guide", url: "https://examplebrand.example/guide/stitch?utm_content=stitch_12" }],
      requireFollow: true, replyComment: "Sent you a DM.",
    });
    expect(res).toEqual({ id: "6a0f1c2d3e4f5a6b7c8d9a01", keyword: "Stitch", providerPostId: "18000000000000042", active: true });
    const body = calls.find((c) => c.method === "POST")!.body as Record<string, unknown>;
    expect(body).toMatchObject({
      profileId: "6a0f1c2d3e4f5a6b7c8d9e00",
      accountId: IG,
      trigger: "comment",
      platformPostId: "18000000000000042",
      keywords: ["stitch", "Stitch", "STITCH"],
      matchMode: "word",
      buttons: [{ type: "url", title: "Get the guide", url: "https://examplebrand.example/guide/stitch?utm_content=stitch_12" }],
      commentReply: "Sent you a DM.",
      publicReplyPolicy: "after_dm",
      audience: { followerStatus: "follower", whenUnknown: "verify" },
      repeatPolicy: { mode: "once" },
      isActive: true,
    });
    expect(body.postId).toBeUndefined();
  });

  it("binds to a Zernio post id (works before the post is live) and refuses account-wide automations", async () => {
    const { provider, calls } = setup([
      { method: "POST", match: "/api/v1/comment-automations", respond: { status: 201, body: f("automation-created.json") } },
    ], { ZERNIO_PROFILE_ID: "6a0f1c2d3e4f5a6b7c8d9e00" });
    await provider.createDmAutomation({ accountId: IG, platform: "instagram", providerPostId: "6a0f1c2d3e4f5a6b7c8d9f10", keyword: "stitch", matchMode: "contains", dmText: "Here you go." });
    expect(calls[0]!.body).toMatchObject({ postId: "6a0f1c2d3e4f5a6b7c8d9f10", matchMode: "contains" });
    await expect(provider.createDmAutomation({ accountId: IG, platform: "instagram", providerPostId: null, keyword: "stitch", matchMode: "contains", dmText: "x" }))
      .rejects.toMatchObject({ code: "invalid_request" });
    await expect(provider.createDmAutomation({ accountId: IG, platform: "facebook", providerPostId: "1", keyword: "stitch", matchMode: "contains", dmText: "x", requireFollow: true }))
      .rejects.toThrow(/follow gate only works on Instagram/);
  });

  it("lists automations for one account", async () => {
    const { provider } = setup([{ method: "GET", match: "/api/v1/comment-automations", respond: { body: f("automations.json") } }]);
    expect(await provider.listDmAutomations(IG)).toEqual([{ id: "6a0f1c2d3e4f5a6b7c8d9a01", keyword: "stitch", providerPostId: "18000000000000042", active: true }]);
  });

  it("lists conversations and messages with account-qualified ids", async () => {
    const { provider, calls } = setup([
      { method: "GET", match: "/api/v1/inbox/conversations", respond: { body: f("conversations.json") } },
      { method: "GET", match: /\/inbox\/conversations\/[^/]+\/messages/, respond: { body: f("messages.json") } },
    ]);
    const convs = await provider.listConversations(IG, { since: "2026-10-05T00:00:00Z" });
    expect(convs).toEqual([{ id: `${IG}:6a0f1c2d3e4f5a6b7c8d9c01`, lastMessageAt: "2026-10-09T15:00:00.000Z", participant: "demo_reader_1" }]);
    const msgs = await provider.listMessages(convs[0]!.id);
    expect(msgs[0]).toEqual({
      id: "6a0f1c2d3e4f5a6b7c8d9d02", conversationId: convs[0]!.id, platform: "instagram",
      from: { id: "17841400000000777", handle: "demo_reader_1" }, text: "Thanks! Do you run workshops for teams?", at: "2026-10-09T15:00:00.000Z", direction: "in",
    });
    expect(msgs[1]!.direction).toBe("out");
    expect(new URL(calls[1]!.url).searchParams.get("accountId")).toBe(IG);
  });

  it("sends a DM with an idempotency key and maps thread-control conflicts", async () => {
    const { provider, calls } = setup([
      { method: "POST", match: /\/inbox\/conversations\/c1\/messages/, respond: { body: { success: true, data: { messageId: "m-1" } } } },
      { method: "POST", match: /\/inbox\/conversations\/c2\/messages/, respond: { status: 409, body: f("error-thread-owner.json") } },
    ]);
    expect(await provider.sendMessage(`${IG}:c1`, "Yes, every other Saturday.")).toEqual({ id: "m-1" });
    expect(calls[0]!.body).toEqual({ accountId: IG, message: "Yes, every other Saturday." });
    expect(calls[0]!.headers["idempotency-key"]).toBeDefined();
    await expect(provider.sendMessage(`${IG}:c2`, "hi")).rejects.toMatchObject({ code: "conflict" });
  });

  it("replies to a comment using the composite comment id", async () => {
    const { provider, calls } = setup([{ method: "POST", match: /\/inbox\/comments\/18000000000000042$/, respond: { body: { success: true, commentId: "c-9" } } }]);
    expect(await provider.replyToComment(`${IG}:18000000000000042:18050000000000001`, "Sent!")).toEqual({ id: "c-9" });
    expect(calls[0]!.body).toEqual({ accountId: IG, message: "Sent!", commentId: "18050000000000001" });
  });
});

describe("zernio analytics", () => {
  it("maps per-post metrics, converting watch time to seconds and skip rate to 0–1, skipping unsynced platforms", async () => {
    const { provider } = setup([{ method: "GET", match: "/api/v1/analytics", respond: { body: f("analytics.json") } }]);
    const rows = await provider.listPostMetrics(IG, { since: "2026-10-01T00:00:00Z" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      platformPostId: "18000000000000042", providerPostId: "6a0f1c2d3e4f5a6b7c8d9f10", platform: "instagram", capturedAt: "2026-10-14T16:00:00.000Z",
      views: 9100, reach: 4100, likes: 320, comments: 58, shares: 21, saves: 44, profileVisits: 37, avgWatchTimeS: 6.4, skipRate: 0.415,
    });
    expect(rows[0]!.follows).toBeUndefined();
    expect((rows[0]!.raw as { aos?: unknown }).aos).toEqual({ impressions: 5400 });
  });

  it("reads every account the key can see for \"me\" (no accounts synced yet), scoped to the profile when set", async () => {
    const body = {
      posts: [{
        _id: "6a0f1c2d3e4f5a6b7c8d9f11",
        platforms: [
          { platform: "instagram", accountId: IG, platformPostId: "18000000000000043", syncStatus: "synced", analytics: { views: 10 } },
          { platform: "tiktok", accountId: { _id: TT }, platformPostId: "7400000000000000002", syncStatus: "synced", analytics: { views: 20 } },
        ],
      }],
    };
    const { provider, calls } = setup([{ method: "GET", match: "/api/v1/analytics", respond: { body } }], { ZERNIO_PROFILE_ID: "6a0f1c2d3e4f5a6b7c8d9e00" });
    const rows = await provider.listPostMetrics("me");
    expect(rows.map((r) => r.platform)).toEqual(["instagram", "tiktok"]);
    const params = new URL(calls[0]!.url).searchParams;
    expect(params.has("accountId")).toBe(false);
    expect(params.get("profileId")).toBe("6a0f1c2d3e4f5a6b7c8d9e00");

    const one = setup([{ method: "GET", match: "/api/v1/analytics", respond: { body } }]);
    expect((await one.provider.listPostMetrics(IG)).map((r) => r.platform)).toEqual(["instagram"]);
    expect(new URL(one.calls[0]!.url).searchParams.get("accountId")).toBe(IG);
  });

  it("reads other platforms' names for watch time, completion, follows and clicks, and keeps retention curves", () => {
    const tt = mapAnalytics({
      platform: "tiktok", platformPostId: "1", capturedAt: "2026-10-14T00:00:00.000Z",
      analytics: { views: 5000, averageTimeWatched: 7.5, fullVideoWatchedRate: 0.21, newFollowers: 12, profile_views: 40, website_clicks: 9, reposts: 3 },
    });
    expect(tt).toMatchObject({ avgWatchTimeS: 7.5, completionRate: 0.21, follows: 12, profileVisits: 40 });
    expect((tt.raw as { aos: unknown }).aos).toEqual({ clicks: 9, reposts: 3 });
    const yt = mapAnalytics({
      platform: "youtube", platformPostId: "2", capturedAt: "x",
      analytics: { views: 100, averageViewDuration: 20, averageViewPercentage: 45.5, subscribersGained: 2, videoDurationSeconds: 40,
        audienceRetention: [{ elapsedVideoTimeRatio: 0, audienceWatchRatio: 1 }, { elapsedVideoTimeRatio: 0.5, audienceWatchRatio: 0.6 }] },
    });
    expect(yt).toMatchObject({ avgWatchTimeS: 20, completionRate: 0.455, follows: 2, durationS: 40 });
    expect((yt.raw as { aos: { retention: unknown } }).aos.retention).toEqual([{ t: 0, pct: 100 }, { t: 20, pct: 60 }]);
    expect(mapRetention([100, 80, 61])).toEqual([{ t: 0, pct: 100 }, { t: 1, pct: 80 }, { t: 2, pct: 61 }]);
    expect(mapRetention([{ second: 0, pct: 100 }])).toBeUndefined();
    expect(mapRetention("nope")).toBeUndefined();
  });

  it("reads daily follower history for one account", async () => {
    const { provider, calls } = setup([{ method: "GET", match: "/api/v1/accounts/follower-stats", respond: { body: f("follower-stats.json") } }]);
    const rows = await provider.listAccountStats(IG, { since: "2026-10-01T00:00:00Z" });
    expect(rows).toEqual([
      { day: "2026-10-01", followers: 1204, platform: "instagram", capturedAt: "2026-10-14T16:00:00.000Z" },
      { day: "2026-10-02", followers: 1219, platform: "instagram", capturedAt: "2026-10-14T16:00:00.000Z" },
    ]);
    expect(calls[0]!.url).toContain("accountIds=" + IG);
    expect(calls[0]!.url).toContain("fromDate=2026-10-01");
    expect(mapFollowerStats({}, IG, "x")).toEqual([]);
  });
});

describe("zernio webhooks", () => {
  const sign = (body: string, secret = SECRET) => createHmac("sha256", secret).update(body).digest("hex");

  it("verifies the HMAC over the raw body (and the legacy header), rejecting tampering", () => {
    const body = raw("webhook-post-published.json");
    expect(verifyWebhook({ "X-Zernio-Signature": sign(body) }, body, SECRET)).toBe(true);
    expect(verifyWebhook({ "x-late-signature": sign(body) }, body, SECRET)).toBe(true);
    expect(verifyWebhook({ "X-Zernio-Signature": sign(body) }, body.replace("published", "failed"), SECRET)).toBe(false);
    expect(verifyWebhook({ "X-Zernio-Signature": sign(body, "other-secret") }, body, SECRET)).toBe(false);
    expect(verifyWebhook({}, body, SECRET)).toBe(false);
    expect(verifyWebhook({ "X-Zernio-Signature": "not-hex" }, body, SECRET)).toBe(false);
    expect(verifyWebhook({ "X-Zernio-Signature": sign(body) }, body, "")).toBe(false);
  });

  it("normalises post.published with our idempotency key echoed from metadata", () => {
    const e = normalizeEvent(f("webhook-post-published.json"));
    expect(e).toEqual({
      eventId: "evt_qf_0001", at: "2026-10-14T12:00:05Z", provider: "zernio", type: "post.published",
      providerPostId: "6a0f1c2d3e4f5a6b7c8d9f10", status: "published",
      idempotencyKey: "post:0b9a3c55-8f0e-4d55-9d0f-2f7c9f6b1a01:instagram:1",
      platforms: [{ platform: "instagram", accountId: IG, status: "published", platformPostId: "18000000000000042", url: "https://www.instagram.com/reel/QF0000demo/" }],
    });
  });

  it("normalises message.received into an inbox message with an account-qualified conversation id", () => {
    const e = normalizeEvent(f("webhook-message-received.json"));
    expect(e.type).toBe("message.received");
    if (e.type !== "message.received") throw new Error("type");
    expect(e.conversationId).toBe(`${IG}:6a0f1c2d3e4f5a6b7c8d9c01`);
    expect(e.message).toEqual({
      id: "6a0f1c2d3e4f5a6b7c8d9d03", conversationId: `${IG}:6a0f1c2d3e4f5a6b7c8d9c01`, platform: "instagram",
      from: { id: "17841400000000777", handle: "demo_reader_1", name: "Demo Reader" },
      text: "How much is the bookbinding workshop?", at: "2026-10-14T13:00:00Z", direction: "in",
    });
  });

  it("normalises comment.received, conversation.started, analytics.synced and unknown events", () => {
    const c = normalizeEvent(f("webhook-comment-received.json"));
    expect(c).toMatchObject({ type: "comment.received", accountId: IG, platformPostId: "18000000000000042", comment: { id: `${IG}:6a0f1c2d3e4f5a6b7c8d9f10:18050000000000001`, text: "STITCH please!" } });
    expect(normalizeEvent(f("webhook-conversation-started.json"))).toMatchObject({ type: "conversation.started", conversationId: `${IG}:6a0f1c2d3e4f5a6b7c8d9c03`, participant: { handle: "demo_reader_4" } });
    expect(normalizeEvent(f("webhook-analytics-synced.json"))).toMatchObject({ type: "analytics.synced", accountId: IG, platform: "instagram" });
    expect(normalizeEvent({ id: "evt_x", event: "review.new", timestamp: "2026-10-14T00:00:00Z" })).toMatchObject({ type: "unknown", event: "review.new" });
  });

  it("the handler verifies, parses and returns events; bad signatures are 401", async () => {
    const handler = createWebhookHandler(SECRET);
    const body = raw("webhook-message-received.json");
    const { events } = await handler({ headers: { "x-zernio-signature": sign(body), "x-zernio-event-id": "evt_qf_0002" }, body });
    expect(events).toHaveLength(1);
    expect(events[0]!.eventId).toBe("evt_qf_0002");
    const err = await handler({ headers: { "x-zernio-signature": sign(body, "nope") }, body }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WebhookError);
    expect((err as WebhookError).status).toBe(401);
    await expect(createWebhookHandler(undefined)({ headers: {}, body })).rejects.toMatchObject({ status: 401 });
    await expect(handler({ headers: { "x-zernio-signature": sign("nope") }, body: "nope" })).rejects.toMatchObject({ status: 400 });
  });
});

describe("zernio webhook contract (worker)", () => {
  const sign = (body: string) => createHmac("sha256", SECRET).update(body).digest("hex");

  it("verifies with the workspace secret and routes events to module jobs with event-id dedupe keys", () => {
    const { provider } = setup([]);
    const post = raw("webhook-post-published.json");
    expect(provider.verifyWebhook({ headers: { "x-zernio-signature": sign(post) }, body: post })).toBe(true);
    expect(provider.verifyWebhook({ headers: { "x-zernio-signature": sign(post) }, body: post + " " })).toBe(false);
    const route = (name: string) => provider.webhookJob(f(name), { headers: {}, body: raw(name) });
    expect(route("webhook-post-published.json")).toMatchObject({ jobId: "publishing.post-event", dedupeKey: "zernio:evt_qf_0001", input: { event: { type: "post.published", providerPostId: "6a0f1c2d3e4f5a6b7c8d9f10" } } });
    expect(route("webhook-message-received.json")).toMatchObject({ jobId: "community.inbox-event", dedupeKey: "zernio:evt_qf_0002" });
    expect(route("webhook-comment-received.json")).toMatchObject({ jobId: "community.inbox-event" });
    expect(route("webhook-conversation-started.json")).toMatchObject({ jobId: "community.inbox-event" });
    expect(route("webhook-analytics-synced.json")).toEqual({ jobId: "research.own-sync", input: {}, dedupeKey: "zernio:own-sync:2026-10-14T15" });
    expect(provider.webhookJob({ id: "evt_a", event: "account.disconnected", account: { id: IG, platform: "instagram" } }, { headers: {}, body: "" })).toMatchObject({ jobId: "publishing.sync-accounts" });
    expect(provider.webhookJob({ id: "evt_b", event: "message.read" }, { headers: {}, body: "" })).toBeNull();
    expect(provider.webhookJob("not json", { headers: {}, body: "not json" })).toBeNull();
  });
});

describe("helpers", () => {
  it("keyword variants cover lower, Title and UPPER and refuse empty keywords", () => {
    expect(keywordVariants("stitch")).toEqual(["stitch", "Stitch", "STITCH"]);
    expect(keywordVariants("StItCh")).toEqual(["stitch", "Stitch", "STITCH", "StItCh"]);
    expect(() => keywordVariants("  ")).toThrow(ProviderError);
  });
  it("idempotency UUIDs are stable and distinct per key", () => {
    expect(idempotencyUuid("a")).toBe(idempotencyUuid("a"));
    expect(idempotencyUuid("a")).not.toBe(idempotencyUuid("b"));
  });
});
