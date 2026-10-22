import { stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ProviderError,
  type AttentionOSConfig, type DmAutomation, type DmAutomationRequest, type Inbox, type InboxComment, type InboxMessage, type Logger,
  type MediaRef, type OwnAnalytics, type Platform, type PostMetricsSnapshot, type PublishRequest, type Publisher, type PublisherCapabilities,
  type SocialAccount, type WebhookCapable, type WebhookRequest, type WebhookRoute,
} from "@attentionos/core";
import { assertH264Aac, ffprobe, HttpClient, mimeFor, putFile, type FetchLike, type ProbeFn } from "@attentionos/provider-shared";
import type { ZernioAccountStat } from "./mapping.ts";
import {
  BASE_URL, PROVIDER, TO_ZERNIO, accountsResponse, automationSchema, buildCommentAutomationBody, buildCreatePostBody, describeError,
  errorBody, fromZernioPlatform, idempotencyUuid, isZernioId, joinRef, mapAccount, mapAnalytics, mapFollowerStats, mapPost, postEnvelope,
  profileIdOf, retryAfterFromBody, splitRef, type ZernioPublishResult,
} from "./mapping.ts";
import {
  EVENT_ID_HEADERS, WEBHOOK_SECRET_NAME, WebhookError, createWebhookHandler, header, normalizeEvent, verifyWebhook, webhookRoute, type WebhookHandler,
} from "./webhooks.ts";

export * from "./webhooks.ts";
export {
  BASE_URL, TO_ZERNIO, buildCommentAutomationBody, buildCreatePostBody, buildPlatformSpecificData, buildTiktokSettings, idempotencyUuid,
  joinRef, keywordVariants, mapAccount, mapAnalytics, mapFollowerStats, mapPost, mapRetention, splitRef, type ZernioAccountStat, type ZernioPublishResult,
} from "./mapping.ts";
export type { ProbeFn, VideoProbe } from "@attentionos/provider-shared";

export const ZERNIO_SECRETS = {
  apiKey: "ZERNIO_API_KEY",
  webhookSecret: WEBHOOK_SECRET_NAME,
  /** Optional: limit this workspace to one Zernio profile (one brand), e.g. with a profile-scoped key. */
  profileId: "ZERNIO_PROFILE_ID",
} as const;

/** The account id own-sync passes before any accounts are synced: "whatever this key can see". */
const OWN_ACCOUNTS = "me";

/** Zernio's per-file limit for presigned uploads. Platform limits (e.g. Instagram 300 MB) still apply. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;

export type ZernioCreateOptions = {
  secret(name: string): string | undefined;
  config: AttentionOSConfig;
  log: Logger;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  probe?: ProbeFn;
};

export type ZernioProvider = Publisher & Inbox & OwnAnalytics & Required<WebhookCapable> & {
  /** Zernio dedupes creates on the `Idempotency-Key` header for 24 h: resending after a crash is safe. */
  readonly supportsIdempotencyKeys: true;
  /** Core webhook contract: HMAC check of `X-Zernio-Signature` over the raw body with ZERNIO_WEBHOOK_SECRET. */
  verifyWebhook(req: WebhookRequest): boolean;
  /** Core webhook contract: normalises the event and picks the job the worker queues (dedupe key = event id). */
  webhookJob(payload: unknown, req: WebhookRequest): WebhookRoute | null;
  /** Standalone handler (verify + normalise) for hosts other than the AttentionOS worker. */
  webhookHandler: WebhookHandler;
  /** Daily follower history for one account (GET /accounts/follower-stats; needs Zernio's analytics add-on). */
  listAccountStats(accountId: string, opts?: { since?: string }): Promise<ZernioAccountStat[]>;
};

const presignResponse = z.looseObject({ uploadUrl: z.string().url(), publicUrl: z.string().url() });
const automationsResponse = z.looseObject({ automations: z.array(automationSchema).optional(), data: z.array(automationSchema).optional() });
const conversationSchema = z.looseObject({
  id: z.string().optional(),
  _id: z.string().optional(),
  accountId: z.union([z.string(), z.looseObject({ _id: z.string() })]).nullish(),
  updatedAt: z.string().nullish(),
  lastMessageAt: z.string().nullish(),
  participantUsername: z.string().nullish(),
  participantName: z.string().nullish(),
  participant: z.looseObject({ id: z.string().nullish(), username: z.string().nullish(), name: z.string().nullish() }).nullish(),
  participants: z.array(z.looseObject({ id: z.string().nullish(), username: z.string().nullish(), name: z.string().nullish() })).nullish(),
});
const conversationsResponse = z.looseObject({
  conversations: z.array(conversationSchema).optional(),
  data: z.array(conversationSchema).optional(),
});
const messageSchema = z.looseObject({
  id: z.string().optional(),
  _id: z.string().optional(),
  text: z.string().nullish(),
  message: z.string().nullish(),
  direction: z.string().nullish(),
  createdAt: z.string().nullish(),
  sentAt: z.string().nullish(),
  platform: z.string().nullish(),
  sender: z.looseObject({ id: z.string().nullish(), username: z.string().nullish(), name: z.string().nullish() }).nullish(),
});
const messagesResponse = z.looseObject({ messages: z.array(messageSchema).optional(), data: z.array(messageSchema).optional() });
const commentSchema = z.looseObject({
  id: z.string().optional(),
  _id: z.string().optional(),
  text: z.string().nullish(),
  message: z.string().nullish(),
  createdAt: z.string().nullish(),
  timestamp: z.string().nullish(),
  author: z.looseObject({ id: z.string().nullish(), username: z.string().nullish(), name: z.string().nullish() }).nullish(),
  from: z.looseObject({ id: z.string().nullish(), username: z.string().nullish(), name: z.string().nullish() }).nullish(),
  isOwner: z.boolean().nullish(),
  replies: z.array(z.unknown()).nullish(),
});
const commentsResponse = z.looseObject({ comments: z.array(commentSchema).optional(), data: z.array(commentSchema).optional() });
const sentResponse = z.looseObject({
  id: z.string().optional(),
  messageId: z.string().optional(),
  commentId: z.string().optional(),
  data: z.looseObject({ id: z.string().optional(), messageId: z.string().optional(), commentId: z.string().optional() }).optional(),
});
const analyticsPlatformEntry = z.looseObject({
  platform: z.string().nullish(),
  accountId: z.union([z.string(), z.looseObject({ _id: z.string() })]).nullish(),
  platformPostId: z.string().nullish(),
  platformPostUrl: z.string().nullish(),
  syncStatus: z.string().nullish(),
  analytics: z.record(z.string(), z.unknown()).nullish(),
});
const analyticsPost = z.looseObject({
  _id: z.string().optional(),
  postId: z.string().optional(),
  content: z.string().nullish(),
  publishedAt: z.string().nullish(),
  platform: z.string().nullish(),
  platformPostId: z.string().nullish(),
  platformPostUrl: z.string().nullish(),
  analytics: z.record(z.string(), z.unknown()).nullish(),
  platforms: z.array(analyticsPlatformEntry).nullish(),
});
const analyticsResponse = z.looseObject({ posts: z.array(analyticsPost).default([]) });

const idOf = (o: { id?: string | undefined; _id?: string | undefined }) => o.id ?? o._id;
const acctOf = (a: string | { _id: string } | null | undefined) => (typeof a === "string" ? a : a?._id);

export function create(opts: ZernioCreateOptions): ZernioProvider {
  const apiKey = opts.secret(ZERNIO_SECRETS.apiKey);
  const webhookSecret = opts.secret(ZERNIO_SECRETS.webhookSecret);
  const scopedProfileId = opts.secret(ZERNIO_SECRETS.profileId);
  const now = opts.now ?? (() => new Date());
  const probe = opts.probe ?? ffprobe;
  const http = new HttpClient({
    provider: PROVIDER,
    baseUrl: BASE_URL,
    headers: () => ({ authorization: `Bearer ${apiKey ?? ""}` }),
    log: opts.log,
    fetch: opts.fetch,
    sleep: opts.sleep,
    maxRetries: 4,
    describeError,
    retryAfterFromBody,
  });
  /** account id → profile id, filled by listAccounts (comment automations need the profile). */
  const accountProfiles = new Map<string, string>();

  const requireKey = () => {
    if (!apiKey) throw new ProviderError(PROVIDER, "auth", `add ${ZERNIO_SECRETS.apiKey} to your .env (Zernio dashboard → API keys)`);
  };

  async function rawAccounts() {
    requireKey();
    // No page/limit: Zernio returns every account when both are left out, and rejects a request that sends only one.
    const res = await http.request("GET", "/accounts", { query: { profileId: scopedProfileId }, schema: accountsResponse });
    for (const a of res.accounts) {
      const pid = profileIdOf(a);
      if (pid) accountProfiles.set(a._id, pid);
    }
    return res.accounts;
  }

  async function profileFor(accountId: string): Promise<string> {
    if (scopedProfileId) return scopedProfileId;
    if (!accountProfiles.has(accountId)) await rawAccounts();
    const pid = accountProfiles.get(accountId);
    if (!pid) throw new ProviderError(PROVIDER, "not_found", "that account isn't connected in Zernio (or belongs to another profile)");
    return pid;
  }

  async function upload(media: MediaRef): Promise<{ url: string }> {
    requireKey();
    if (media.url && !media.localPath) {
      if (!/^https:\/\//.test(media.url)) throw new ProviderError(PROVIDER, "invalid_request", "media URLs must be public https:// links that return the file itself");
      return { url: media.url };
    }
    if (!media.localPath) throw new ProviderError(PROVIDER, "invalid_request", "media needs a local file or a URL");
    await assertH264Aac(PROVIDER, media.localPath, probe);
    const filename = media.localPath.split(/[\\/]/).pop()!;
    const contentType = mimeFor(media.localPath, media.mimeType);
    // Zernio rejects application/octet-stream.
    if (contentType === "application/octet-stream") throw new ProviderError(PROVIDER, "invalid_request", `can't tell what kind of file ${filename} is; use .mp4, .mov, .jpg or .png`);
    const { size } = await stat(media.localPath);
    if (size > MAX_UPLOAD_BYTES) throw new ProviderError(PROVIDER, "invalid_request", `${filename} is larger than Zernio's 5 GB limit`);
    const res = await http.request("POST", "/media/presign", { body: { filename, contentType, size }, schema: presignResponse });
    await putFile({ provider: PROVIDER, uploadUrl: res.uploadUrl, localPath: media.localPath, contentType, fetch: opts.fetch });
    return { url: res.publicUrl };
  }

  /** Resolves a post reference to `{ accountId, postRef }` for the comments endpoints. */
  async function commentTarget(providerPostId: string): Promise<{ accountId: string; postRef: string }> {
    if (providerPostId.includes(":")) {
      const [accountId, postRef] = splitRef(providerPostId, 2);
      return { accountId, postRef };
    }
    if (!isZernioId(providerPostId)) throw new ProviderError(PROVIDER, "invalid_request", "pass a Zernio post id or <accountId>:<platformPostId>");
    const env = await http.request("GET", `/posts/${encodeURIComponent(providerPostId)}`, { schema: postEnvelope });
    const entry = env.post.platforms[0];
    const accountId = entry ? acctOf(entry.accountId) : undefined;
    if (!accountId) throw new ProviderError(PROVIDER, "not_found", "couldn't find which account published that post");
    return { accountId, postRef: entry?.platformPostId ?? providerPostId };
  }

  const provider: ZernioProvider = {
    id: PROVIDER,
    supportsIdempotencyKeys: true,

    async health() {
      if (!apiKey) return { ok: false, detail: "No Zernio API key", fix: `Create an API key in the Zernio dashboard and add it as ${ZERNIO_SECRETS.apiKey} in your .env (the first 2 accounts are free)` };
      try {
        const accounts = (await rawAccounts()).map(mapAccount).filter((a): a is SocialAccount => Boolean(a));
        const broken = accounts.filter((a) => a.status !== "connected");
        if (accounts.length === 0) return { ok: false, detail: "Zernio works, but no social accounts are connected", fix: "Connect your accounts in the Zernio dashboard" };
        if (broken.length) return { ok: false, detail: `${broken.map((a) => `${a.platform} @${a.handle}`).join(", ")} need reconnecting`, fix: "Reconnect them in the Zernio dashboard" };
        const hooks = webhookSecret ? "" : ` (no ${ZERNIO_SECRETS.webhookSecret}: post updates arrive by polling only)`;
        return { ok: true, detail: `Connected to Zernio with ${accounts.length} account${accounts.length === 1 ? "" : "s"}${hooks}` };
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err), fix: "Check ZERNIO_API_KEY" };
      }
    },

    capabilities(): PublisherCapabilities {
      return {
        platforms: ["instagram", "tiktok", "youtube", "facebook", "linkedin", "x", "threads"],
        scheduling: true,
        instagramTrialReels: true,
        instagramCollaborators: true,
        // Documented for feed posts and carousels; Reels support is ambiguous in the docs (see docs/providers/zernio.md).
        firstComment: true,
        maxVideoBytes: MAX_UPLOAD_BYTES,
      };
    },

    async listAccounts() {
      return (await rawAccounts()).map(mapAccount).filter((a): a is SocialAccount => Boolean(a));
    },

    uploadMedia: upload,

    async publish(req: PublishRequest): Promise<ZernioPublishResult> {
      requireKey();
      const media = [];
      for (const m of req.media) media.push({ url: (await upload(m)).url, kind: m.kind, ...(m.mimeType ? { mimeType: m.mimeType } : {}) });
      const body = buildCreatePostBody(req, media);
      try {
        const env = await http.request("POST", "/posts", {
          body,
          headers: { "idempotency-key": idempotencyUuid(req.idempotencyKey) },
          schema: postEnvelope,
        });
        return mapPost(env.post, req.platform);
      } catch (err) {
        // Same content to the same account within 24 h: Zernio answers 409 with the existing post. Treat as done.
        if (err instanceof ProviderError && err.details?.status === 409) {
          const parsed = errorBody.safeParse(err.details?.raw);
          const existing = parsed.success ? parsed.data.details?.existingPostId : undefined;
          if (existing) return provider.getPost(existing);
        }
        throw err;
      }
    },

    async getPost(providerPostId: string) {
      requireKey();
      const env = await http.request("GET", `/posts/${encodeURIComponent(providerPostId)}`, { schema: postEnvelope });
      return mapPost(env.post);
    },

    async cancel(providerPostId: string) {
      requireKey();
      // Works for any status except published (it only removes Zernio's record, never the live post).
      await http.request("DELETE", `/posts/${encodeURIComponent(providerPostId)}`);
    },

    // --- Inbox -------------------------------------------------------------------------------------------------

    async createDmAutomation(req: DmAutomationRequest): Promise<DmAutomation> {
      requireKey();
      const profileId = await profileFor(req.accountId);
      const body = buildCommentAutomationBody(req, profileId);
      // No idempotency key on this endpoint: only retry when Zernio refused the request (429).
      const raw = await http.request("POST", "/comment-automations", { body, retry: "rate_limited" });
      const a = automationSchema.parse((raw as { automation?: unknown; data?: unknown }).automation ?? (raw as { data?: unknown }).data ?? raw);
      const id = idOf(a);
      if (!id) throw new ProviderError(PROVIDER, "upstream", "Zernio didn't return an automation id");
      return { id, keyword: req.keyword, providerPostId: req.providerPostId, active: a.isActive ?? true };
    },

    async listDmAutomations(accountId: string) {
      requireKey();
      const res = await http.request("GET", "/comment-automations", { query: { accountId }, schema: automationsResponse });
      return (res.automations ?? res.data ?? [])
        .filter((a) => !a.accountId || acctOf(a.accountId) === accountId)
        .map((a) => ({ id: idOf(a) ?? "", keyword: a.keywords?.[0] ?? "", providerPostId: a.postId ?? a.platformPostId ?? null, active: a.isActive ?? false }))
        .filter((a) => a.id);
    },

    async deleteDmAutomation(id: string) {
      requireKey();
      await http.request("DELETE", `/comment-automations/${encodeURIComponent(id)}`);
    },

    async listConversations(accountId: string, o = {}) {
      requireKey();
      const res = await http.request("GET", "/inbox/conversations", { query: { accountId, limit: o.limit ?? 50, sortOrder: "desc" }, schema: conversationsResponse });
      return (res.conversations ?? res.data ?? [])
        .map((c) => {
          const part = c.participant ?? c.participants?.[0];
          return {
            id: joinRef(accountId, idOf(c) ?? ""),
            lastMessageAt: c.lastMessageAt ?? c.updatedAt ?? new Date(0).toISOString(),
            participant: part?.username ?? c.participantUsername ?? part?.name ?? c.participantName ?? part?.id ?? "unknown",
          };
        })
        .filter((c) => !c.id.endsWith(":") && (!o.since || c.lastMessageAt >= o.since));
    },

    async listMessages(conversationId: string, o = {}) {
      requireKey();
      const [accountId, conv] = splitRef(conversationId, 2);
      const res = await http.request("GET", `/inbox/conversations/${encodeURIComponent(conv)}/messages`, { query: { accountId, sortOrder: "desc", limit: o.limit }, schema: messagesResponse });
      return (res.messages ?? res.data ?? [])
        .map((m): InboxMessage => ({
          id: idOf(m) ?? "",
          conversationId,
          platform: fromZernioPlatform(m.platform) ?? "instagram",
          from: { id: m.sender?.id ?? "unknown", ...(m.sender?.username ? { handle: m.sender.username } : {}), ...(m.sender?.name ? { name: m.sender.name } : {}) },
          text: m.text ?? m.message ?? "",
          at: m.createdAt ?? m.sentAt ?? new Date(0).toISOString(),
          direction: m.direction === "outgoing" || m.direction === "out" ? "out" : "in",
        }))
        .filter((m) => m.id && (!o.since || m.at >= o.since));
    },

    async listComments(providerPostId: string, o = {}) {
      requireKey();
      const { accountId, postRef } = await commentTarget(providerPostId);
      const res = await http.request("GET", `/inbox/comments/${encodeURIComponent(postRef)}`, { query: { accountId, limit: o.limit }, schema: commentsResponse });
      const platform: Platform = "instagram";
      return (res.comments ?? res.data ?? [])
        .filter((c) => !c.isOwner)
        .map((c): InboxComment => {
          const author = c.author ?? c.from;
          return {
            id: joinRef(accountId, postRef, idOf(c) ?? ""),
            providerPostId: postRef,
            platform,
            from: { id: author?.id ?? "unknown", ...(author?.username ? { handle: author.username } : {}) },
            text: c.text ?? c.message ?? "",
            at: c.createdAt ?? c.timestamp ?? new Date(0).toISOString(),
          };
        })
        .filter((c) => !c.id.endsWith(":") && (!o.since || c.at >= o.since));
    },

    async sendMessage(conversationId: string, text: string) {
      requireKey();
      const [accountId, conv] = splitRef(conversationId, 2);
      const key = idempotencyUuid(`dm:${conversationId}:${createHash("sha256").update(text).digest("hex")}`);
      const res = await http.request("POST", `/inbox/conversations/${encodeURIComponent(conv)}/messages`, {
        body: { accountId, message: text },
        headers: { "idempotency-key": key },
        schema: sentResponse,
      });
      return { id: res.messageId ?? res.id ?? res.data?.messageId ?? res.data?.id ?? "sent" };
    },

    async replyToComment(commentId: string, text: string) {
      requireKey();
      const [accountId, postRef, comment] = splitRef(commentId, 3);
      const key = idempotencyUuid(`reply:${commentId}:${createHash("sha256").update(text).digest("hex")}`);
      const res = await http.request("POST", `/inbox/comments/${encodeURIComponent(postRef)}`, {
        body: { accountId, message: text, commentId: comment },
        headers: { "idempotency-key": key },
        schema: sentResponse,
      });
      return { id: res.commentId ?? res.id ?? res.data?.commentId ?? res.data?.id ?? "sent" };
    },

    // --- Analytics ---------------------------------------------------------------------------------------------

    async listPostMetrics(accountId: string, o = {}): Promise<PostMetricsSnapshot[]> {
      requireKey();
      // "me" (no accounts synced into AttentionOS yet) reads every account the key can see, within ZERNIO_PROFILE_ID if set.
      const scope = accountId === OWN_ACCOUNTS ? { profileId: scopedProfileId } : { accountId };
      const res = await http.request("GET", "/analytics", {
        query: { ...scope, source: "all", fromDate: o.since ? o.since.slice(0, 10) : undefined, limit: Math.min(o.limit ?? 50, 100), sortBy: "date" },
        schema: analyticsResponse,
      });
      const capturedAt = now().toISOString();
      const out: PostMetricsSnapshot[] = [];
      for (const p of res.posts) {
        const entries = p.platforms?.length
          ? p.platforms.filter((e) => !("accountId" in scope) || !e.accountId || acctOf(e.accountId) === accountId)
          : [{ platform: p.platform, platformPostId: p.platformPostId, platformPostUrl: p.platformPostUrl, analytics: p.analytics, syncStatus: undefined }];
        for (const e of entries) {
          const platform = fromZernioPlatform(e.platform);
          const platformPostId = e.platformPostId;
          if (!platform || !platformPostId || !e.analytics || e.syncStatus === "unavailable") continue;
          out.push(mapAnalytics({
            platform, platformPostId, capturedAt, analytics: e.analytics,
            ...(p._id ?? p.postId ? { providerPostId: (p._id ?? p.postId)! } : {}),
            ...(e.platformPostUrl ? { url: e.platformPostUrl } : {}),
            ...(p.publishedAt ? { publishedAt: p.publishedAt } : {}),
            ...(p.content ? { caption: p.content } : {}),
          }));
        }
      }
      return out;
    },

    async listAccountStats(accountId: string, o = {}): Promise<ZernioAccountStat[]> {
      requireKey();
      const res = await http.request("GET", "/accounts/follower-stats", {
        query: { accountIds: accountId, fromDate: o.since ? o.since.slice(0, 10) : undefined, granularity: "daily" },
        schema: z.looseObject({}),
      });
      return mapFollowerStats(res, accountId, now().toISOString());
    },

    verifyWebhook: (req) => verifyWebhook(req.headers, req.body, webhookSecret ?? ""),
    webhookJob(payload, req) {
      try {
        return webhookRoute(normalizeEvent(payload, header(req.headers, EVENT_ID_HEADERS)));
      } catch (err) {
        if (err instanceof WebhookError) {
          opts.log.warn("zernio: ignored a webhook it couldn't read", { error: err.message });
          return null;
        }
        throw err;
      }
    },
    webhookHandler: createWebhookHandler(webhookSecret),
  };
  return provider;
}
