import { config } from "@vot.js/shared";
import * as meriyah from "meriyah";
import { createAbortableDelay } from "../../utils/abort";
import debug from "../../utils/debug";
import {
  getYoutubeAudioFormatLanguage as getAudioFormatLanguage,
  normalizeAudioLanguageTag as normalizeAudioLanguage,
  selectSmallestAudioFormat,
} from "../utils";
import { type AudioChunk, concatBuffers } from "./audioChunks";
import { preprocessYouTubePlayer } from "./ytPlayerSolver.js";

const MEDIA_RANGE_SIZES = [60_000, 80_000, 150_000, 330_000, 460_000];

type YouTubeConfig = {
  data_?: Record<string, unknown>;
  get?: (key: string) => unknown;
};

type WebAbrWindow = Window & {
  ytcfg?: YouTubeConfig;
  _yt_player?: Record<string, unknown>;
};

type PageUrlInstance = {
  set?: (key: string, value: string) => void;
  get?: (key: string) => string | null;
  [key: string]: unknown;
};

type PageUrlClass = new (...args: unknown[]) => PageUrlInstance;

type WebEmbeddedFormat = {
  itag?: number;
  url?: string;
  mimeType?: string;
  bitrate?: number;
  averageBitrate?: number;
  contentLength?: string | number;
  lastModified?: string;
  signatureCipher?: string;
  audioQuality?: string;
  language?: string;
  languageCode?: string;
  audioTrackId?: string;
  audioSampleRate?: string;
  audioChannels?: number;
  displayName?: string;
  xtags?: string;
  audioTrack?: {
    id?: string;
    languageCode?: string;
    language?: string;
    displayName?: string;
    audioIsDefault?: boolean;
  };
};

type WebEmbeddedPlayerResponse = {
  responseContext?: {
    mainAppWebResponseContext?: { datasyncId?: string };
  };
  playabilityStatus?: {
    status?: string;
    reason?: string;
    messages?: string[];
  };
  streamingData?: {
    adaptiveFormats?: WebEmbeddedFormat[];
    formats?: WebEmbeddedFormat[];
  };
};

type FetchedClientConfig = {
  apiKey?: string;
  clientVersion?: string;
  visitorData?: string;
  playerUrl?: string;
  signatureTimestamp?: number;
  dataSyncId?: string;
  experimentFlags?: string[];
};

async function fetchTvConfig(
  targetWindow: Window,
  signal: AbortSignal,
  videoId: string,
): Promise<FetchedClientConfig | undefined> {
  try {
    const response = await targetWindow.fetch("https://www.youtube.com/tv", {
      credentials: "omit",
      signal,
    });
    if (!response.ok) {
      throw new Error(
        `Audio downloader. tv config request failed (${response.status})`,
      );
    }
    const html = await response.text();
    const pick = (patterns: RegExp[]): string | undefined => {
      for (const pattern of patterns) {
        const match = pattern.exec(html);
        if (match?.[1]) return match[1];
      }
    };
    const playerPath = pick([/"PLAYER_JS_URL":"([^"]+)"/, /"jsUrl":"([^"]+)"/]);
    const sts = Number(pick([/"STS":(\d+)/, /"signatureTimestamp":(\d+)/]));
    const experimentFlags: string[] = [];
    for (const match of html.matchAll(
      /"serializedExperimentFlags"\s*:\s*("(?:\\.|[^"\\])*")/g,
    )) {
      try {
        experimentFlags.push(JSON.parse(match[1] ?? '""') as string);
      } catch {
        // Malformed optional flags must not discard the rest of the config.
      }
    }
    return {
      apiKey: pick([/"INNERTUBE_API_KEY":"([^"]+)"/]),
      clientVersion: pick([/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/]),
      visitorData: pick([/"VISITOR_DATA":"([^"]+)"/]),
      dataSyncId: pick([/"DATASYNC_ID":"([^"]+)"/]),
      experimentFlags,
      playerUrl: playerPath
        ? new URL(playerPath, "https://www.youtube.com").toString()
        : undefined,
      signatureTimestamp: Number.isFinite(sts) && sts > 0 ? sts : undefined,
    };
  } catch (error) {
    signal.throwIfAborted();
    debug.log("Audio downloader. client config unavailable", {
      videoId,
      client: "tv",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function buildMediaRanges(
  contentLength: number,
): { start: number; end: number }[] {
  if (!Number.isInteger(contentLength) || contentLength < 1) return [];
  const ranges: { start: number; end: number }[] = [];
  let start = 0;
  let sizeIndex = 0;
  while (start < contentLength) {
    const size = MEDIA_RANGE_SIZES[sizeIndex] ?? MEDIA_RANGE_SIZES.at(-1) ?? 1;
    const end = Math.min(contentLength - 1, start + size - 1);
    ranges.push({ start, end });
    start = end + 1;
    if (sizeIndex < MEDIA_RANGE_SIZES.length - 1) sizeIndex++;
  }
  return ranges;
}

function getPoTokenRealms(pageWindow: WebAbrWindow): Set<WebAbrWindow> {
  const realms = new Set<WebAbrWindow>([pageWindow]);
  try {
    realms.add(pageWindow.parent as WebAbrWindow);
    realms.add(pageWindow.top as WebAbrWindow);
  } catch {
    // Cross-origin access is denied.
  }
  return realms;
}

function getPoTokenMinters(realm: WebAbrWindow): Array<{
  bevasrs: { wpc: (...args: unknown[]) => unknown };
}> {
  let keys: string[];
  try {
    keys = Object.getOwnPropertyNames(realm).filter(
      (key) => key === "bevasrsg" || key.startsWith("havuokmhhs-"),
    );
  } catch {
    return [];
  }
  const minters: Array<{
    bevasrs: { wpc: (...args: unknown[]) => unknown };
  }> = [];
  for (const key of keys) {
    try {
      const bevasrs = (
        (realm as unknown as Record<string, unknown>)[key] as {
          bevasrs?: { wpc?: unknown };
        }
      )?.bevasrs;
      if (typeof bevasrs?.wpc === "function") {
        minters.push({
          bevasrs: bevasrs as {
            wpc: (...args: unknown[]) => unknown;
          },
        });
      }
    } catch {
      // A page-owned getter may throw; try the next candidate.
    }
  }
  return minters;
}

async function mintTokenWithRetry(
  bevasrs: { wpc: (...args: unknown[]) => unknown },
  binding: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  for (let attempt = 0; attempt < 10; attempt++) {
    if (signal.aborted) throw signal.reason;
    try {
      const minter = (await bevasrs.wpc.call(bevasrs)) as {
        mws?: (options: {
          c: string;
          mc: boolean;
          me: boolean;
        }) => Promise<unknown> | unknown;
      } | null;
      const token = await minter?.mws?.({
        c: binding,
        mc: false,
        me: false,
      });
      if (typeof token === "string" && token) return token;
    } catch (error) {
      if (!String(error).includes("SDF:notready")) break;
    }
    await createAbortableDelay(500, signal);
  }
}

export async function mintPagePoToken(
  pageWindow: WebAbrWindow,
  binding: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const realms = getPoTokenRealms(pageWindow);
  for (const realm of realms) {
    for (const { bevasrs } of getPoTokenMinters(realm)) {
      const token = await mintTokenWithRetry(bevasrs, binding, signal);
      if (token) return token;
    }
  }
}

function selectGvsPoTokenBinding(
  videoId: string,
  options: {
    loggedIn: boolean;
    dataSyncId: unknown;
    visitorData: unknown;
    experimentFlags: string[];
  },
): { kind: "video" | "datasync" | "visitor"; value: string } | undefined {
  if (
    options.experimentFlags.some(
      (flags) =>
        new URLSearchParams(flags)
          .getAll("html5_generate_content_po_token")
          .at(-1) === "true",
    )
  ) {
    return { kind: "video", value: videoId };
  }
  // Authenticated GVS uses the full datasync ID, including the || separator.
  const value = options.loggedIn ? options.dataSyncId : options.visitorData;
  if (typeof value !== "string" || !value) return;
  return { kind: options.loggedIn ? "datasync" : "visitor", value };
}

function getConfigValue(config: YouTubeConfig, key: string): unknown {
  return config.get?.(key) ?? config.data_?.[key];
}

function cloneInnertubeContext(
  config: YouTubeConfig,
  unavailableMessage: string,
): {
  context: {
    client?: Record<string, unknown>;
    thirdParty?: Record<string, unknown>;
  };
  client: Record<string, unknown>;
} {
  const rawContext = getConfigValue(config, "INNERTUBE_CONTEXT");
  if (!rawContext || typeof rawContext !== "object") {
    throw new Error(unavailableMessage);
  }
  const context = structuredClone(rawContext) as {
    client?: Record<string, unknown>;
    thirdParty?: Record<string, unknown>;
  };
  context.client ??= {};
  return { context, client: context.client };
}

function buildContentPlaybackContext(
  signatureTimestamp: unknown,
): Record<string, unknown> {
  const context: Record<string, unknown> = {
    html5Preference: "HTML5_PREF_WANTS",
  };
  const timestamp = Number(signatureTimestamp);
  if (Number.isFinite(timestamp) && timestamp > 0) {
    context.signatureTimestamp = timestamp;
  }
  return context;
}

function findJsonStringEnd(source: string, start: number): number {
  for (let index = start + 1; index < source.length; index++) {
    const char = source[index];
    if (char === "\\") index++;
    else if (char === '"') return index + 1;
  }
  return -1;
}

function findJsonCompositeEnd(source: string, start: number): number {
  let depth = 0;
  let cursor = start;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === '"') {
      const stringEnd = findJsonStringEnd(source, cursor);
      if (stringEnd < 0) return -1;
      cursor = stringEnd;
      continue;
    }
    if (char === "{" || char === "[") {
      depth++;
    } else if (char === "}" || char === "]") {
      depth--;
      if (depth === 0) return cursor + 1;
    }
    cursor++;
  }
  return -1;
}

function findJsonValueEnd(source: string, start: number): number {
  const first = source[start];
  if (first === '"') return findJsonStringEnd(source, start);
  if (first === "{" || first === "[") {
    return findJsonCompositeEnd(source, start);
  }
  return -1;
}

// The page keeps its config in the ytcfg global, which a sandboxed userscript
// realm cannot read. Both calling forms carry plain JSON, so the same inline
// script that builds ytcfg can be replayed from its source text instead.
function skipWhitespace(source: string, start: number): number {
  let index = start;
  while (index < source.length && /\s/.test(source[index] ?? "")) index++;
  return index;
}

function applyYtcfgSetCall(
  source: string,
  data: Record<string, unknown>,
  argumentStart: number,
): number {
  const start = skipWhitespace(source, argumentStart);
  const end = findJsonValueEnd(source, start);
  if (end < 0) return argumentStart;
  try {
    const argument = JSON.parse(source.slice(start, end)) as unknown;
    if (argument && typeof argument === "object") {
      if (!Array.isArray(argument)) Object.assign(data, argument);
      return end;
    }
    if (typeof argument !== "string") return argumentStart;

    const separator = skipWhitespace(source, end);
    if (source[separator] !== ",") return argumentStart;
    const valueStart = skipWhitespace(source, separator + 1);
    const jsonEnd = findJsonValueEnd(source, valueStart);
    const valueEnd = jsonEnd < 0 ? source.indexOf(")", valueStart) : jsonEnd;
    if (valueEnd < 0) return argumentStart;
    data[argument] = JSON.parse(source.slice(valueStart, valueEnd).trim());
    return valueEnd;
  } catch {
    // Calls with non-JSON arguments are page code we cannot replay.
    return argumentStart;
  }
}

function parseYtcfgData(source: string): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const pattern = /ytcfg\s*\.\s*set\s*\(/g;
  let cursor = 0;
  while (cursor <= source.length) {
    pattern.lastIndex = cursor;
    const match = pattern.exec(source);
    if (!match) break;
    const argumentStart = match.index + match[0].length;
    const parsedEnd = applyYtcfgSetCall(source, data, argumentStart);
    cursor = parsedEnd > argumentStart ? parsedEnd : argumentStart;
  }
  return data;
}

function readYtcfgFromDocument(targetWindow: Window): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  let scripts: HTMLScriptElement[] = [];
  try {
    scripts = [
      ...targetWindow.document.querySelectorAll<HTMLScriptElement>(
        "script:not([src])",
      ),
    ];
  } catch {
    return data;
  }
  for (const script of scripts) {
    const source = script.textContent;
    if (!source?.includes("ytcfg")) continue;
    Object.assign(data, parseYtcfgData(source));
  }
  return data;
}

async function resolveYtcfg(
  targetWindow: WebAbrWindow,
  signal: AbortSignal,
): Promise<YouTubeConfig> {
  const pageConfig = targetWindow.ytcfg;
  if (
    pageConfig &&
    typeof getConfigValue(pageConfig, "INNERTUBE_API_KEY") === "string"
  ) {
    return pageConfig;
  }
  // A sandboxed userscript realm (Tampermonkey with any @grant) sees its own
  // globals, so recover the config from the page markup instead.
  let data = readYtcfgFromDocument(targetWindow);
  let source = "document";
  if (typeof data.INNERTUBE_API_KEY !== "string") {
    try {
      const response = await targetWindow.fetch(targetWindow.location.href, {
        credentials: "include",
        signal,
      });
      if (response.ok) {
        data = parseYtcfgData(await response.text());
        source = "page";
      }
    } catch (error) {
      signal.throwIfAborted();
      debug.log("Audio downloader. web ABR config request failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (typeof data.INNERTUBE_API_KEY !== "string") {
    throw new TypeError("Audio downloader. web ABR config is unavailable");
  }
  debug.log("Audio downloader. web ABR config recovered", {
    source,
    hasContext: Boolean(data.INNERTUBE_CONTEXT),
    loggedIn: data.LOGGED_IN === true,
  });
  return { data_: data };
}

export function buildWebEmbeddedPlayerRequest(
  config: YouTubeConfig,
  videoId: string,
  extractedSignatureTimestamp?: number,
): Record<string, unknown> {
  const { context, client } = cloneInnertubeContext(
    config,
    "Audio downloader. web_embedded context is unavailable",
  );
  client.clientName = "WEB_EMBEDDED_PLAYER";
  client.clientVersion =
    getConfigValue(config, "INNERTUBE_CLIENT_VERSION") ?? client.clientVersion;
  client.originalUrl = `https://www.youtube.com/embed/${videoId}?html5=1`;
  context.thirdParty ??= {};
  context.thirdParty.embedUrl = "https://www.reddit.com/";

  const contentPlaybackContext = buildContentPlaybackContext(
    extractedSignatureTimestamp ?? getConfigValue(config, "STS"),
  );
  const playerContexts = getConfigValue(config, "WEB_PLAYER_CONTEXT_CONFIGS") as
    | {
        WEB_PLAYER_CONTEXT_CONFIG_ID_EMBEDDED_PLAYER?: {
          encryptedHostFlags?: unknown;
        };
      }
    | undefined;
  const encryptedHostFlags =
    playerContexts?.WEB_PLAYER_CONTEXT_CONFIG_ID_EMBEDDED_PLAYER
      ?.encryptedHostFlags;
  if (typeof encryptedHostFlags === "string" && encryptedHostFlags) {
    contentPlaybackContext.encryptedHostFlags = encryptedHostFlags;
  }

  return {
    context,
    videoId,
    playbackContext: { contentPlaybackContext },
    contentCheckOk: true,
    racyCheckOk: true,
  };
}

function audioLanguageMatches(
  trackLanguage: string,
  requestedLanguage: string,
): boolean {
  const track = normalizeAudioLanguage(trackLanguage);
  const requested = normalizeAudioLanguage(requestedLanguage);
  if (!track || !requested || requested === "auto") return false;
  if (track === requested) return true;
  return track.split("-")[0] === requested.split("-")[0];
}

function isDrcAudioFormat(format: WebEmbeddedFormat): boolean {
  if (typeof format.xtags === "string" && format.xtags.includes("drc=1")) {
    return true;
  }
  try {
    const cipher =
      typeof format.signatureCipher === "string"
        ? new URLSearchParams(format.signatureCipher)
        : undefined;
    const rawUrl = format.url ?? cipher?.get("url");
    const xtags = rawUrl ? new URL(rawUrl).searchParams.get("xtags") : null;
    return xtags?.includes("drc=1") === true;
  } catch {
    return false;
  }
}

export function selectWebEmbeddedAudioFormat(
  formats: WebEmbeddedFormat[],
  requestedLanguage?: string,
): WebEmbeddedFormat {
  const withUrl = formats.filter(
    ({ url, signatureCipher }) =>
      typeof url === "string" || typeof signatureCipher === "string",
  );
  const audioOnly = withUrl.filter(
    ({ mimeType }) =>
      mimeType?.includes("audio/") && !mimeType?.includes("video/"),
  );

  // If VOT explicitly selected a source language, prefer that YouTube audio
  // track. BCP-47 variants are matched by exact tag first, then base language.
  const normalizedRequestedLanguage = normalizeAudioLanguage(requestedLanguage);
  const exactLanguageCandidates =
    normalizedRequestedLanguage && normalizedRequestedLanguage !== "auto"
      ? audioOnly.filter(
          (format) =>
            getAudioFormatLanguage(format) === normalizedRequestedLanguage,
        )
      : [];
  let requestedLanguageCandidates = exactLanguageCandidates;
  if (
    requestedLanguageCandidates.length === 0 &&
    normalizedRequestedLanguage &&
    normalizedRequestedLanguage !== "auto"
  ) {
    requestedLanguageCandidates = audioOnly.filter((format) =>
      audioLanguageMatches(
        getAudioFormatLanguage(format),
        normalizedRequestedLanguage,
      ),
    );
  }

  const defaultAudioOnly = audioOnly.filter(
    ({ audioTrack }) => audioTrack?.audioIsDefault === true,
  );
  let trackCandidates = audioOnly;
  if (defaultAudioOnly.length > 0) trackCandidates = defaultAudioOnly;
  if (requestedLanguageCandidates.length > 0) {
    trackCandidates = requestedLanguageCandidates;
  }
  const nonDrcCandidates = trackCandidates.filter(
    (format) => !isDrcAudioFormat(format),
  );
  const selected = selectSmallestAudioFormat(
    nonDrcCandidates.length > 0 ? nonDrcCandidates : trackCandidates,
  );

  if (!selected) {
    throw new Error(
      "Audio downloader. web ABR returned no direct audio-only formats",
    );
  }

  return selected;
}

// YouTube's SAPISIDHASH authorization format specifies this SHA-1 digest.
// A different digest would make authenticated Innertube requests incompatible.
async function sha1(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function buildSidAuthorization(
  scheme: string,
  sid: string,
  origin: string,
  timestamp: string,
  userSessionId?: string,
): Promise<string> {
  const hash = await sha1(
    userSessionId
      ? `${userSessionId} ${timestamp} ${sid} ${origin}`
      : `${timestamp} ${sid} ${origin}`,
  );
  return `${scheme} ${timestamp}_${hash}${userSessionId ? "_u" : ""}`;
}

async function getYouTubeAuthorization(
  targetWindow: Window,
  userSessionId?: string,
): Promise<string | undefined> {
  const cookies = new Map(
    targetWindow.document.cookie.split("; ").map((cookie) => {
      const separator = cookie.indexOf("=");
      return separator < 0
        ? [cookie, ""]
        : [cookie.slice(0, separator), cookie.slice(separator + 1)];
    }),
  );
  const timestamp = String(Math.round(Date.now() / 1000));
  const origin = "https://www.youtube.com";
  const authorizations = await Promise.all(
    [
      [
        "SAPISIDHASH",
        cookies.get("SAPISID") ?? cookies.get("__Secure-3PAPISID"),
      ],
      ["SAPISID1PHASH", cookies.get("__Secure-1PAPISID")],
      ["SAPISID3PHASH", cookies.get("__Secure-3PAPISID")],
    ].map(async ([scheme, sid]) =>
      sid
        ? buildSidAuthorization(
            scheme,
            sid,
            origin,
            timestamp,
            userSessionId || undefined,
          )
        : "",
    ),
  );
  return authorizations.filter(Boolean).join(" ") || undefined;
}

function getPlayerUrl(config: YouTubeConfig): string | undefined {
  const playerContexts = getConfigValue(config, "WEB_PLAYER_CONTEXT_CONFIGS") as
    | {
        WEB_PLAYER_CONTEXT_CONFIG_ID_EMBEDDED_PLAYER?: { jsUrl?: unknown };
      }
    | undefined;
  const value =
    getConfigValue(config, "PLAYER_JS_URL") ??
    getConfigValue(config, "JS_URL") ??
    playerContexts?.WEB_PLAYER_CONTEXT_CONFIG_ID_EMBEDDED_PLAYER?.jsUrl;
  return typeof value === "string"
    ? new URL(value, "https://www.youtube.com").toString()
    : undefined;
}

type TrustedTypePolicyFactory = {
  createPolicy: (
    name: string,
    rules: { createScript: (value: string) => string },
  ) => { createScript: (value: string) => unknown };
};

// A sandboxed or proxied global can lack trustedTypes while its Function is
// still Trusted Types-checked. The policy and the Function sink must live in
// the same realm, so probe same-origin ancestors for the policy factory.
function resolveTrustedRealm(realm: Window): Window {
  const candidates: Window[] = [realm];
  const add = (candidate: Window | null | undefined): void => {
    if (candidate && candidate !== realm) candidates.push(candidate);
  };
  try {
    add(realm.parent as Window | null);
  } catch {
    // Cross-origin access is denied.
  }
  try {
    add(realm.top as Window | null);
  } catch {
    // Cross-origin access is denied.
  }
  for (const candidate of candidates) {
    try {
      if (
        (candidate as unknown as { trustedTypes?: TrustedTypePolicyFactory })
          .trustedTypes?.createPolicy
      ) {
        return candidate;
      }
    } catch {
      // Cross-origin access is denied.
    }
  }
  return realm;
}

function runChallengeSolver(
  realm: Window,
  preparedPlayer: string,
  signature?: string,
  n?: string,
): { signature?: string; n?: string } {
  const nativeRealm = resolveTrustedRealm(realm);
  const trustedTypes = (
    nativeRealm as unknown as { trustedTypes?: TrustedTypePolicyFactory }
  ).trustedTypes;
  const policy = trustedTypes?.createPolicy(
    `vot-youtube-solver-${crypto.randomUUID()}`,
    {
      createScript: (value) => value,
    },
  );
  // Chrome's Function constructor rejects TrustedScript arguments
  // (crbug.com/1087743), so evaluate through eval, which accepts
  // TrustedScript. The IIFE keeps the player locals out of the page too, and
  // handing its result back as the completion value keeps the solver working
  // when eval runs in another realm than the caller (a sandboxed userscript).
  const source = `(function(){\nconst _result={sig:null,n:null};\n${preparedPlayer}\nreturn _result;\n})()`;
  const script = policy?.createScript(source) ?? source;
  const result = (
    nativeRealm as unknown as { eval: (value: unknown) => unknown }
  ).eval(script) as {
    sig?: ((value: string) => string) | null;
    n?: ((value: string) => string) | null;
  } | null;
  if (!result) {
    throw new Error("Audio downloader. YouTube challenge solver returned none");
  }
  const solved = {
    signature: signature && result.sig ? result.sig(signature) : undefined,
    n: n && result.n ? result.n(n) : undefined,
  };
  if ((signature && !solved.signature) || (n && !solved.n)) {
    throw new Error("Audio downloader. YouTube challenge solve incomplete");
  }
  return solved;
}

const SIG_PATTERN = /^[A-Za-z0-9_-]{20,}={0,2}$/;
const N_PATTERN = /^[A-Za-z0-9_-]{4,}$/;

// Only reachable functions can be reused. IIFE-local factories need the AST solver.
function listPageFunctions(pageWindow: WebAbrWindow): SigFactory[] {
  const found: SigFactory[] = [];
  const seen = new Set<unknown>();
  let visited = 0;
  const visit = (value: unknown, path: string, depth: number): void => {
    if (!value || seen.has(value) || depth > 3 || visited++ >= 5000) return;
    seen.add(value);
    if (typeof value === "function") {
      found.push({ fn: value as SigFactory["fn"], path });
    } else if (typeof value === "object") {
      try {
        for (const [key, descriptor] of Object.entries(
          Object.getOwnPropertyDescriptors(value),
        )) {
          if ("value" in descriptor) {
            visit(descriptor.value, `${path}.${key}`, depth + 1);
          }
        }
      } catch {
        // Inaccessible objects are not candidates.
      }
    }
  };
  try {
    const descriptors = Object.getOwnPropertyDescriptors(pageWindow);
    visit(descriptors._yt_player?.value, "_yt_player", 0);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (typeof descriptor.value === "function")
        visit(descriptor.value, key, 0);
    }
  } catch {
    // Cross-origin access is denied.
  }
  return found;
}

// Media URL builders may set alr too; require the decipher factory's URL wiring.
const EJS_MOCK_URL = "https://youtube.com/watch?v=yt-dlp-wins";

type SigFactory = {
  fn: (url: string, sp: string, s: string) => PageUrlInstance;
  path: string;
};

type DynamicAstNode = {
  type?: string;
  [key: string]: any;
};

function getFunctionStatements(source: string): DynamicAstNode[] | undefined {
  if (
    !source.includes(".set") ||
    !source.includes("alr") ||
    !source.includes("yes")
  ) {
    return;
  }
  try {
    const program = meriyah.parse(`(${source})`) as unknown as DynamicAstNode;
    const body = program.body?.[0]?.expression?.body?.body;
    if (Array.isArray(body)) return body;
  } catch {
    // Method shorthand needs an object-literal parse context.
  }

  try {
    const program = meriyah.parse(`({${source}})`) as unknown as DynamicAstNode;
    const body =
      program.body?.[0]?.expression?.properties?.[0]?.value?.body?.body;
    return Array.isArray(body) ? body : undefined;
  } catch {
    return undefined;
  }
}

function getIdentifierName(
  node: DynamicAstNode | undefined,
): string | undefined {
  return node?.type === "Identifier" ? node.name : undefined;
}

function isTrueExpression(node: DynamicAstNode | undefined): boolean {
  if (node?.type === "Literal") return node.value === true;
  return (
    node?.type === "UnaryExpression" &&
    node.operator === "!" &&
    node.argument?.type === "Literal" &&
    node.argument.value === 0
  );
}

function getFactoryVariableName(
  node: DynamicAstNode | undefined,
): string | undefined {
  const expression = node?.expression;
  if (
    expression?.type !== "AssignmentExpression" ||
    expression.operator !== "="
  ) {
    return;
  }

  const variableName = getIdentifierName(expression.left);
  const constructorExpression = expression.right;
  const callee = constructorExpression?.callee;
  if (
    !variableName ||
    constructorExpression?.type !== "NewExpression" ||
    callee?.type !== "MemberExpression" ||
    callee.computed ||
    !getIdentifierName(callee.object) ||
    !getIdentifierName(callee.property)
  ) {
    return;
  }

  const args = constructorExpression.arguments;
  if (
    !Array.isArray(args) ||
    args.length !== 2 ||
    getIdentifierName(args[0]) !== variableName ||
    !isTrueExpression(args[1])
  ) {
    return;
  }
  return variableName;
}

function isAlrMarkerCall(
  node: DynamicAstNode | undefined,
  variableName: string,
): boolean {
  const expression = node?.expression;
  const callee = expression?.callee;
  const args = expression?.arguments;
  return (
    expression?.type === "CallExpression" &&
    callee?.type === "MemberExpression" &&
    !callee.computed &&
    getIdentifierName(callee.object) === variableName &&
    getIdentifierName(callee.property) === "set" &&
    Array.isArray(args) &&
    args.length === 2 &&
    args[0]?.type === "Literal" &&
    args[0].value === "alr" &&
    args[1]?.type === "Literal" &&
    args[1].value === "yes"
  );
}

function isSigFactory({ fn }: SigFactory): boolean {
  try {
    const statements = getFunctionStatements(
      Function.prototype.toString.call(fn),
    );
    if (!statements) return false;
    for (let index = 0; index + 1 < statements.length; index += 1) {
      const variableName = getFactoryVariableName(statements[index]);
      if (
        variableName &&
        isAlrMarkerCall(statements[index + 1], variableName)
      ) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function pageUrlMethods(proto: object | null) {
  if (!proto) return;
  const descriptors = new Map<string, PropertyDescriptor>();
  for (let current = proto; current; current = Object.getPrototypeOf(current)) {
    for (const [key, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(current),
    )) {
      if (!descriptors.has(key)) descriptors.set(key, descriptor);
    }
  }
  const get = descriptors.get("get")?.value;
  const set = descriptors.get("set")?.value;
  if (
    typeof get !== "function" ||
    typeof set !== "function" ||
    typeof descriptors.get("clone")?.value !== "function"
  ) {
    return;
  }
  const transforms = [...descriptors].flatMap(([key, descriptor]) => {
    if (["constructor", "set", "get", "clone"].includes(key)) return [];
    const method = descriptor.value;
    if (typeof method !== "function") return [];
    const source = Function.prototype.toString.call(method);
    return /\.set\(\s*["']n["']\s*,/.test(source) ||
      (/for\s*\([^)]*\bof\b[^)]*\.params\b/.test(source) &&
        /\.params\.set\(/.test(source))
      ? [method as (this: PageUrlInstance) => void]
      : [];
  });
  return { get, set, transforms };
}

type PageSolution = { signature?: string; n?: string };
type PageChallenge = PageSolution & { url: string; sp?: string };
type PageUrlMethods = NonNullable<ReturnType<typeof pageUrlMethods>>;

function validPageValue(
  value: unknown,
  input: string | undefined,
  pattern: RegExp,
): string | undefined {
  if (!input || typeof value !== "string") return;
  let decoded = value;
  for (let index = 0; index < 3 && decoded.includes("%"); index++) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      return;
    }
  }
  return decoded !== input && pattern.test(decoded) ? decoded : undefined;
}

function collectPageSolution(
  instance: PageUrlInstance,
  methods: PageUrlMethods,
  challenge: PageChallenge,
  transform: ((this: PageUrlInstance) => void) | undefined,
  factory: boolean,
  solutions: PageSolution[],
): void {
  const solution: PageSolution = {};
  const readSignature = () => {
    if (!challenge.signature) return;
    const keys = factory ? ["s"] : ["s", challenge.sp];
    for (const key of keys) {
      if (!key) continue;
      const value = validPageValue(
        methods.get.call(instance, key),
        challenge.signature,
        SIG_PATTERN,
      );
      if (value) return value;
    }
  };
  if (challenge.signature) {
    try {
      solution.signature = readSignature();
    } catch {
      // A bad signature must not discard an independently valid n.
    }
  }
  if (challenge.n && transform) {
    try {
      if (factory) methods.set.call(instance, "n", challenge.n);
      solution.n = validPageValue(
        methods.get.call(instance, "n"),
        challenge.n,
        N_PATTERN,
      );
      if (!solution.n) {
        transform.call(instance);
        solution.n = validPageValue(
          methods.get.call(instance, "n"),
          challenge.n,
          N_PATTERN,
        );
        if (!solution.signature) solution.signature = readSignature();
      }
    } catch {
      // Keep the signature even if the n transform fails.
    }
  }
  if (solution.signature || solution.n) solutions.push(solution);
}

function collectFactorySolutions(
  entry: SigFactory,
  challenge: PageChallenge,
  solutions: PageSolution[],
): void {
  const make = () =>
    entry.fn(EJS_MOCK_URL, "s", encodeURIComponent(challenge.signature ?? ""));
  const instance = make();
  if (!instance || typeof instance !== "object") return;
  const methods = pageUrlMethods(Object.getPrototypeOf(instance));
  if (!methods) return;
  collectPageSolution(
    instance,
    methods,
    challenge,
    methods.transforms[0],
    true,
    solutions,
  );
  if (!challenge.n) return;
  for (const transform of methods.transforms.slice(1)) {
    collectPageSolution(make(), methods, challenge, transform, true, solutions);
  }
}

function collectUrlConstructorSolutions(
  fn: SigFactory["fn"],
  challenge: PageChallenge,
  solutions: PageSolution[],
): void {
  if (!challenge.n) return;
  const proto = Object.getOwnPropertyDescriptor(fn, "prototype")?.value;
  const methods = pageUrlMethods(proto);
  if (!methods?.transforms.length) return;
  // Vet the interface and n fingerprint before constructing anything.
  const UrlCtor = fn as unknown as PageUrlClass;
  for (const transform of methods.transforms) {
    try {
      collectPageSolution(
        new UrlCtor(challenge.url, true),
        methods,
        challenge,
        transform,
        false,
        solutions,
      );
    } catch {
      // One failed construction does not invalidate other candidates.
    }
  }
}

function collectRealmSolutions(
  realm: WebAbrWindow,
  challenge: PageChallenge,
  seen: Set<SigFactory["fn"]>,
  solutions: PageSolution[],
): void {
  for (const entry of listPageFunctions(realm)) {
    if (seen.has(entry.fn)) continue;
    seen.add(entry.fn);
    try {
      if (isSigFactory(entry)) {
        collectFactorySolutions(entry, challenge, solutions);
      } else if (challenge.n && entry.path.startsWith("_yt_player.")) {
        collectUrlConstructorSolutions(entry.fn, challenge, solutions);
      }
    } catch {
      // Inaccessible or incompatible page functions are not solutions.
    }
  }
}

function mergePageSolutions(solutions: PageSolution[]): PageSolution[] {
  const consensus: PageSolution = {};
  for (const field of ["signature", "n"] as const) {
    const values = new Set(
      solutions.map((solution) => solution[field]).filter(Boolean),
    );
    if (values.size === 1) consensus[field] = values.values().next().value;
  }
  const merged = new Map<string, PageSolution>();
  for (const solution of solutions) {
    const candidate = {
      signature: solution.signature ?? consensus.signature,
      n: solution.n ?? consensus.n,
    };
    merged.set(JSON.stringify(candidate), candidate);
  }
  return [...merged.values()];
}

export function collectPageSolutions(
  pageWindow: WebAbrWindow,
  challenge: PageChallenge,
): PageSolution[] {
  const realms = new Set<WebAbrWindow>([pageWindow]);
  for (const relation of ["parent", "top"] as const) {
    try {
      const other = pageWindow[relation] as WebAbrWindow | null;
      if (other) realms.add(other);
    } catch {
      // Cross-origin access is denied.
    }
  }
  const seen = new Set<SigFactory["fn"]>();
  const solutions: PageSolution[] = [];
  for (const realm of realms) {
    collectRealmSolutions(realm, challenge, seen, solutions);
  }
  return mergePageSolutions(solutions);
}

function solveYouTubeChallenges(
  targetWindow: Window,
  playerCode: string,
  signature?: string,
  n?: string,
): { signature?: string; n?: string } {
  const preparedPlayer = preprocessYouTubePlayer(playerCode);
  const errors: string[] = [];
  try {
    // The embed page CSP allows unsafe-eval; its globals are all defined,
    // so the solver setup is a no-op there and Function scope keeps the
    // player code from leaking into the page.
    return runChallengeSolver(targetWindow, preparedPlayer, signature, n);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  const sandbox = targetWindow.document.createElement("iframe");
  sandbox.style.display = "none";
  sandbox.setAttribute("aria-hidden", "true");
  sandbox.setAttribute("sandbox", "allow-scripts allow-same-origin");
  (targetWindow.document.body ?? targetWindow.document.documentElement).append(
    sandbox,
  );
  try {
    const realm = sandbox.contentWindow;
    if (!realm) throw new Error("Challenge solver sandbox is unavailable");
    return runChallengeSolver(realm, preparedPlayer, signature, n);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    sandbox.remove();
  }
  throw new Error(
    `Audio downloader. YouTube challenge solve failed (${errors.join(" | ")})`,
  );
}

function buildSolvedUrl(
  rawUrl: string,
  sp: string | undefined,
  solved: { signature?: string; n?: string },
): string {
  const url = new URL(rawUrl);
  if (solved.signature)
    url.searchParams.set(sp ?? "signature", solved.signature);
  if (solved.n) url.searchParams.set("n", solved.n);
  return url.toString();
}

async function completePageCandidate(
  candidate: PageSolution,
  rawUrl: string,
  signature: string | undefined,
  n: string | undefined,
  sp: string | undefined,
  complete: (solution: PageSolution) => boolean,
  solve: (signature?: string, n?: string) => Promise<PageSolution>,
  signal: AbortSignal,
  errors: string[],
): Promise<string | undefined> {
  signal.throwIfAborted();
  let solved = candidate;
  try {
    if (!complete(candidate)) {
      const missing = await solve(
        candidate.signature ? undefined : signature,
        candidate.n ? undefined : n,
      );
      solved = {
        signature: candidate.signature ?? missing.signature,
        n: candidate.n ?? missing.n,
      };
    }
  } catch (error) {
    signal.throwIfAborted();
    errors.push(error instanceof Error ? error.message : String(error));
    return;
  }
  signal.throwIfAborted();
  return buildSolvedUrl(rawUrl, sp, solved);
}

async function solveFallbackUrl(
  rawUrl: string,
  sp: string | undefined,
  signature: string | undefined,
  n: string | undefined,
  solve: (signature?: string, n?: string) => Promise<PageSolution>,
  signal: AbortSignal,
  errors: string[],
): Promise<string> {
  try {
    const solved = await solve(signature, n);
    signal.throwIfAborted();
    return buildSolvedUrl(rawUrl, sp, solved);
  } catch (error) {
    signal.throwIfAborted();
    errors.push(error instanceof Error ? error.message : String(error));
    throw new Error(
      `Audio downloader. challenge solve failed (${errors.join(" | ")})`,
    );
  }
}

async function* resolveWebEmbeddedFormatUrl(
  targetWindow: WebAbrWindow,
  format: WebEmbeddedFormat,
  playerCode: () => Promise<string | undefined>,
  signal: AbortSignal,
): AsyncGenerator<string> {
  signal.throwIfAborted();
  const cipher = format.signatureCipher
    ? new URLSearchParams(format.signatureCipher)
    : undefined;
  const rawUrl = format.url ?? cipher?.get("url");
  if (!rawUrl) {
    throw new Error("Audio downloader. web ABR format URL is unavailable");
  }
  const url = new URL(rawUrl);
  const signature = cipher?.get("s") ?? undefined;
  const n = url.searchParams.get("n") ?? undefined;
  if (!signature && !n) {
    yield url.toString();
    signal.throwIfAborted();
    return;
  }
  const challenge = {
    url: rawUrl,
    sp: cipher?.get("sp") ?? undefined,
    signature,
    n,
  };
  const candidates = collectPageSolutions(targetWindow, challenge);
  signal.throwIfAborted();
  const complete = (solution: PageSolution) =>
    (!signature || !!solution.signature) && (!n || !!solution.n);
  candidates.sort((a, b) => Number(complete(b)) - Number(complete(a)));
  let source: Promise<string | undefined> | undefined;
  const astSolutions = new Map<string, PageSolution>();
  const solve = async (
    signature?: string,
    n?: string,
  ): Promise<PageSolution> => {
    signal.throwIfAborted();
    const key = JSON.stringify([signature, n]);
    const cached = astSolutions.get(key);
    if (cached) return cached;
    source ??= playerCode();
    const code = await source;
    signal.throwIfAborted();
    if (!code) {
      throw new Error("Audio downloader. YouTube player code is unavailable");
    }
    const raw = solveYouTubeChallenges(targetWindow, code, signature, n);
    signal.throwIfAborted();
    const solved = {
      signature: validPageValue(raw.signature, signature, SIG_PATTERN),
      n: validPageValue(raw.n, n, N_PATTERN),
    };
    if ((signature && !solved.signature) || (n && !solved.n)) {
      throw new Error("Audio downloader. YouTube challenge solve invalid");
    }
    astSolutions.set(key, solved);
    return solved;
  };
  const yielded = new Set<string>();
  const errors: string[] = [];
  for (const candidate of candidates) {
    const candidateUrl = await completePageCandidate(
      candidate,
      rawUrl,
      signature,
      n,
      challenge.sp,
      complete,
      solve,
      signal,
      errors,
    );
    if (candidateUrl && !yielded.has(candidateUrl)) {
      yielded.add(candidateUrl);
      yield candidateUrl;
    }
  }
  // Resume only after the consumer has tried downloading the page candidates.
  signal.throwIfAborted();
  const fallbackUrl = await solveFallbackUrl(
    rawUrl,
    challenge.sp,
    signature,
    n,
    solve,
    signal,
    errors,
  );
  if (!yielded.has(fallbackUrl)) yield fallbackUrl;
  signal.throwIfAborted();
}

export function buildTvDowngradedPlayerRequest(
  videoId: string,
  options: {
    visitorData?: unknown;
    signatureTimestamp?: number;
    clientVersion?: unknown;
  } = {},
): Record<string, unknown> {
  const contentPlaybackContext = buildContentPlaybackContext(
    options.signatureTimestamp,
  );
  return {
    context: {
      client: {
        clientName: "TVHTML5",
        clientVersion:
          typeof options.clientVersion === "string" && options.clientVersion
            ? options.clientVersion
            : "5.20260707",
        hl: "en",
        gl: "US",
        timeZone: "UTC",
        utcOffsetMinutes: 0,
        userAgent: "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version",
        ...(typeof options.visitorData === "string"
          ? { visitorData: options.visitorData }
          : {}),
      },
    },
    videoId,
    playbackContext: { contentPlaybackContext },
    contentCheckOk: true,
    racyCheckOk: true,
  };
}

export function buildWebPlayerRequest(
  config: YouTubeConfig,
  videoId: string,
  extractedSignatureTimestamp?: number,
): Record<string, unknown> {
  const { context, client } = cloneInnertubeContext(
    config,
    "Audio downloader. web client context is unavailable",
  );
  client.clientName = "WEB";
  client.clientVersion =
    getConfigValue(config, "INNERTUBE_CLIENT_VERSION") ?? client.clientVersion;
  client.originalUrl = `https://www.youtube.com/watch?v=${videoId}`;
  delete context.thirdParty;

  const contentPlaybackContext = buildContentPlaybackContext(
    extractedSignatureTimestamp ?? getConfigValue(config, "STS"),
  );

  return {
    context,
    videoId,
    playbackContext: { contentPlaybackContext },
    contentCheckOk: true,
    racyCheckOk: true,
  };
}

export function buildWebCreatorPlayerRequest(
  videoId: string,
  options: {
    visitorData?: unknown;
    signatureTimestamp?: number;
    clientVersion?: unknown;
  } = {},
): Record<string, unknown> {
  const contentPlaybackContext = buildContentPlaybackContext(
    options.signatureTimestamp,
  );
  return {
    context: {
      client: {
        clientName: "WEB_CREATOR",
        clientVersion:
          typeof options.clientVersion === "string" && options.clientVersion
            ? options.clientVersion
            : "1.20260708.06.00",
        hl: "en",
        gl: "US",
        timeZone: "UTC",
        utcOffsetMinutes: 0,
        ...(typeof options.visitorData === "string"
          ? { visitorData: options.visitorData }
          : {}),
      },
    },
    videoId,
    playbackContext: { contentPlaybackContext },
    contentCheckOk: true,
    racyCheckOk: true,
  };
}

async function postInnertubePlayer(
  targetWindow: Window,
  signal: AbortSignal,
  apiKey: string,
  body: Record<string, unknown>,
  clientName: string,
  clientVersion: string,
  extra: {
    authorization?: string;
    sessionIndex?: unknown;
    delegatedSessionId?: unknown;
  },
): Promise<WebEmbeddedPlayerResponse> {
  const visitorData = (body.context as { client?: { visitorData?: unknown } })
    ?.client?.visitorData;
  const authenticated = Boolean(extra.authorization);
  const response = await targetWindow.fetch(
    `https://www.youtube.com/youtubei/v1/player?prettyPrint=false&key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      credentials: authenticated ? "include" : "omit",
      signal,
      headers: {
        "content-type": "application/json",
        "x-youtube-client-name": clientName,
        "x-youtube-client-version": clientVersion,
        ...(typeof visitorData === "string"
          ? { "x-goog-visitor-id": visitorData }
          : {}),
        ...(authenticated
          ? {
              authorization: extra.authorization,
              "x-origin": "https://www.youtube.com",
              "x-youtube-bootstrap-logged-in": "true",
              ...(typeof extra.sessionIndex === "number" ||
              typeof extra.sessionIndex === "string"
                ? { "x-goog-authuser": String(extra.sessionIndex) }
                : {}),
              ...(typeof extra.delegatedSessionId === "string" &&
              extra.delegatedSessionId
                ? { "x-goog-pageid": extra.delegatedSessionId }
                : {}),
            }
          : {}),
      },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Audio downloader. player request failed (${response.status})`,
    );
  }
  return (await response.json()) as WebEmbeddedPlayerResponse;
}

async function probeContentLength(
  targetWindow: Window,
  streamUrl: string,
  signal: AbortSignal,
): Promise<number> {
  const url = new URL(streamUrl);
  url.searchParams.set("range", "0-0");
  url.searchParams.delete("ump");
  const response = await targetWindow.fetch(url, { signal });
  if (!response.ok) {
    throw new Error(
      `Audio downloader. web ABR media probe failed (${response.status})`,
    );
  }
  const total = Number(
    /\/(\d+)\s*$/.exec(response.headers.get("content-range") ?? "")?.[1],
  );
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error("Audio downloader. web ABR content length unknown");
  }
  return total;
}

type MediaRange = { start: number; end: number };
type MediaUrlState = {
  value: string;
  refreshPromise: Promise<string> | null;
  version: number;
};
type RequestNumberRef = { value: number };
type PendingState = { buffers: Uint8Array[]; size: number };
type WebAbrTransport =
  | "parallel_4"
  | "4mb"
  | "parallel_8"
  | "8mb"
  | "parallel_2"
  | "2mb"
  | "stream"
  | "original";

const WEB_ABR_TRANSPORTS: WebAbrTransport[] = [
  "parallel_4",
  "4mb",
  "parallel_8",
  "8mb",
  "parallel_2",
  "2mb",
  "stream",
  "original",
];

function makeFixedRanges(
  contentLength: number,
  chunkSize: number,
): MediaRange[] {
  const ranges: MediaRange[] = [];
  for (let start = 0; start < contentLength; start += chunkSize) {
    ranges.push({
      start,
      end: Math.min(contentLength - 1, start + chunkSize - 1),
    });
  }
  return ranges;
}

const WEB_ABR_RANGE_MAX_ATTEMPTS = 10;
const WEB_ABR_RANGE_REFRESH_EVERY_FAILURES = 2;
const WEB_ABR_RANGE_RETRY_BASE_DELAY_MS = 250;
const WEB_ABR_RANGE_RETRY_MAX_DELAY_MS = 1500;

// Permanent media HTTP statuses cannot be recovered by retrying the same signed
// URL or by cycling the transport matrix, so the outer client/strategy fallback
// must take over. 408/425/429/5xx and network errors stay retryable.
const WEB_ABR_FATAL_MEDIA_STATUSES = new Set([401, 403, 404, 410]);

class MediaHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "MediaHttpError";
  }
}

function isFatalMediaError(error: unknown): boolean {
  return (
    error instanceof MediaHttpError &&
    WEB_ABR_FATAL_MEDIA_STATUSES.has(error.status)
  );
}

async function refreshMediaUrl(
  urlState: MediaUrlState,
  refreshUrl: () => Promise<string>,
  reason: unknown = null,
): Promise<string> {
  if (urlState.refreshPromise === null) {
    const previousUrl = urlState.value;
    const previousVersion = urlState.version ?? 0;
    urlState.refreshPromise = Promise.resolve()
      .then(() => refreshUrl())
      .then((nextUrl) => {
        if (typeof nextUrl !== "string" || !nextUrl) {
          throw new Error("Audio downloader. Failed to refresh media URL");
        }
        urlState.value = nextUrl;
        urlState.version = previousVersion + 1;
        debug.log("Audio downloader. web ABR media URL refresh applied", {
          reason,
          version: urlState.version,
          urlChanged: nextUrl !== previousUrl,
        });
        return nextUrl;
      })
      .finally(() => {
        urlState.refreshPromise = null;
      });
  }
  return await urlState.refreshPromise;
}

type MediaRangeAttemptResult =
  | { type: "data"; bytes: Uint8Array; urlVersion: number }
  | { type: "redirect"; urlVersion: number; bytesLength: number };

async function requestMediaRange(
  targetWindow: Window,
  urlState: MediaUrlState,
  start: number,
  end: number,
  signal: AbortSignal,
  requestNumberRef: RequestNumberRef,
): Promise<MediaRangeAttemptResult> {
  const urlVersion = urlState.version ?? 0;
  const url = new URL(urlState.value);
  url.searchParams.set("range", `${start}-${end}`);
  url.searchParams.set("rn", String(++requestNumberRef.value));
  url.searchParams.delete("ump");
  const response = await targetWindow.fetch(url, {
    signal,
    cache: "no-store",
  });
  if (!response.ok) {
    throw new MediaHttpError(
      response.status,
      `Audio downloader. Media request failed (${response.status}, range ${start}-${end})`,
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  signal.throwIfAborted();
  if (bytes.byteLength === end - start + 1) {
    return { type: "data", bytes, urlVersion };
  }

  const redirect = /^\s*(https:\/\/\S+)\s*$/.exec(
    new TextDecoder("ascii").decode(bytes),
  )?.[1];
  if (redirect) {
    const next = new URL(redirect);
    if (!/(?:^|\.)googlevideo\.com$/.test(next.hostname)) {
      throw new Error("Audio downloader. Invalid media redirect");
    }
    urlState.value = next.toString();
    return { type: "redirect", urlVersion, bytesLength: bytes.byteLength };
  }
  throw new Error(
    `Audio downloader. Incomplete web ABR chunk (${bytes.byteLength}/${end - start + 1}, range ${start}-${end})`,
  );
}

type MediaRangeRecovery = {
  stop: boolean;
  refreshedFatal: boolean;
  lastError: unknown;
};

async function recoverMediaRangeFailure(
  error: unknown,
  refreshedFatal: boolean,
  attempt: number,
  start: number,
  end: number,
  signal: AbortSignal,
  urlState: MediaUrlState,
  refreshUrl: () => Promise<string>,
): Promise<MediaRangeRecovery> {
  signal.throwIfAborted();
  const failedAttempt = attempt + 1;
  const fatal = isFatalMediaError(error);
  const hasMoreAttempts = failedAttempt < WEB_ABR_RANGE_MAX_ATTEMPTS;
  const shouldRefreshUrl =
    hasMoreAttempts &&
    (fatal || failedAttempt % WEB_ABR_RANGE_REFRESH_EVERY_FAILURES === 0);
  debug.log("Audio downloader. web ABR range request failed", {
    range: `${start}-${end}`,
    attempt: failedAttempt,
    maxAttempts: WEB_ABR_RANGE_MAX_ATTEMPTS,
    fatal,
    refreshUrl: shouldRefreshUrl,
    error: error instanceof Error ? error.message : String(error),
  });

  if (!hasMoreAttempts || (fatal && refreshedFatal)) {
    return { stop: true, refreshedFatal, lastError: error };
  }

  await createAbortableDelay(
    Math.min(
      WEB_ABR_RANGE_RETRY_BASE_DELAY_MS * failedAttempt,
      WEB_ABR_RANGE_RETRY_MAX_DELAY_MS,
    ),
    signal,
  );
  if (!shouldRefreshUrl) {
    return { stop: false, refreshedFatal, lastError: error };
  }

  try {
    await refreshMediaUrl(urlState, refreshUrl, {
      range: `${start}-${end}`,
      failedAttempt,
    });
    const nextRefreshedFatal = fatal || refreshedFatal;
    debug.log("Audio downloader. web ABR media URL refreshed for range retry", {
      range: `${start}-${end}`,
      nextAttempt: failedAttempt + 1,
      urlVersion: urlState.version ?? 0,
    });
    return {
      stop: false,
      refreshedFatal: nextRefreshedFatal,
      lastError: error,
    };
  } catch (refreshError) {
    signal.throwIfAborted();
    debug.log("Audio downloader. web ABR media URL refresh failed", {
      range: `${start}-${end}`,
      nextAttempt: failedAttempt + 1,
      error:
        refreshError instanceof Error
          ? refreshError.message
          : String(refreshError),
    });
    return {
      stop: fatal,
      refreshedFatal,
      lastError: fatal ? error : refreshError,
    };
  }
}

async function fetchMediaRange(
  targetWindow: Window,
  urlState: MediaUrlState,
  start: number,
  end: number,
  signal: AbortSignal,
  refreshUrl: () => Promise<string>,
  requestNumberRef: RequestNumberRef,
): Promise<Uint8Array> {
  let lastError: unknown;
  let refreshedFatal = false;
  for (let attempt = 0; attempt < WEB_ABR_RANGE_MAX_ATTEMPTS; attempt++) {
    signal.throwIfAborted();
    // If another failed range is already refreshing the signed media URL,
    // wait for that refresh before starting this retry. This keeps every retry
    // on the newest URL without restarting ranges that already succeeded.
    if (attempt > 0 && urlState.refreshPromise !== null) {
      await urlState.refreshPromise;
    }
    try {
      const result = await requestMediaRange(
        targetWindow,
        urlState,
        start,
        end,
        signal,
        requestNumberRef,
      );
      if (result.type === "redirect") {
        if (attempt + 1 < WEB_ABR_RANGE_MAX_ATTEMPTS) continue;
        throw new Error(
          `Audio downloader. Incomplete web ABR chunk (${result.bytesLength}/${end - start + 1}, range ${start}-${end})`,
        );
      }
      if (attempt > 0) {
        debug.log("Audio downloader. web ABR range recovered", {
          range: `${start}-${end}`,
          attempt: attempt + 1,
          maxAttempts: WEB_ABR_RANGE_MAX_ATTEMPTS,
          urlVersion: result.urlVersion,
        });
      }
      return result.bytes;
    } catch (error) {
      const recovery = await recoverMediaRangeFailure(
        error,
        refreshedFatal,
        attempt,
        start,
        end,
        signal,
        urlState,
        refreshUrl,
      );
      refreshedFatal = recovery.refreshedFatal;
      lastError = recovery.lastError;
      if (recovery.stop) break;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Audio downloader. Media range failed");
}

async function* emitOrderedBuffers(
  buffers: Uint8Array[],
  isLastBatch: boolean,
  pendingState: PendingState,
): AsyncGenerator<AudioChunk> {
  for (let bufferIndex = 0; bufferIndex < buffers.length; bufferIndex++) {
    const buffer = buffers[bufferIndex];
    pendingState.buffers.push(buffer);
    pendingState.size += buffer.byteLength;

    const isFinalBuffer = isLastBatch && bufferIndex === buffers.length - 1;
    if (pendingState.size >= config.minChunkSize && !isFinalBuffer) {
      yield {
        buffer: concatBuffers(pendingState.buffers),
        isLastChunk: false,
      };
      pendingState.buffers = [];
      pendingState.size = 0;
    }
  }

  if (isLastBatch) {
    if (pendingState.size < 1) {
      throw new Error("Audio downloader. Final web ABR chunk is empty");
    }
    yield {
      buffer: concatBuffers(pendingState.buffers),
      isLastChunk: true,
    };
    pendingState.buffers = [];
    pendingState.size = 0;
  }
}

async function* downloadRangesSequential(
  targetWindow: Window,
  streamUrl: string,
  _contentLength: number,
  signal: AbortSignal,
  refreshUrl: () => Promise<string>,
  ranges: MediaRange[],
): AsyncGenerator<AudioChunk> {
  const urlState: MediaUrlState = {
    value: streamUrl,
    refreshPromise: null,
    version: 0,
  };
  const requestNumberRef: RequestNumberRef = { value: 0 };
  const pendingState: PendingState = { buffers: [], size: 0 };
  for (let index = 0; index < ranges.length; index++) {
    const { start, end } = ranges[index];
    const buffer = await fetchMediaRange(
      targetWindow,
      urlState,
      start,
      end,
      signal,
      refreshUrl,
      requestNumberRef,
    );
    for await (const chunk of emitOrderedBuffers(
      [buffer],
      index === ranges.length - 1,
      pendingState,
    ))
      yield chunk;
  }
}

async function* downloadRangesParallel(
  targetWindow: Window,
  streamUrl: string,
  contentLength: number,
  signal: AbortSignal,
  refreshUrl: () => Promise<string>,
  concurrency: number,
): AsyncGenerator<AudioChunk> {
  const ranges = makeFixedRanges(contentLength, 4 * 1024 * 1024);
  const urlState: MediaUrlState = {
    value: streamUrl,
    refreshPromise: null,
    version: 0,
  };
  const requestNumberRef: RequestNumberRef = { value: 0 };
  const pendingState: PendingState = { buffers: [], size: 0 };

  for (let index = 0; index < ranges.length; index += concurrency) {
    signal.throwIfAborted();
    const batch = ranges.slice(index, index + concurrency);
    const buffers = await Promise.all(
      batch.map(({ start, end }) =>
        fetchMediaRange(
          targetWindow,
          urlState,
          start,
          end,
          signal,
          refreshUrl,
          requestNumberRef,
        ),
      ),
    );
    for await (const chunk of emitOrderedBuffers(
      buffers,
      index + batch.length >= ranges.length,
      pendingState,
    ))
      yield chunk;
  }
}

type StreamChunkBuffer = {
  pending: Uint8Array[];
  pendingSize: number;
  readyChunk: Uint8Array | null;
};

function appendStreamBytes(
  state: StreamChunkBuffer,
  bytes: Uint8Array,
): Uint8Array | undefined {
  state.pending.push(bytes);
  state.pendingSize += bytes.byteLength;
  if (state.pendingSize < config.minChunkSize) return;
  const nextChunk = concatBuffers(state.pending);
  state.pending.length = 0;
  state.pendingSize = 0;
  const completedChunk = state.readyChunk ?? undefined;
  state.readyChunk = nextChunk;
  return completedChunk;
}

function finishStreamChunks(state: StreamChunkBuffer): AudioChunk[] {
  if (state.pendingSize > 0) {
    const chunks: AudioChunk[] = [];
    if (state.readyChunk) {
      chunks.push({ buffer: state.readyChunk, isLastChunk: false });
    }
    chunks.push({
      buffer: concatBuffers(state.pending),
      isLastChunk: true,
    });
    return chunks;
  }
  if (!state.readyChunk?.byteLength) {
    throw new Error("Audio downloader. Stream ended without audio data");
  }
  return [{ buffer: state.readyChunk, isLastChunk: true }];
}

async function* downloadStream(
  targetWindow: Window,
  streamUrl: string,
  signal: AbortSignal,
): AsyncGenerator<AudioChunk> {
  const url = new URL(streamUrl);
  url.searchParams.delete("range");
  url.searchParams.delete("rn");
  url.searchParams.delete("ump");
  const response = await targetWindow.fetch(url, { signal });
  if (!response.ok)
    throw new Error(
      `Audio downloader. Stream request failed (${response.status})`,
    );
  if (!response.body)
    throw new Error("Audio downloader. Stream body is unavailable");

  const reader = response.body.getReader();
  const state: StreamChunkBuffer = {
    pending: [],
    pendingSize: 0,
    readyChunk: null,
  };
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      const completedChunk = appendStreamBytes(state, bytes);
      if (completedChunk) {
        yield { buffer: completedChunk, isLastChunk: false };
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }

  for (const chunk of finishStreamChunks(state)) yield chunk;
}

async function* downloadWithTransport(
  targetWindow: Window,
  transport: WebAbrTransport,
  streamUrl: string,
  contentLength: number,
  signal: AbortSignal,
  refreshUrl: () => Promise<string>,
): AsyncGenerator<AudioChunk> {
  switch (transport) {
    case "parallel_4":
      yield* downloadRangesParallel(
        targetWindow,
        streamUrl,
        contentLength,
        signal,
        refreshUrl,
        4,
      );
      return;
    case "parallel_2":
      yield* downloadRangesParallel(
        targetWindow,
        streamUrl,
        contentLength,
        signal,
        refreshUrl,
        2,
      );
      return;
    case "parallel_8":
      yield* downloadRangesParallel(
        targetWindow,
        streamUrl,
        contentLength,
        signal,
        refreshUrl,
        8,
      );
      return;
    case "stream":
      yield* downloadStream(targetWindow, streamUrl, signal);
      return;
    case "8mb":
      yield* downloadRangesSequential(
        targetWindow,
        streamUrl,
        contentLength,
        signal,
        refreshUrl,
        makeFixedRanges(contentLength, 8 * 1024 * 1024),
      );
      return;
    case "4mb":
      yield* downloadRangesSequential(
        targetWindow,
        streamUrl,
        contentLength,
        signal,
        refreshUrl,
        makeFixedRanges(contentLength, 4 * 1024 * 1024),
      );
      return;
    case "2mb":
      yield* downloadRangesSequential(
        targetWindow,
        streamUrl,
        contentLength,
        signal,
        refreshUrl,
        makeFixedRanges(contentLength, 2 * 1024 * 1024),
      );
      return;
    case "original":
      yield* downloadRangesSequential(
        targetWindow,
        streamUrl,
        contentLength,
        signal,
        refreshUrl,
        buildMediaRanges(contentLength),
      );
      return;
    default:
      throw new Error(
        `Audio downloader. Unknown web ABR transport: ${transport}`,
      );
  }
}

async function downloadCompleteTransport(
  targetWindow: Window,
  transport: WebAbrTransport,
  streamUrl: string,
  contentLength: number,
  signal: AbortSignal,
  refreshUrl: () => Promise<string>,
  startedAt: number,
): Promise<{ chunks: AudioChunk[]; startedAt: number }> {
  debug.log("Audio downloader. web ABR transport started", {
    transport,
    contentLength,
    bufferBeforeEmit: true,
  });

  const bufferedChunks: AudioChunk[] = [];
  let downloadedBytes = 0;
  for await (const chunk of downloadWithTransport(
    targetWindow,
    transport,
    streamUrl,
    contentLength,
    signal,
    refreshUrl,
  )) {
    if (!chunk?.buffer?.byteLength) {
      throw new Error(
        "Audio downloader. Web ABR transport produced an empty chunk",
      );
    }
    bufferedChunks.push(chunk);
    downloadedBytes += chunk.buffer.byteLength;
  }

  if (downloadedBytes !== contentLength) {
    throw new Error(
      `Audio downloader. Incomplete web ABR download (${downloadedBytes}/${contentLength} bytes)`,
    );
  }
  if (bufferedChunks.length < 1) {
    throw new Error(
      "Audio downloader. Web ABR transport returned no audio chunks",
    );
  }

  for (let index = 0; index < bufferedChunks.length; index++) {
    bufferedChunks[index] = {
      ...bufferedChunks[index],
      isLastChunk: index === bufferedChunks.length - 1,
    };
  }
  debug.log("Audio downloader. web ABR transport fully buffered", {
    transport,
    chunks: bufferedChunks.length,
    downloadedBytes,
    elapsedMs: Math.round(performance.now() - startedAt),
  });
  return { chunks: bufferedChunks, startedAt };
}

export async function* downloadMediaRanges(
  targetWindow: Window,
  streamUrl: string,
  contentLength: number,
  signal: AbortSignal,
  refreshUrl: () => Promise<string>,
): AsyncGenerator<AudioChunk> {
  if (!Number.isSafeInteger(contentLength) || contentLength < 1)
    throw new Error("Audio downloader. Invalid media content length");

  // Start with parallel_4 and move forward through the fallback list.
  const transports = [...WEB_ABR_TRANSPORTS];
  debug.log("Audio downloader. web ABR transport order", {
    transports,
    bufferBeforeEmit: true,
  });

  let lastError: unknown;
  for (const transport of transports) {
    signal.throwIfAborted();
    const startedAt = performance.now();
    try {
      const result = await downloadCompleteTransport(
        targetWindow,
        transport,
        streamUrl,
        contentLength,
        signal,
        refreshUrl,
        startedAt,
      );

      // Only now make the chunks visible to AudioDownloader/Yandex upload.
      for (const chunk of result.chunks) yield chunk;

      debug.log("Audio downloader. web ABR transport finished", {
        transport,
        elapsedMs: Math.round(performance.now() - result.startedAt),
        bufferBeforeEmit: true,
      });
      return;
    } catch (error) {
      signal.throwIfAborted();
      lastError = error;
      debug.log("Audio downloader. web ABR transport failed", {
        transport,
        emitted: false,
        bufferBeforeEmit: true,
        elapsedMs: Math.round(performance.now() - startedAt),
        error: error instanceof Error ? error.message : String(error),
      });
      if (isFatalMediaError(error)) {
        debug.log("Audio downloader. web ABR transport matrix aborted", {
          transport,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Audio downloader. All web ABR transports failed");
}

type WebAbrClientName =
  | "web_embedded"
  | "tv_downgraded"
  | "web"
  | "web_creator";
type PlayerRequestResult = {
  response: WebEmbeddedPlayerResponse;
  authenticated: boolean;
};
type WebAbrContext = {
  targetWindow: WebAbrWindow;
  videoId: string;
  signal: AbortSignal;
  config: YouTubeConfig;
  apiKey: string;
  signatureTimestamp: number;
  embeddedBody: Record<string, unknown>;
  clientVersion: string;
  visitorData: unknown;
  dataSyncId: unknown;
  authorization?: string;
  sessionIndex: unknown;
  delegatedSessionId: unknown;
  authenticatedAuth: {
    authorization?: string;
    sessionIndex: unknown;
    delegatedSessionId: unknown;
  };
  pageExperimentFlags: string[];
  fetchPlayerCode: (url?: string) => Promise<string | undefined>;
};
type WebAbrPlayerClient = {
  name: WebAbrClientName;
  fetchedConfig?: FetchedClientConfig;
  candidateBody: Record<string, unknown>;
  candidateClient: Record<string, unknown>;
  requestPlayer: (authenticated?: boolean) => Promise<PlayerRequestResult>;
  getCode: () => Promise<string | undefined>;
};

const WEB_ABR_CLIENTS: WebAbrClientName[] = [
  "web_embedded",
  "tv_downgraded",
  "web",
  "web_creator",
];
const WEB_ABR_CLIENT_IDS: Record<WebAbrClientName, string> = {
  web_embedded: "56",
  tv_downgraded: "7",
  web: "1",
  web_creator: "62",
};

async function createWebAbrContext(
  targetWindow: WebAbrWindow,
  videoId: string,
  signal: AbortSignal,
): Promise<WebAbrContext> {
  const config = await resolveYtcfg(targetWindow, signal);
  const apiKey = getConfigValue(config, "INNERTUBE_API_KEY");
  if (typeof apiKey !== "string") {
    throw new TypeError("Audio downloader. web ABR config is unavailable");
  }

  const playerCodes = new Map<string, Promise<string>>();
  const fetchPlayerCode = async (
    playerUrl = getPlayerUrl(config),
  ): Promise<string | undefined> => {
    if (!playerUrl) return undefined;
    let code = playerCodes.get(playerUrl);
    if (!code) {
      code = targetWindow.fetch(playerUrl, { signal }).then((response) => {
        if (!response.ok) {
          throw new Error(
            `Audio downloader. YouTube player request failed (${response.status})`,
          );
        }
        return response.text();
      });
      playerCodes.set(playerUrl, code);
    }
    return await code;
  };
  let signatureTimestamp = Number(getConfigValue(config, "STS"));
  if (!Number.isFinite(signatureTimestamp) || signatureTimestamp <= 0) {
    const playerCode = await fetchPlayerCode();
    signatureTimestamp = Number(
      /(?:signatureTimestamp|sts)\s*:\s*(\d{5})/.exec(playerCode ?? "")?.[1],
    );
  }
  const embeddedBody = buildWebEmbeddedPlayerRequest(
    config,
    videoId,
    signatureTimestamp,
  );
  const embeddedClient = (
    embeddedBody.context as { client: Record<string, unknown> }
  ).client;
  const clientVersion =
    typeof embeddedClient.clientVersion === "string"
      ? embeddedClient.clientVersion
      : "";
  const visitorData =
    embeddedClient.visitorData ?? getConfigValue(config, "VISITOR_DATA");
  if (typeof visitorData === "string") embeddedClient.visitorData = visitorData;
  const dataSyncId = getConfigValue(config, "DATASYNC_ID");
  const [firstSyncId, secondSyncId] =
    typeof dataSyncId === "string" ? dataSyncId.split("||") : [];
  const rawUserSessionId = getConfigValue(config, "USER_SESSION_ID");
  const userSessionId =
    typeof rawUserSessionId === "string"
      ? rawUserSessionId
      : secondSyncId || firstSyncId;
  const delegatedSessionId =
    getConfigValue(config, "DELEGATED_SESSION_ID") ??
    (secondSyncId ? firstSyncId : undefined);
  // Prefer guest playback, but keep the current YouTube session as a fallback
  // for videos that YouTube itself exposes only to the signed-in account.
  const authorization = await getYouTubeAuthorization(
    targetWindow,
    userSessionId || undefined,
  );
  const loggedIn = getConfigValue(config, "LOGGED_IN") === true;
  const sessionIndex = getConfigValue(config, "SESSION_INDEX");
  const playerContexts = getConfigValue(config, "WEB_PLAYER_CONTEXT_CONFIGS");
  const pageExperimentFlags = Object.values(
    playerContexts && typeof playerContexts === "object" ? playerContexts : {},
  ).flatMap((entry: { serializedExperimentFlags?: unknown } | null) =>
    typeof entry?.serializedExperimentFlags === "string"
      ? [entry.serializedExperimentFlags]
      : [],
  );
  const authenticatedAuth = {
    authorization,
    sessionIndex,
    delegatedSessionId,
  };
  debug.log("Audio downloader. player auth state", {
    videoId,
    host: targetWindow.location.hostname,
    anonymousFirst: true,
    hasAuthorization: Boolean(authorization),
    sessionIndex: sessionIndex ?? "none",
    hasDelegatedSession: Boolean(delegatedSessionId),
    loggedIn,
  });
  return {
    targetWindow,
    videoId,
    signal,
    config,
    apiKey,
    signatureTimestamp,
    embeddedBody,
    clientVersion,
    visitorData,
    dataSyncId,
    authorization,
    sessionIndex,
    delegatedSessionId,
    authenticatedAuth,
    pageExperimentFlags,
    fetchPlayerCode,
  };
}

async function createWebAbrPlayerClient(
  context: WebAbrContext,
  name: WebAbrClientName,
): Promise<WebAbrPlayerClient> {
  const { targetWindow, signal, videoId } = context;
  const fetchedConfig =
    name === "tv_downgraded"
      ? await fetchTvConfig(targetWindow, signal, videoId)
      : undefined;
  const options = {
    visitorData: fetchedConfig?.visitorData ?? context.visitorData,
    signatureTimestamp:
      fetchedConfig?.signatureTimestamp ?? context.signatureTimestamp,
    clientVersion: fetchedConfig?.clientVersion,
  };
  let candidateBody: Record<string, unknown>;
  if (name === "web_embedded") {
    candidateBody = context.embeddedBody;
  } else if (name === "tv_downgraded") {
    candidateBody = buildTvDowngradedPlayerRequest(videoId, options);
  } else if (name === "web") {
    candidateBody = buildWebPlayerRequest(
      context.config,
      videoId,
      context.signatureTimestamp,
    );
  } else {
    candidateBody = buildWebCreatorPlayerRequest(videoId, options);
  }
  const candidateClient = (
    candidateBody.context as { client: Record<string, unknown> }
  ).client;
  if (typeof options.visitorData === "string") {
    candidateClient.visitorData = options.visitorData;
  }
  const postPlayer = (authenticated: boolean) =>
    postInnertubePlayer(
      targetWindow,
      signal,
      fetchedConfig?.apiKey ?? context.apiKey,
      candidateBody,
      WEB_ABR_CLIENT_IDS[name],
      typeof candidateClient.clientVersion === "string"
        ? candidateClient.clientVersion
        : context.clientVersion,
      authenticated ? context.authenticatedAuth : {},
    );
  const requestPlayer = async (
    authenticated = false,
  ): Promise<PlayerRequestResult> => {
    const response = await postPlayer(authenticated);
    const status = response.playabilityStatus?.status ?? "";
    if (
      !authenticated &&
      context.authorization &&
      /LOGIN_REQUIRED|AGE_CHECK_REQUIRED|CONTENT_CHECK_REQUIRED/.test(status)
    ) {
      debug.log("Audio downloader. retrying player with YouTube session", {
        videoId,
        client: name,
        status,
      });
      return { response: await postPlayer(true), authenticated: true };
    }
    return { response, authenticated };
  };
  return {
    name,
    fetchedConfig,
    candidateBody,
    candidateClient,
    requestPlayer,
    getCode: () => context.fetchPlayerCode(fetchedConfig?.playerUrl),
  };
}

function getClientAudioFormats(
  name: WebAbrClientName,
  response: WebEmbeddedPlayerResponse,
): WebEmbeddedFormat[] {
  const formats = [
    ...(response.streamingData?.adaptiveFormats ?? []),
    ...(response.streamingData?.formats ?? []),
  ];
  if (formats.length > 0) return formats;
  const status = response.playabilityStatus;
  throw new Error(
    `Audio downloader. ${name} ${status?.status ?? "failed"}: ${
      status?.reason ?? status?.messages?.join(" ") ?? "no streaming data"
    }`,
  );
}

function createStreamUrlAuthorizer(
  context: WebAbrContext,
  binding:
    | { kind: "video" | "datasync" | "visitor"; value: string }
    | undefined,
): (streamUrl: string) => Promise<string> {
  let poToken: Promise<string | undefined> | undefined;
  return async (streamUrl: string) => {
    const url = new URL(streamUrl);
    if (!url.searchParams.has("pot") && binding) {
      poToken ??= mintPagePoToken(
        context.targetWindow,
        binding.value,
        context.signal,
      );
      const token = await poToken;
      if (token) url.searchParams.set("pot", token);
    }
    return url.toString();
  };
}

async function getRefreshedFormatUrl(
  context: WebAbrContext,
  client: WebAbrPlayerClient,
  format: WebEmbeddedFormat,
  contentLength: number,
  authenticated: boolean,
  authorizeUrl: (streamUrl: string) => Promise<string>,
): Promise<string> {
  const refreshedPlayer = await client.requestPlayer(authenticated);
  const response = refreshedPlayer.response;
  const refreshed = [
    ...(response.streamingData?.adaptiveFormats ?? []),
    ...(response.streamingData?.formats ?? []),
  ].find(
    (entry) =>
      entry.itag === format.itag &&
      entry.mimeType === format.mimeType &&
      Number(entry.contentLength) === contentLength &&
      entry.lastModified === format.lastModified,
  );
  if (!refreshed) {
    throw new Error("Audio downloader. Refreshed audio format changed");
  }
  const urlIterator = resolveWebEmbeddedFormatUrl(
    context.targetWindow,
    refreshed,
    client.getCode,
    context.signal,
  );
  try {
    const nextUrl = await urlIterator.next();
    if (!nextUrl.done) return await authorizeUrl(nextUrl.value);
    throw new Error("Audio downloader. Refreshed audio URL unavailable");
  } finally {
    await urlIterator.return(undefined);
  }
}

async function* downloadResolvedFormatCandidate(
  context: WebAbrContext,
  client: WebAbrPlayerClient,
  format: WebEmbeddedFormat,
  solvedUrl: string,
  authenticated: boolean,
  authorizeUrl: (streamUrl: string) => Promise<string>,
): AsyncGenerator<AudioChunk> {
  const streamUrl = await authorizeUrl(solvedUrl);
  const contentLength =
    Number(format.contentLength) ||
    (await probeContentLength(context.targetWindow, streamUrl, context.signal));
  const refreshUrl = () =>
    getRefreshedFormatUrl(
      context,
      client,
      format,
      contentLength,
      authenticated,
      authorizeUrl,
    );
  yield* downloadMediaRanges(
    context.targetWindow,
    streamUrl,
    contentLength,
    context.signal,
    refreshUrl,
  );
}

async function* downloadWebAbrPlayerClient(
  context: WebAbrContext,
  client: WebAbrPlayerClient,
  sourceLanguage?: string,
): AsyncGenerator<AudioChunk> {
  const initialPlayer = await client.requestPlayer();
  const requestAuthenticated = initialPlayer.authenticated;
  const playerResponse = initialPlayer.response;
  const formats = getClientAudioFormats(client.name, playerResponse);
  const format = selectWebEmbeddedAudioFormat(formats, sourceLanguage);
  const fetchedFlags = client.fetchedConfig?.experimentFlags;
  const poTokenBinding = selectGvsPoTokenBinding(context.videoId, {
    loggedIn: requestAuthenticated,
    dataSyncId:
      playerResponse.responseContext?.mainAppWebResponseContext?.datasyncId ||
      context.dataSyncId ||
      client.fetchedConfig?.dataSyncId,
    visitorData: client.candidateClient.visitorData ?? context.visitorData,
    experimentFlags: fetchedFlags?.length
      ? fetchedFlags
      : context.pageExperimentFlags,
  });
  const authorizeUrl = createStreamUrlAuthorizer(context, poTokenBinding);
  let emitted = false;
  let lastError: unknown;
  for await (const solvedUrl of resolveWebEmbeddedFormatUrl(
    context.targetWindow,
    format,
    client.getCode,
    context.signal,
  )) {
    try {
      for await (const chunk of downloadResolvedFormatCandidate(
        context,
        client,
        format,
        solvedUrl,
        requestAuthenticated,
        authorizeUrl,
      )) {
        emitted = true;
        yield chunk;
      }
      return;
    } catch (error) {
      context.signal.throwIfAborted();
      if (emitted) throw error;
      lastError = error;
      // Nothing escaped this candidate; try another solved URL from byte zero.
    }
  }
  if (lastError) throw lastError;
}

function throwWebAbrFailure(lastError: unknown): never {
  const fallbackError =
    lastError instanceof Error
      ? lastError
      : new Error("Audio downloader. no playable audio formats");
  if (/LOGIN_REQUIRED|UNPLAYABLE/.test(fallbackError.message)) {
    throw new Error(
      `${fallbackError.message}. Anonymous playback and the available signed-in YouTube session were both unable to provide a playable audio stream`,
      { cause: fallbackError },
    );
  }
  throw fallbackError;
}

async function* getWebAbrAudioChunksImpl(
  targetWindow: WebAbrWindow,
  videoId: string,
  signal: AbortSignal,
  sourceLanguage?: string,
): AsyncGenerator<AudioChunk> {
  const context = await createWebAbrContext(targetWindow, videoId, signal);
  let lastError: unknown;
  let emitted = false;
  for (const name of WEB_ABR_CLIENTS) {
    signal.throwIfAborted();
    debug.log("Audio downloader. trying player client", {
      videoId,
      client: name,
    });
    try {
      const client = await createWebAbrPlayerClient(context, name);
      for await (const chunk of downloadWebAbrPlayerClient(
        context,
        client,
        sourceLanguage,
      )) {
        emitted = true;
        yield chunk;
      }
      return;
    } catch (error) {
      signal.throwIfAborted();
      if (emitted) throw error;
      debug.log("Audio downloader. player client format failed", {
        videoId,
        client: name,
        error: error instanceof Error ? error.message : String(error),
      });
      lastError = error;
    }
  }
  throwWebAbrFailure(lastError);
}

const WEB_ABR_DOWNLOAD_QUEUE = new Map<string, Promise<void>>();

/**
 * Serialize concurrent web_abr downloads for the same video.
 *
 * If VOT accidentally calls web_abr twice for one video, the second call waits
 * until the first generator is completely finished before it starts resolving
 * clients/media URLs or issuing media requests. Calls for different videos can
 * still run independently.
 */
export async function* getWebAbrAudioChunks(
  targetWindow: WebAbrWindow,
  videoId: string,
  signal: AbortSignal,
  sourceLanguage?: string,
): AsyncGenerator<AudioChunk> {
  const queueKey = String(videoId);
  const previous = WEB_ABR_DOWNLOAD_QUEUE.get(queueKey) ?? Promise.resolve();
  const hadPrevious = WEB_ABR_DOWNLOAD_QUEUE.has(queueKey);

  let releaseCurrent: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  WEB_ABR_DOWNLOAD_QUEUE.set(queueKey, current);

  debug.log("Audio downloader. web ABR queued", {
    videoId,
    hasPrevious: hadPrevious,
  });

  try {
    await previous;
    signal.throwIfAborted();
    yield* getWebAbrAudioChunksImpl(
      targetWindow,
      videoId,
      signal,
      sourceLanguage,
    );
  } finally {
    releaseCurrent?.();
    if (WEB_ABR_DOWNLOAD_QUEUE.get(queueKey) === current) {
      WEB_ABR_DOWNLOAD_QUEUE.delete(queueKey);
    }
    debug.log("Audio downloader. web ABR queue released", { videoId });
  }
}
