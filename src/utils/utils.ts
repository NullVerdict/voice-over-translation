// Removed heavy Bowser dependency in favor of a lightweight UA parser
// ID3 tagging is loaded on demand to avoid pulling it into the initial bundle

import { availableTTS } from "@vot.js/shared/consts";
import { ResponseLang } from "@vot.js/shared/types/data";

import { lang } from "./localization";

export interface DocumentWithFullscreen extends Document {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void>;
}

const textFilters =
  /(?:https?|www|\bhttp\s+)[^\s/]*?(?:\.\s*[a-z]{2,}|\/)\S*|#[^\s#]+|auto-generated\s+by\s+youtube|provided\s+to\s+youtube\s+by|released\s+on|paypal?|0x[\da-f]{40}|[13][1-9a-z]{25,34}|4[\dab][1-9a-z]{93}|t[1-9a-z]{33}/gi;
const slavicLangs = new Set([
  "uk",
  "be",
  "bg",
  "mk",
  "sr",
  "bs",
  "hr",
  "sl",
  "pl",
  "sk",
  "cs",
]);
export const calculatedResLang: ResponseLang = (() => {
  if (availableTTS.includes(lang as ResponseLang)) {
    return lang as ResponseLang;
  }

  if (slavicLangs.has(lang)) {
    return "ru";
  }

  return "en";
})();

type ParsedInfo = {
  browser: { name: string; version: string };
  os: { name: string; version: string };
};

function parseUserAgent(): ParsedInfo {
  const ua = navigator.userAgent;
  // Browser
  let browserName = "Unknown";
  let browserVersion = "";
  const browserRegexes: Array<[RegExp, string]> = [
    [/Edg\/(\d+\.\d+(?:\.\d+)?)/, "Edge"],
    [/OPR\/(\d+\.\d+(?:\.\d+)?)/, "Opera"],
    [/Chrome\/(\d+\.\d+(?:\.\d+)?)/, "Chrome"],
    [/Firefox\/(\d+\.\d+(?:\.\d+)?)/, "Firefox"],
    [/Version\/(\d+\.\d+(?:\.\d+)?)\s+Safari\//, "Safari"],
  ];
  for (const [re, name] of browserRegexes) {
    const m = ua.match(re);
    if (m) {
      browserName = name;
      browserVersion = m[1] || "";
      break;
    }
  }

  // OS
  let osName = "Unknown";
  let osVersion = "";
  const osMatchers: Array<[RegExp, (m: RegExpMatchArray) => [string, string]]> = [
    [/Windows NT (\d+\.\d+)/, (m) => ["Windows", m[1]]],
    [/Android\s(\d+(?:\.\d+)?)/, (m) => ["Android", m[1]]],
    [/iPhone OS (\d+_\d+(?:_\d+)?)/, (m) => ["iOS", m[1].replaceAll("_", ".")]],
    [/iPad; CPU OS (\d+_\d+(?:_\d+)?)/, (m) => ["iPadOS", m[1].replaceAll("_", ".")]],
    [/Mac OS X (\d+_\d+(?:_\d+)?)/, (m) => ["macOS", m[1].replaceAll("_", ".")]],
    [/Linux/, () => ["Linux", ""]],
  ];
  for (const [re, fn] of osMatchers) {
    const m = ua.match(re);
    if (m) {
      [osName, osVersion] = fn(m);
      break;
    }
  }

  return {
    browser: { name: browserName, version: browserVersion },
    os: { name: osName, version: osVersion },
  };
}

export const browserInfo: ParsedInfo = parseUserAgent();

export const isPiPAvailable = () =>
  "pictureInPictureEnabled" in document && document.pictureInPictureEnabled;

function initHls() {
  return typeof Hls != "undefined" && Hls?.isSupported()
    ? new Hls({
        debug: DEBUG_MODE,
        lowLatencyMode: true,
        backBufferLength: 90,
      })
    : undefined;
}

function cleanText(title: string, description?: string) {
  return (title + " " + (description || ""))
    .replace(textFilters, "")
    .replace(/[^\p{L}]+/gu, " ")
    .substring(0, 450)
    .trim();
}

/**
 * Downloads binary file with entered filename
 */
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function clearFileName(filename: string) {
  if (filename.trim().length === 0) {
    return new Date().toLocaleDateString("en-us").replaceAll("/", "-");
  }

  return filename.replace(/^https?:\/\//, "").replace(/[\\/:*?"'<>|]/g, "-");
}

function getTimestamp() {
  return Math.floor(Date.now() / 1000);
}

function getHeaders(headers: HeadersInit | undefined): Record<string, unknown> {
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }

  return headers || {};
}

function clamp(value: number, min = 0, max = 100) {
  return Math.min(Math.max(value, min), max);
}

function toFlatObj<T extends Record<string, unknown>>(
  data: Record<string, unknown>,
): T {
  // eslint-disable-next-line no-accumulating-spread
  return Object.entries(data).reduce<Record<string, unknown>>(
    (result, [key, val]) => {
      if (val === undefined) {
        return result;
      }

      if (typeof val !== "object") {
        result[key] = val;
        return result;
      }

      const nestedItem = Object.entries(
        toFlatObj<T>(data[key] as Record<string, unknown>),
      ).reduce<Record<string, unknown>>((res, [k, v]) => {
        res[`${key}.${k}`] = v;
        return res;
      }, {});
      return {
        ...result,
        ...nestedItem,
      };
    },
    {},
  ) as T;
}

async function exitFullscreen() {
  const doc = document as DocumentWithFullscreen;
  if (doc.fullscreenElement || doc.webkitFullscreenElement) {
    doc.webkitExitFullscreen && (await doc.webkitExitFullscreen());
    doc.exitFullscreen && (await doc.exitFullscreen());
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function timeout(ms: number, message = "Operation timed out"): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

async function waitForCondition(
  condition: () => boolean,
  timeoutMs: number,
  throwOnTimeout = false,
): Promise<void> {
  let timedOut = false;

  return Promise.race([
    (async () => {
      while (!condition() && !timedOut) {
        await sleep(100);
      }
    })(),
    new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        timedOut = true;
        if (throwOnTimeout) {
          reject(
            new Error(`Wait for condition reached timeout of ${timeoutMs}`),
          );
        } else {
          resolve();
        }
      }, timeoutMs);
    }),
  ]);
}

async function _downloadTranslationWithProgress(
  res: Response,
  contentLength: number,
  onProgress = (_progress: number) => {},
) {
  const reader = res.body?.getReader();
  if (!reader) {
    throw new Error("Response body is not readable");
  }
  const chunksBuffer = new Uint8Array(contentLength);
  let offset = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    chunksBuffer.set(value, offset);
    offset += value.length;
    onProgress(Math.round((offset / contentLength) * 100));
  }

  return chunksBuffer.buffer;
}

/**
 * Downloads a translation file and saves it as an MP3 file with metadata, if possible tracking progress.
 *
 * @param {Response} res - The response object from a fetch request
 * @param {string} filename - The name to assign to the downloaded file (without extension).
 * @param {function(number): void} [onProgress] - Optional callback function to track download progress.
 *        Receives a percentage (0 to 100) as its argument
 * @returns {Promise<boolean>} - Resolves to `true` when the download completed.
 */
async function downloadTranslation(
  res: Response,
  filename: string,
  onProgress = (_progress: number) => {},
) {
  const contentLength = +(res.headers.get("Content-Length") ?? 0);
  const arrayBuffer = await (!contentLength
    ? res.arrayBuffer()
    : _downloadTranslationWithProgress(res, contentLength, onProgress));
  onProgress(100);
  const { ID3Writer } = await import("browser-id3-writer");
  const writer = new ID3Writer(arrayBuffer);
  writer.setFrame("TIT2", filename);
  writer.addTag();
  downloadBlob(writer.getBlob(), `${filename}.mp3`);
  return true;
}

function openDownloadTranslation(url: string) {
  window.open(url, "_blank")?.focus();
}

export {
  initHls,
  cleanText,
  downloadBlob,
  clearFileName,
  getTimestamp,
  getHeaders,
  clamp,
  toFlatObj,
  exitFullscreen,
  sleep,
  timeout,
  waitForCondition,
  downloadTranslation,
  openDownloadTranslation,
};
