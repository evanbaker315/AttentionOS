import type { Platform } from "./types.ts";

/**
 * Provider contracts. Modules depend on these interfaces only; vendor SDKs live in
 * `packages/providers/<kind>-<vendor>`. Every adapter ships contract tests with recorded fixtures.
 *
 * Conventions:
 * - All methods are async and throw `ProviderError` (never vendor errors) with a stable `code`.
 * - Idempotency keys are honored where the vendor supports them; otherwise adapters dedupe locally.
 * - Timestamps are ISO-8601 strings in UTC.
 */

export type ProviderErrorCode =
  | "auth" // bad or missing credentials
  | "not_found"
  | "rate_limited" // retryAfterMs may be set
  | "invalid_request" // payload rejected; fix before retrying
  | "unsupported" // the vendor can't do this (e.g. trending audio via API)
  | "conflict" // e.g. another automation tool owns this IG account's DMs
  | "budget_exceeded"
  | "upstream"; // vendor 5xx / network

export class ProviderError extends Error {
  constructor(
    public readonly provider: string,
    public readonly code: ProviderErrorCode,
    message: string,
    public readonly details?: { status?: number; retryAfterMs?: number; vendorCode?: string | number; raw?: unknown },
  ) {
    super(`[${provider}] ${code}: ${message}`);
    this.name = "ProviderError";
  }
}

export type ProviderHealth = { ok: boolean; detail: string; fix?: string };

export interface ProviderBase {
  /** e.g. "zernio", "blotato", "apify". */
  readonly id: string;
  /** Used by `attentionos doctor`. Must not spend money. */
  health(): Promise<ProviderHealth>;
}

/** Inbound webhook as received by the worker at `POST /webhooks/<provider id>`. */
export type WebhookRequest = { headers: Record<string, string | undefined>; body: string };

/** Which job the worker should enqueue for a verified webhook. */
export type WebhookRoute = { jobId: string; input?: Record<string, unknown>; dedupeKey?: string };

/**
 * Optional on any provider that receives webhooks (e.g. Zernio `post.*`, `message.*`, `analytics.synced`).
 * The worker rejects the request unless `verifyWebhook` returns true, then enqueues `webhookJob`'s route.
 */
export interface WebhookCapable {
  verifyWebhook?(req: WebhookRequest): boolean | Promise<boolean>;
  webhookJob?(payload: unknown, req: WebhookRequest): WebhookRoute | null | Promise<WebhookRoute | null>;
}

// ---------------------------------------------------------------------------
// Publishing, inbox, analytics
// ---------------------------------------------------------------------------

export type SocialAccount = {
  providerAccountId: string;
  platform: Platform;
  handle: string;
  displayName?: string;
  status: "connected" | "expired" | "error";
};

export type MediaRef = { kind: "video" | "image"; url?: string; localPath?: string; mimeType?: string; durationS?: number };

export type PlatformOptions = {
  instagram?: {
    shareToFeed?: boolean;
    collaborators?: string[];
    /** Post as a trial reel: shown to non-followers first, never on the main grid. */
    trialReel?: boolean;
    /** When a trial reel is shown to followers: "MANUAL" (default, you decide) or "SS_PERFORMANCE" (automatically when it performs well). */
    trialGraduation?: "MANUAL" | "SS_PERFORMANCE";
    coverUrl?: string;
    firstComment?: string;
  };
  tiktok?: { privacy?: "public" | "friends" | "private"; aiGenerated?: boolean; allowComments?: boolean; allowDuet?: boolean; allowStitch?: boolean };
  youtube?: { title?: string; privacy?: "public" | "unlisted" | "private"; madeForKids?: boolean; shorts?: boolean };
  linkedin?: { visibility?: "public" | "connections" };
  facebook?: { pageId?: string };
  x?: { replySettings?: "everyone" | "following" | "mentioned" };
  threads?: Record<string, never>;
};

export type PublishRequest = {
  idempotencyKey: string;
  accountId: string; // providerAccountId
  platform: Platform;
  caption: string;
  media: MediaRef[];
  /** Omit to publish now. */
  scheduledAt?: string;
  options?: PlatformOptions;
};

export type PublishResult = {
  providerPostId: string;
  status: "scheduled" | "publishing" | "published" | "failed";
  url?: string;
  /** Some vendors only expose the platform post id later (e.g. after a sync). */
  platformPostId?: string;
  scheduledAt?: string;
  /** Vendor's reason when status is "failed". */
  error?: string;
};

export interface Publisher extends ProviderBase {
  listAccounts(): Promise<SocialAccount[]>;
  /** Upload once, reuse across platforms. Returns a vendor-hosted URL. */
  uploadMedia(media: MediaRef): Promise<{ url: string }>;
  publish(req: PublishRequest): Promise<PublishResult>;
  getPost(providerPostId: string): Promise<PublishResult>;
  cancel(providerPostId: string): Promise<void>;
  /** Platforms/features this vendor supports, so payload validation can fail BEFORE any API call. */
  capabilities(): PublisherCapabilities;
}

export type PublisherCapabilities = {
  platforms: Platform[];
  scheduling: boolean;
  instagramTrialReels: boolean;
  instagramCollaborators: boolean;
  firstComment: boolean;
  maxVideoBytes?: number;
  /** True when the vendor dedupes on our idempotency key; otherwise create calls are never retried on 5xx. */
  supportsIdempotencyKeys?: boolean;
};

export type DmAutomationRequest = {
  accountId: string;
  platform: "instagram" | "facebook";
  /** Scope to one post; null = account-wide (discouraged). */
  providerPostId: string | null;
  keyword: string;
  /** Case variants are added by the adapter if the vendor matches case-sensitively. */
  matchMode: "exact_word" | "contains";
  replyComment?: string;
  dmText: string;
  buttons?: { label: string; url: string }[];
  requireFollow?: boolean;
  followGateText?: string;
};

export type DmAutomation = { id: string; keyword: string; providerPostId: string | null; active: boolean };

export type InboxMessage = {
  id: string;
  conversationId: string;
  platform: Platform;
  from: { id: string; handle?: string; name?: string };
  text: string;
  at: string;
  direction: "in" | "out";
};

export type InboxComment = {
  id: string;
  providerPostId: string;
  platform: Platform;
  from: { id: string; handle?: string };
  text: string;
  at: string;
};

export interface Inbox extends ProviderBase {
  createDmAutomation(req: DmAutomationRequest): Promise<DmAutomation>;
  listDmAutomations(accountId: string): Promise<DmAutomation[]>;
  deleteDmAutomation(id: string): Promise<void>;
  listConversations(accountId: string, opts?: { since?: string; limit?: number }): Promise<{ id: string; lastMessageAt: string; participant: string }[]>;
  listMessages(conversationId: string, opts?: { since?: string; limit?: number }): Promise<InboxMessage[]>;
  listComments(providerPostId: string, opts?: { since?: string; limit?: number }): Promise<InboxComment[]>;
  /** Sending is only ever done after human approval (drafts only by default). */
  sendMessage(conversationId: string, text: string): Promise<{ id: string }>;
  replyToComment(commentId: string, text: string): Promise<{ id: string }>;
}

export type PostMetricsSnapshot = {
  platformPostId: string;
  providerPostId?: string;
  platform: Platform;
  capturedAt: string;
  url?: string;
  publishedAt?: string;
  caption?: string;
  durationS?: number;
  views?: number;
  reach?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
  follows?: number;
  profileVisits?: number;
  avgWatchTimeS?: number;
  /** 0–1. Often unavailable by API (IG skip rate comes via CSV import). */
  skipRate?: number;
  completionRate?: number;
  raw?: Record<string, unknown>;
};

/** One day of account-level numbers (follower history). */
export type AccountStat = { day: string; platform?: Platform; followers?: number; following?: number; posts?: number; capturedAt?: string };

export interface OwnAnalytics extends ProviderBase {
  /** Posts plus latest metrics for an account, newest first. `accountId` is "me" before any accounts are synced: read the key's own accounts. */
  listPostMetrics(accountId: string, opts?: { since?: string; limit?: number }): Promise<PostMetricsSnapshot[]>;
  /** Optional: daily follower history, when the vendor exposes it. */
  listAccountStats?(accountId: string, opts?: { since?: string }): Promise<AccountStat[]>;
}

// ---------------------------------------------------------------------------
// Research
// ---------------------------------------------------------------------------

export type ExternalPost = {
  platform: Platform;
  platformPostId: string;
  authorHandle: string;
  url: string;
  publishedAt: string;
  caption?: string;
  durationS?: number;
  isPinned?: boolean;
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  /** Most-liked comments ("comment gold"). */
  topComments?: { text: string; likes?: number }[];
  videoUrl?: string;
  thumbnailUrl?: string;
};

export interface Scraper extends ProviderBase {
  /** Recent posts for one creator. `estimateCostUsd` MUST be called and checked against the budget first. */
  listCreatorPosts(handle: string, platform: Platform, opts?: { limit?: number; since?: string }): Promise<ExternalPost[]>;
  estimateCostUsd(handles: { handle: string; platform: Platform }[], opts?: { limit?: number }): Promise<number>;
  /** Download a post's media to a local path (for transcription / teardown). */
  downloadMedia?(post: ExternalPost, destDir: string): Promise<{ localPath: string }>;
  /** Paid scrapers: spend from finished runs since the last call; the caller records it in `cost_ledger`. */
  drainSpend?(): ScraperSpend[];
  /** Paid scrapers: month-to-date usage on the vendor account (must be free to call). */
  accountUsageUsd?(): Promise<{ usedUsd: number; limitUsd?: number }>;
  /**
   * Optional: public account numbers for one handle. Reuses what a recent `listCreatorPosts` for the same handle
   * already returned when it can (free); otherwise it may start a paid run, refused with `budget_exceeded` when its
   * estimate is above `maxUsd`. Paid runs are reported through `drainSpend`. Null when the vendor shows no counts.
   */
  fetchProfile?(handle: string, platform: Platform, opts?: { maxUsd?: number }): Promise<CreatorProfile | null>;
}

/** Public follower / following / post counts for one handle, as a scraper read them. */
export type CreatorProfile = { platform: Platform; handle: string; followers?: number; following?: number; posts?: number; capturedAt: string };

export type ScraperSpend = { usd: number; estimated?: boolean; handle?: string; platform?: Platform; items?: number; runId?: string; detail?: Record<string, unknown> };

export type TrendItem = {
  sourceId: string;
  externalId: string;
  title: string;
  url: string;
  publishedAt: string;
  author?: string;
  /** Engagement counters at fetch time; velocity is computed between fetches. */
  points?: number;
  comments?: number;
  followers?: number;
  /** UNTRUSTED text. Only tool-less LLM calls with output validators may read it. */
  text?: string;
};

export interface TrendSource extends ProviderBase {
  fetch(target: string, opts?: { since?: string; limit?: number }): Promise<TrendItem[]>;
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

export type Word = { text: string; start: number; end: number; confidence?: number };
export type Transcript = { language: string; text: string; words: Word[]; durationS: number };

export interface Asr extends ProviderBase {
  /** Word timestamps are required. */
  transcribe(localPath: string, opts?: { language?: string; prompt?: string }): Promise<Transcript>;
}

export interface ImageGen extends ProviderBase {
  estimateCostUsd(req: { prompt: string; size: string; count: number }): number;
  generate(req: { prompt: string; size: "1080x1350" | "1080x1080" | "1080x1920"; count: number; destDir: string }): Promise<{ localPaths: string[]; costUsd: number }>;
}

// ---------------------------------------------------------------------------
// Notify, CRM, storage
// ---------------------------------------------------------------------------

export type NotifyAction = { id: string; label: string; style?: "primary" | "danger" | "default" };

export type OutboundMessage = {
  /** Dedupe key: the same key is never delivered twice within `dedupeWindowMs`. */
  dedupeKey?: string;
  text: string;
  /** Markdown subset supported by all channels: *bold*, _italic_, `code`, [link](url). */
  format?: "plain" | "markdown";
  actions?: NotifyAction[];
  attachments?: { localPath: string; caption?: string }[];
  /** Thread/ref this message belongs to (e.g. "rf-123" for an edit revision loop). */
  ref?: string;
  priority?: "low" | "normal" | "high";
};

export type InboundMessage = {
  channel: string;
  messageId: string;
  text: string;
  from: string;
  at: string;
  /** Present when the user replied to one of our messages. */
  replyToRef?: string;
  /** Present when the user pressed an action button. */
  actionId?: string;
  attachments?: { url: string; kind: "video" | "image" | "audio" | "file"; fileName?: string }[];
};

export interface Notifier extends ProviderBase {
  send(msg: OutboundMessage): Promise<{ messageId: string }>;
  /** Long-poll or webhook-fed; returns new inbound messages since the cursor. */
  receive(cursor?: string): Promise<{ messages: InboundMessage[]; cursor: string }>;
}

export type Lead = {
  email?: string;
  name?: string;
  phone?: string;
  handle?: string;
  platform?: Platform;
  keyword?: string;
  utmContent?: string;
  source: string;
  temperature?: "hot" | "warm" | "cold";
  notes?: string;
};

export interface Crm extends ProviderBase {
  upsertLead(lead: Lead): Promise<{ id: string }>;
}

export interface Storage extends ProviderBase {
  put(localPath: string, key: string): Promise<{ uri: string }>;
  get(uri: string, destPath: string): Promise<{ localPath: string }>;
  url(uri: string, opts?: { expiresInS?: number }): Promise<string>;
}

/** Everything a module can ask for. Unconfigured providers are absent. */
export type ProviderRegistry = {
  publisher?: Publisher;
  inbox?: Inbox;
  ownAnalytics?: OwnAnalytics;
  scraper?: Scraper;
  trendSources: Record<string, TrendSource>;
  asr?: Asr;
  imageGen?: ImageGen;
  notifier?: Notifier;
  crm?: Crm;
  storage?: Storage;
};
