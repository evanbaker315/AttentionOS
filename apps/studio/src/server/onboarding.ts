import "server-only";
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AGENT_KEYS, AUTONOMY_LEVELS, type AgentKey } from "@attentionos/core";
import { enqueueRun, recordAgentEvent } from "@attentionos/db";
import {
  contentHash,
  parseYamlLoose,
  patchYaml,
  readBrandFile,
  readLanes,
  validateBrandFile,
  writeBrandFile,
} from "@attentionos/module-onboarding/brand-files";
import { initialState, isFinished, readState, updateState, type ConnectedAccount, type OnboardingState } from "@attentionos/module-onboarding/state";
import { workerState } from "./doctor";
import { applyConfigEdits, engineRoot, isTimezone, readEnvFile, writeEnvKey, type ConfigEdit } from "./settings";
import { workspace, type StudioWorkspace } from "./workspace";

/**
 * Server side of Studio's setup wizard (`/setup`). The wizard's state lives in `settings` (`onboarding:state`) and is
 * owned by `@attentionos/module-onboarding/state`; Brand Kit files are validated and written by the module's
 * brand-files helpers; config edits and keys reuse Settings' safe writers. Nothing here talks to a model: AI work is
 * queued for the worker as onboarding jobs.
 */

export const ACTOR = "user:studio";

// ───────────────────────────── State and the shell redirect ─────────────────────────────

export async function loadState(ws: StudioWorkspace = workspace()): Promise<OnboardingState> {
  return (await readState(ws.sql, ws.id)) ?? initialState();
}

export function mutateState(fn: (s: OnboardingState) => OnboardingState, ws: StudioWorkspace = workspace()): Promise<OnboardingState> {
  return updateState(ws.sql, ws.id, fn);
}

/** A workspace with a filled-in brand one-liner was set up before the wizard existed (or by `/attention:init`). */
function brandLooksSetUp(root: string): boolean {
  try {
    const parsed = parseYamlLoose(readFileSync(join(root, "brand", "brand.yaml"), "utf8")) as { oneLiner?: unknown } | null;
    return typeof parsed?.oneLiner === "string" && parsed.oneLiner.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Whether the OS shell should send the owner to `/setup`. Setup counts as needed while `onboarding:state` exists and
 * isn't finished, or when there's no state yet and the Brand Kit is still the blank template. Workspaces set up another
 * way are never redirected. Any error answers "no": the shell must always load.
 */
export async function needsOnboarding(ws: StudioWorkspace = workspace()): Promise<boolean> {
  try {
    const rows = await ws.sql<{ value: unknown }[]>`
      select s.value from workspaces w
        left join settings s on s.workspace_id = w.id and s.key = 'onboarding:state'
       where w.id = ${ws.id}`;
    const row = rows[0];
    if (!row) return false;
    if (row.value) return !isFinished((await readState(ws.sql, ws.id))!);
    return !brandLooksSetUp(ws.root);
  } catch {
    return false;
  }
}

// ───────────────────────────── Queueing agent work ─────────────────────────────

export async function enqueue(
  jobId: string,
  agent: AgentKey,
  input: Record<string, unknown>,
  opts: { dedupeKey?: string; message?: string; runAfter?: Date; maxAttempts?: number } = {},
  ws: StudioWorkspace = workspace(),
): Promise<string> {
  const { id, deduped } = await enqueueRun(ws.sql, {
    workspaceId: ws.id,
    jobId,
    agent,
    trigger: "manual",
    createdBy: ACTOR,
    input,
    maxAttempts: opts.maxAttempts ?? 1,
    ...(opts.dedupeKey ? { dedupeKey: opts.dedupeKey } : {}),
    ...(opts.runAfter ? { runAfter: opts.runAfter } : {}),
  });
  if (!deduped && opts.message) {
    await recordAgentEvent(ws.sql, { workspaceId: ws.id, agent: ACTOR, kind: "handoff", runId: id || null, message: opts.message, data: { to: agent, jobId } });
  }
  return id;
}

export type RunInfo = { id: string; status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "waiting_approval"; error: string | null; progress: string | null };

/** Status plus the latest plain-language progress line of each run. */
export async function runInfo(ids: (string | undefined)[], ws: StudioWorkspace = workspace()): Promise<Record<string, RunInfo>> {
  const list = [...new Set(ids.filter((x): x is string => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x)))];
  if (!list.length) return {};
  const rows = await ws.sql<{ id: string; status: RunInfo["status"]; error: string | null; progress: string | null }[]>`
    select r.id, r.status, r.error,
           (select e.message from agent_events e where e.workspace_id = r.workspace_id and e.run_id = r.id and e.kind = 'progress'
             order by e.id desc limit 1) as progress
      from agent_runs r where r.workspace_id = ${ws.id} and r.id = any(${list})`;
  return Object.fromEntries(rows.map((r) => [r.id, { id: r.id, status: r.status, error: r.error, progress: r.progress }]));
}

// ───────────────────────────── Brand Kit files ─────────────────────────────

export function brandFile(file: string, ws: StudioWorkspace = workspace()): string {
  return readBrandFile(ws.root, file);
}

/**
 * Validates every file first, then writes them all (so an approval never leaves the kit half-updated), indexes them
 * in `brand_docs` and records one plain event.
 */
export async function saveBrandFiles(files: { file: string; content: string }[], summary: string, ws: StudioWorkspace = workspace()): Promise<string[]> {
  const clean = files.map((f) => ({ file: f.file, content: validateBrandFile(f.file, f.content) }));
  const changed: string[] = [];
  const unsynced = new Set<string>();
  for (const f of clean) {
    const w = writeBrandFile(ws.root, f.file, f.content);
    if (w.changed) changed.push(w.path);
    // Keep the database copy in step with the file on disk. This runs for unchanged files too, so saving again repairs
    // an earlier miss; the `where` makes it a no-op when the copy already matches.
    let synced = w.changed;
    try {
      const rows = await ws.sql`
        insert into brand_docs (workspace_id, path, content, content_hash, updated_at)
        values (${ws.id}, ${w.path}, ${f.content}, ${contentHash(f.content)}, now())
        on conflict (workspace_id, path) do update set content = excluded.content, content_hash = excluded.content_hash, updated_at = now()
         where brand_docs.content_hash is distinct from excluded.content_hash
        returning path`;
      synced ||= rows.length > 0;
    } catch (err) {
      console.error(`[studio] couldn't update the database copy of ${w.path}:`, err);
      unsynced.add(w.path);
    }
    if (!synced) continue;
    // Re-index the file for knowledge_search (the knowledge module's job).
    try {
      await enqueue("knowledge.index-path", "analyst", { path: w.path }, { dedupeKey: `knowledge:index:${w.path}:${w.hash.slice(0, 12)}` }, ws);
    } catch (err) {
      console.error(`[studio] couldn't queue search indexing for ${w.path}:`, err);
      unsynced.add(w.path);
    }
  }
  if (changed.length) {
    // Best effort: the activity feed line is a courtesy; the files themselves are saved.
    await recordAgentEvent(ws.sql, { workspaceId: ws.id, agent: ACTOR, kind: "progress", message: summary, data: { files: changed } }).catch((err) => console.error("[studio] recording the Brand Kit event failed:", err));
  }
  if (unsynced.size) {
    throw new Error(`Saved your Brand Kit files, but the team's search copy of ${[...unsynced].join(", ")} didn't update. Check the database connection, then save again.`);
  }
  return changed;
}

// ───────────────────────────── Engine catalog: presets and formats ─────────────────────────────

export type PresetCard = {
  id: string;
  name: string;
  description: string;
  forWho: string[];
  funnelMix: { tofu: number; mofu: number; bofu: number };
  northStar: string;
  primaryCta: string;
  lanes: { id: string; name: string; weeklyQuota: number; funnelStage: string; description: string }[];
  files: Record<string, string>;
};

function engineDir(...parts: string[]): string | null {
  const root = engineRoot();
  if (!root) return null;
  const dir = join(root, ...parts);
  return existsSync(dir) ? dir : null;
}

export function listPresets(): PresetCard[] {
  const dir = engineDir("presets");
  if (!dir) return [];
  const out: PresetCard[] = [];
  for (const id of readdirSync(dir).sort()) {
    const file = join(dir, id, "preset.json");
    if (!existsSync(file)) continue;
    try {
      const p = JSON.parse(readFileSync(file, "utf8")) as Partial<PresetCard> & { northStar?: { metric?: string } };
      const pillars = join(dir, id, "pillars.md");
      out.push({
        id: p.id ?? id,
        name: p.name ?? id,
        description: p.description ?? "",
        forWho: p.forWho ?? [],
        funnelMix: p.funnelMix ?? { tofu: 50, mofu: 30, bofu: 20 },
        northStar: p.northStar?.metric ?? "leads_per_week",
        primaryCta: (p as { primaryCta?: string }).primaryCta ?? "comment_keyword",
        lanes: existsSync(pillars) ? readLanes(readFileSync(pillars, "utf8")) : [],
        files: (p.files as Record<string, string>) ?? {},
      });
    } catch {
      // A broken preset is skipped; doctor reports it.
    }
  }
  return out;
}

export type FormatCard = {
  id: string;
  name: string;
  summary: string;
  bestFor: string[];
  needs: string[];
  layout: string;
  modes: string[];
  captions: string;
  music: string;
  sfx: string;
  shoot: { title: string; text: string }[];
};

/** The first few bold-labelled paragraphs of shoot.md, as plain text. */
function shootSummary(md: string): { title: string; text: string }[] {
  const out: { title: string; text: string }[] = [];
  for (const block of md.split(/\n\s*\n/)) {
    const m = /^\*\*([^*]+)\*\*\s*([\s\S]*)$/.exec(block.trim());
    if (!m) continue;
    const text = m[2]!.replace(/\n-\s+/g, " · ").replace(/^-\s+/, "").replace(/\s+/g, " ").trim();
    if (text) out.push({ title: m[1]!.replace(/\.$/, ""), text: text.slice(0, 280) });
    if (out.length >= 4) break;
  }
  return out;
}

export function listFormats(): FormatCard[] {
  const dir = engineDir("templates", "formats");
  if (!dir) return [];
  const out: FormatCard[] = [];
  for (const id of readdirSync(dir).sort()) {
    const file = join(dir, id, "format.json");
    if (!existsSync(file)) continue;
    try {
      const f = JSON.parse(readFileSync(file, "utf8")) as {
        id: string; name: string; summary: string; bestFor?: string[]; needs?: string[];
        layout?: { default?: string; modes?: { mode: string }[] }; captions?: { style?: string }; audio?: { sfx?: string; music?: string };
      };
      const shoot = join(dir, id, "shoot.md");
      out.push({
        id: f.id ?? id,
        name: f.name,
        summary: f.summary,
        bestFor: f.bestFor ?? [],
        needs: f.needs ?? [],
        layout: f.layout?.default ?? "full",
        modes: (f.layout?.modes ?? []).map((m) => m.mode),
        captions: f.captions?.style ?? "clean",
        music: f.audio?.music ?? "none",
        sfx: f.audio?.sfx ?? "none",
        shoot: existsSync(shoot) ? shootSummary(readFileSync(shoot, "utf8")) : [],
      });
    } catch {
      // skip a broken format
    }
  }
  return out;
}

/**
 * Applies a preset to the Brand Kit: its files (lanes, trend sources, cadence and CTA notes) replace the current ones,
 * and brand.yaml takes its funnel mix and CTA model. Returns the files written.
 */
export async function applyPreset(preset: PresetCard, ws: StudioWorkspace = workspace()): Promise<string[]> {
  const dir = engineDir("presets", preset.id);
  if (!dir) throw new Error("That preset isn't installed.");
  const brandFiles: { file: string; content: string }[] = [];
  for (const [src, dest] of Object.entries(preset.files)) {
    const from = join(dir, src);
    if (!existsSync(from)) continue;
    if (/^brand\/[^/]+$/.test(dest)) {
      brandFiles.push({ file: dest, content: readFileSync(from, "utf8") });
    } else if (/^brand\/knowledge\/[a-z0-9._-]+$/i.test(dest)) {
      const to = join(ws.root, dest);
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
    }
  }
  const current = brandFile("brand.yaml", ws);
  if (current.trim()) brandFiles.push({ file: "brand.yaml", content: patchYaml(current, { funnelMix: preset.funnelMix, "cta.primary": preset.primaryCta }) });
  return saveBrandFiles(brandFiles, `Brand Kit set up from the ${preset.name.toLowerCase()} preset`, ws);
}

// ───────────────────────────── Config edits ─────────────────────────────

const NORTH_STARS = ["leads_per_week", "follows_per_post", "booked_calls_per_week", "skip_rate", "revenue_per_week"];

/** The config paths the wizard may set, each checked here before Settings' safe writer edits the file. */
export function checkWizardEdit(path: string, value: unknown): ConfigEdit {
  const p = path.split(".");
  const fail = (msg: string): never => {
    throw new Error(msg);
  };
  if (p[0] === "agents" && p.length === 3 && (AGENT_KEYS as readonly string[]).includes(p[1]!) && p[2] === "autonomy") {
    if (!(AUTONOMY_LEVELS as readonly string[]).includes(String(value))) fail("Unknown autonomy level.");
    return { path: p, value: String(value) };
  }
  switch (path) {
    case "mode":
      if (value !== "copilot" && value !== "autopilot") fail("Mode is copilot or autopilot.");
      return { path: p, value: value as string };
    case "quietHours.start":
    case "quietHours.end":
      if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) fail("Use a time like 21:00.");
      return { path: p, value: value as string };
    case "workspace.preset":
      if (typeof value !== "string" || !/^[a-z0-9-]{2,40}$/.test(value)) fail("Unknown preset.");
      return { path: p, value: value as string };
    case "workspace.name":
      if (typeof value !== "string" || !value.trim() || value.length > 80 || /[\r\n]/.test(value)) fail("The name must be 1 to 80 characters on one line.");
      return { path: p, value: (value as string).trim() };
    case "workspace.timezone":
      if (typeof value !== "string" || !isTimezone(value)) fail("Use a timezone like America/Chicago.");
      return { path: p, value: value as string };
    case "northStar.metric":
      if (!NORTH_STARS.includes(String(value))) fail("Unknown goal.");
      return { path: p, value: String(value) };
    case "acknowledgements.scrapingTerms":
    case "modules.editing.enabled":
    case "modules.research.enabled":
    case "modules.knowledge.enabled":
      if (typeof value !== "boolean") fail("Expected on or off.");
      return { path: p, value: value as boolean };
    case "modules.editing.settings.defaultFormat":
      if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{1,47}$/.test(value)) fail("Unknown format.");
      return { path: p, value: value as string };
  }
  return fail(`Setup doesn't change "${path}".`);
}

export async function editConfig(edits: { path: string; value: unknown }[], ws: StudioWorkspace = workspace()): Promise<void> {
  const clean = edits.map((e) => checkWizardEdit(e.path, e.value));
  if (!clean.length) return;
  const res = await applyConfigEdits(ws.root, clean);
  if (!res.ok) throw new Error(res.error);
}

// ───────────────────────────── Checks for the welcome step ─────────────────────────────

export type SystemCheck = { id: "claude" | "database" | "worker"; ok: boolean; label: string; detail?: string; fix?: string; command?: string };

function run(bin: string, args: string[], extraEnv: Record<string, string> = {}, timeoutMs = 10_000): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((done) =>
    execFile(bin, args, { timeout: timeoutMs, env: { ...process.env, ...extraEnv, NO_COLOR: "1" } }, (err, stdout) => done({ ok: !err, stdout: String(stdout ?? "") })),
  );
}

/** The Docker stack (the default install) runs Claude Code inside the container; signing in happens through `./aos`. */
export function inDocker(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ATTENTIONOS_IN_DOCKER === "1" || existsSync("/.dockerenv");
}

/** Same checks as `attentionos doctor` for Claude Code: installed, then signed in (`claude auth status`). */
export async function claudeCheck(ws: StudioWorkspace = workspace()): Promise<SystemCheck> {
  const bin = ws.config.runner.claudeBin ?? readEnvFile(ws.root).CLAUDE_BIN ?? "claude";
  if (ws.config.runner.engine === "api") {
    const key = process.env.ANTHROPIC_API_KEY || readEnvFile(ws.root).ANTHROPIC_API_KEY;
    return key
      ? { id: "claude", ok: true, label: "AI runs on your Anthropic API key", detail: "billed per use, capped by your budgets" }
      : { id: "claude", ok: false, label: "The API engine needs an Anthropic API key", fix: "Add ANTHROPIC_API_KEY in Settings, or switch the engine back to Claude Code." };
  }
  const docker = inDocker();
  const dockerFix = { fix: "Open Terminal and run this, then approve in the browser with your Claude account (Pro or Max). It saves the sign-in and restarts AttentionOS. On Linux the folder is /opt/attentionos.", command: "cd ~/AttentionOS && ./aos claude-login" };
  const version = await run(bin, ["--version"]);
  if (!version.ok) {
    return docker
      ? { id: "claude", ok: false, label: "Claude Code isn't available in AttentionOS yet", ...dockerFix }
      : { id: "claude", ok: false, label: "Claude Code isn't installed on this computer", fix: "Install it, then sign in once:", command: "npm install -g @anthropic-ai/claude-code && claude" };
  }
  // A server signs in with a long-lived token (`claude setup-token`) kept in the workspace .env, like the runner uses.
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN || readEnvFile(ws.root).CLAUDE_CODE_OAUTH_TOKEN;
  const auth = await run(bin, ["auth", "status"], token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {});
  let loggedIn = false;
  try {
    loggedIn = Boolean((JSON.parse(auth.stdout) as { loggedIn?: boolean }).loggedIn);
  } catch {
    loggedIn = false;
  }
  return loggedIn
    ? { id: "claude", ok: true, label: "Claude Code is signed in", detail: `your agents run on your Claude plan (${version.stdout.trim().split(" ")[0]})` }
    : docker
      ? { id: "claude", ok: false, label: "Claude Code isn't signed in", ...dockerFix }
      : { id: "claude", ok: false, label: "Claude Code isn't signed in", fix: "Open Terminal, run this once and sign in with your Claude account:", command: "claude" };
}

export async function systemChecks(ws: StudioWorkspace = workspace()): Promise<SystemCheck[]> {
  const db = await ws.sql`select 1`.then(
    () => ({ id: "database" as const, ok: true, label: "Database is connected" }),
    () => ({ id: "database" as const, ok: false, label: "Can't reach the database", fix: "Check that Postgres is running, then reload this page." }),
  );
  const [claude, worker] = await Promise.all([
    claudeCheck(ws),
    workerState(ws).then(
      (w): SystemCheck =>
        w.online
          ? { id: "worker", ok: true, label: "Your team's worker is online", detail: w.running ? `${w.running} task${w.running === 1 ? "" : "s"} running` : "ready for work" }
          : { id: "worker", ok: false, label: "Your team's worker isn't running", fix: "Start Studio with the worker so agents can work while you set up:", command: "cd ~/AttentionOS && ./aos start" },
      (): SystemCheck => ({ id: "worker", ok: false, label: "Couldn't check the worker" }),
    ),
  ]);
  return [claude, db, worker];
}

// ───────────────────────────── Connections ─────────────────────────────

export type ConnectionId = "zernio" | "apify" | "telegram";
export type ConnectionResult = { ok: boolean; detail: string; accounts?: ConnectedAccount[] };

const ZERNIO_PLATFORMS: Record<string, ConnectedAccount["platform"]> = {
  instagram: "instagram", tiktok: "tiktok", youtube: "youtube", facebook: "facebook", linkedin: "linkedin", twitter: "x", x: "x", threads: "threads",
};

/** Zernio's account list in AttentionOS terms (same mapping as the publish-zernio provider). */
export function mapZernioAccounts(body: unknown): ConnectedAccount[] {
  const list = (body as { accounts?: unknown[] } | null)?.accounts ?? [];
  const out: ConnectedAccount[] = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const a = (raw ?? {}) as { platform?: unknown; username?: unknown; displayName?: unknown; _id?: unknown; isActive?: unknown; enabled?: unknown; needsReconnection?: unknown };
    const platform = typeof a.platform === "string" ? ZERNIO_PLATFORMS[a.platform] : undefined;
    if (!platform) continue;
    const handle = String(a.username ?? a.displayName ?? a._id ?? "").replace(/^@/, "").slice(0, 120);
    const status: ConnectedAccount["status"] = a.needsReconnection ? "expired" : a.isActive === false || a.enabled === false ? "error" : "connected";
    out.push({ platform, handle, status });
  }
  return out.slice(0, 40);
}

function secret(ws: StudioWorkspace, name: string): string | undefined {
  return process.env[name] || readEnvFile(ws.root)[name] || undefined;
}

async function getJson(url: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(12_000) });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

/** Every account the key can see. No page/limit: Zernio rejects a request that sends only one of the two. */
export function zernioAccountsUrl(profileId?: string): string {
  const url = new URL("https://zernio.com/api/v1/accounts");
  if (profileId) url.searchParams.set("profileId", profileId);
  return url.toString();
}

/** Light, read-only checks with the key saved in .env (the same endpoints the providers' health checks use). */
export async function checkConnection(id: ConnectionId, ws: StudioWorkspace = workspace()): Promise<ConnectionResult> {
  try {
    if (id === "zernio") {
      // The same read-only call as the provider's health check (GET /accounts), so the accounts can be listed too.
      const key = secret(ws, "ZERNIO_API_KEY");
      if (!key) return { ok: false, detail: "Paste your Zernio API key first." };
      const profile = secret(ws, "ZERNIO_PROFILE_ID");
      const r = await getJson(zernioAccountsUrl(profile), {
        headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      });
      if (r.status === 401 || r.status === 403) return { ok: false, detail: "Zernio didn't accept that key. Copy it again from the Zernio dashboard." };
      if (r.status >= 400) return { ok: false, detail: `Zernio answered with an error (${r.status}). Try again in a minute.` };
      const accounts = mapZernioAccounts(r.body);
      const broken = accounts.filter((a) => a.status !== "connected");
      return accounts.length
        ? {
            ok: true,
            accounts,
            detail: `Connected. ${accounts.length} social account${accounts.length === 1 ? "" : "s"} in Zernio${broken.length ? `; ${broken.length} need${broken.length === 1 ? "s" : ""} reconnecting there` : ""}.`,
          }
        : { ok: true, accounts, detail: "The key works. Connect your social accounts inside Zernio next, then press Refresh." };
    }
    if (id === "apify") {
      const token = secret(ws, "APIFY_TOKEN");
      if (!token) return { ok: false, detail: "Paste your Apify token first." };
      // The same call as the provider's health check (GET /v2/users/me). Free; never starts a scrape.
      const r = await getJson("https://api.apify.com/v2/users/me", { headers: { authorization: `Bearer ${token}` } });
      if (r.status === 401 || r.status === 403) return { ok: false, detail: "Apify didn't accept that token. Copy it again from Apify → Settings → API & Integrations." };
      if (r.status >= 400) return { ok: false, detail: `Apify answered with an error (${r.status}).` };
      const name = (r.body as { data?: { username?: string } } | null)?.data?.username;
      return { ok: true, detail: `Connected to Apify${name ? ` as ${name}` : ""}.` };
    }
    const token = secret(ws, "TELEGRAM_BOT_TOKEN");
    if (!token) return { ok: false, detail: "Paste your bot token first." };
    const me = await getJson(`https://api.telegram.org/bot${encodeURIComponent(token)}/getMe`);
    if (me.status === 401 || me.status === 404) return { ok: false, detail: "Telegram didn't accept that token. Copy it again from @BotFather." };
    const username = (me.body as { result?: { username?: string } } | null)?.result?.username;
    let chat = secret(ws, "TELEGRAM_CHAT_ID");
    if (!chat) {
      // Not confirmed (no offset), so the worker's own polling still sees these messages.
      const up = await getJson(`https://api.telegram.org/bot${encodeURIComponent(token)}/getUpdates?limit=20&allowed_updates=%5B%22message%22%5D`);
      const results = ((up.body as { result?: { message?: { chat?: { id?: number; type?: string } } }[] } | null)?.result ?? []).map((u) => u.message?.chat).filter(Boolean);
      const pick = results.find((c) => c?.type === "private") ?? results[0];
      if (!pick?.id) return { ok: false, detail: `Connected as @${username ?? "your bot"}. Now open the bot in Telegram, press Start, then check again.` };
      chat = String(pick.id);
      writeEnvKey(ws.root, "TELEGRAM_CHAT_ID", chat);
    }
    return { ok: true, detail: `Connected as @${username ?? "your bot"}. Messages go to your chat.` };
  } catch (err) {
    return { ok: false, detail: `Couldn't reach the service (${err instanceof Error ? err.message : String(err)}). Check your internet connection.` };
  }
}

export async function sendTelegramTest(ws: StudioWorkspace = workspace()): Promise<ConnectionResult> {
  const token = secret(ws, "TELEGRAM_BOT_TOKEN");
  const chat = secret(ws, "TELEGRAM_CHAT_ID");
  if (!token || !chat) return { ok: false, detail: "Check the connection first so Studio can find your chat." };
  try {
    const r = await getJson(`https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: "AttentionOS is connected. Your morning brief, approvals and alerts will arrive here." }),
    });
    return r.status < 300 ? { ok: true, detail: "Sent. Check Telegram for the test message." } : { ok: false, detail: "Telegram refused the message. Open the bot and press Start, then try again." };
  } catch {
    return { ok: false, detail: "Couldn't reach Telegram. Check your internet connection." };
  }
}

export function keySet(name: string, ws: StudioWorkspace = workspace()): boolean {
  return Boolean(secret(ws, name));
}


// ───────────────────────────── The start board ─────────────────────────────

/** Jobs the Start step queues (and the ones they hand off to), shown as rows on the live board. */
export const BOARD_JOBS = {
  site: "onboarding.analyze-site",
  import: "onboarding.import-own-posts",
  ownSync: "research.own-sync",
  scan: "research.competitor-scan",
  transcribe: "editing.transcribe",
  voice: "onboarding.voice-profile",
  index: "knowledge.index-workspace",
} as const;
export type BoardJob = keyof typeof BOARD_JOBS;

export type BoardRun = RunInfo & { output: Record<string, unknown> | null; createdAt: string };

export type StartBoard = {
  own: { posts: number; byPlatform: Record<string, number>; transcribed: number; transcribing: number; noTranscript: number };
  competitors: { posts: number; creatorsScanned: number; outliers: number; outlierCreators: number; transcribed: number };
  runs: Partial<Record<BoardJob, BoardRun>>;
  /** Transcription runs since the start: how many failed, and the first reason (e.g. the speech model is missing). */
  transcription: { runs: number; failed: number; firstError: string | null };
  events: { id: string; agent: string; message: string; at: string }[];
};

const int = (v: unknown) => Number(v ?? 0) || 0;

/** Everything the Start step's live board shows, read straight from the database (counts never come from the model). */
export async function startBoard(since: string | undefined, ws: StudioWorkspace = workspace()): Promise<StartBoard> {
  const from = since ? new Date(since) : new Date(Date.now() - 86_400_000);
  const [own] = await ws.sql<Record<string, unknown>[]>`
    select count(*)::int as posts,
           count(*) filter (where p.transcript_status = 'done')::int as transcribed,
           count(*) filter (where p.transcript_status = 'queued')::int as transcribing,
           count(*) filter (where p.transcript_status in ('failed', 'unavailable'))::int as no_transcript
      from external_posts p join tracked_creators c on c.id = p.tracked_creator_id
     where p.workspace_id = ${ws.id} and c.tier = 'own'`;
  const byPlatform = await ws.sql<{ platform: string; n: number }[]>`
    select p.platform, count(*)::int as n from external_posts p join tracked_creators c on c.id = p.tracked_creator_id
     where p.workspace_id = ${ws.id} and c.tier = 'own' group by p.platform`;
  const [comp] = await ws.sql<Record<string, unknown>[]>`
    select count(p.id)::int as posts,
           count(distinct c.id) filter (where c.last_scanned_at is not null)::int as scanned,
           count(p.id) filter (where p.is_outlier)::int as outliers,
           count(distinct c.id) filter (where p.is_outlier)::int as outlier_creators,
           count(p.id) filter (where p.transcript_status = 'done')::int as transcribed
      from tracked_creators c left join external_posts p on p.tracked_creator_id = c.id and p.workspace_id = ${ws.id}
     where c.workspace_id = ${ws.id} and c.tier <> 'own' and c.active`;
  const runs = await ws.sql<{ id: string; job_id: string; status: RunInfo["status"]; error: string | null; output: unknown; created_at: Date; progress: string | null }[]>`
    select distinct on (r.job_id) r.id, r.job_id, r.status, r.error, r.output, r.created_at,
           (select e.message from agent_events e where e.workspace_id = r.workspace_id and e.run_id = r.id and e.kind = 'progress' order by e.id desc limit 1) as progress
      from agent_runs r
     where r.workspace_id = ${ws.id} and r.job_id = any(${Object.values(BOARD_JOBS).filter((j) => j !== BOARD_JOBS.transcribe)}) and r.created_at >= ${from}
     order by r.job_id, r.created_at desc`;
  const [tx] = await ws.sql<{ runs: number; failed: number; first_error: string | null }[]>`
    select count(*)::int as runs,
           count(*) filter (where status = 'failed' or (status = 'succeeded' and output->>'error' is not null))::int as failed,
           (array_agg(coalesce(error, output->>'error') order by created_at) filter (where error is not null or output->>'error' is not null))[1] as first_error
      from agent_runs where workspace_id = ${ws.id} and job_id = ${BOARD_JOBS.transcribe} and created_at >= ${from}`;
  const events = await ws.sql<{ id: string; agent: string; message: string; ts: Date }[]>`
    select id::text, agent, message, ts from agent_events
     where workspace_id = ${ws.id} and ts >= ${from} and kind in ('progress', 'handoff') and agent <> ${ACTOR}
     order by id desc limit 8`;
  const byJob = Object.fromEntries(Object.entries(BOARD_JOBS).map(([k, id]) => [id, k])) as Record<string, BoardJob>;
  return {
    own: {
      posts: int(own?.posts),
      byPlatform: Object.fromEntries(byPlatform.map((r) => [r.platform, r.n])),
      transcribed: int(own?.transcribed),
      transcribing: int(own?.transcribing),
      noTranscript: int(own?.no_transcript),
    },
    competitors: { posts: int(comp?.posts), creatorsScanned: int(comp?.scanned), outliers: int(comp?.outliers), outlierCreators: int(comp?.outlier_creators), transcribed: int(comp?.transcribed) },
    runs: Object.fromEntries(
      runs.map((r) => [
        byJob[r.job_id],
        { id: r.id, status: r.status, error: r.error, progress: r.progress, output: r.output && typeof r.output === "object" ? (r.output as Record<string, unknown>) : null, createdAt: r.created_at.toISOString() },
      ]),
    ),
    transcription: { runs: int(tx?.runs), failed: int(tx?.failed), firstError: tx?.first_error ?? null },
    events: events.map((e) => ({ id: e.id, agent: e.agent, message: e.message, at: e.ts.toISOString() })),
  };
}
