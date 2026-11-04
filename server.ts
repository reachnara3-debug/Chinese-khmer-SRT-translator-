import express from "express";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type, ThinkingLevel } from "@google/genai";
import { Agent, setGlobalDispatcher } from "undici";
import JSZip from "jszip";

// Configure global undici dispatcher to prevent "Headers Timeout Error" and "fetch failed"
// by increasing timeout limits for large Gemini model translation calls (default is 30s)
setGlobalDispatcher(new Agent({
  headersTimeout: 180000, // 3 minutes
  bodyTimeout: 180000,    // 3 minutes
}));

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Set up JSON parsing with a 10MB limit to support larger SRT batches safely
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

// Lazy init or safety check for Google GenAI client
let aiClient: GoogleGenAI | null = null;

function getAiClient(apiKeyOverride?: string) {
  const apiKey = apiKeyOverride || process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "MY_GEMINI_API_KEY") {
    throw new Error("GEMINI_API_KEY is not configured. Please add your key in Settings > Secrets or the API Key pool.");
  }

  // If we have an override, we must instantiate a fresh instance for that key to avoid cross-request contamination.
  // Otherwise, we can cache the default server-side instance.
  if (apiKeyOverride) {
    return new GoogleGenAI({
      apiKey,
      httpOptions: {
        timeout: 180000, // 3 minutes
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }

  if (!aiClient) {
    aiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        timeout: 180000, // 3 minutes
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return aiClient;
}

// Helper to detect daily quota exhaustion (429 RESOURCE_EXHAUSTED / free tier daily limit 500 reached)
export function checkIsDailyQuotaExceeded(errorMsg: string, errorCode?: any, errorStatus?: any): boolean {
  const msg = (errorMsg || "").toLowerCase();
  return (
    msg.includes("generaterequestsperday") ||
    msg.includes("perdayperproject") ||
    msg.includes("free_tier_requests") ||
    msg.includes("limit: 500") ||
    msg.includes("limit: 20") ||
    msg.includes("exceeded your current quota") ||
    msg.includes("quota exceeded") ||
    msg.includes("quotafailure") ||
    msg.includes("billing details") ||
    msg.includes("resource_exhausted") ||
    (errorStatus === "RESOURCE_EXHAUSTED" && !msg.includes("rate limit per minute")) ||
    /retry in \d+[hmd]/i.test(errorMsg) ||
    /retrydelay["']?:\s*["']?\d{4,}/i.test(errorMsg)
  );
}

// Model normalization helper
const ACTIVE_MODELS_ORDER = [
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash",
  "gemini-3.8-flash",
  "gemini-flash-latest"
];

function normalizeModelName(requestedModel?: string): string {
  if (!requestedModel || typeof requestedModel !== "string" || requestedModel.trim() === "") {
    return "gemini-3.1-flash-lite";
  }
  const clean = requestedModel.trim();
  if (clean === "gemini-3.5-flash-lite" || clean === "gemini-2.5-flash-lite" || clean === "flash-lite") {
    return "gemini-3.1-flash-lite";
  }
  if (clean === "gemini-3.5-flash" || clean === "gemini-flash") {
    return "gemini-3.8-flash";
  }
  return clean;
}

function getHealthyModel(requestedModel?: string): string {
  return normalizeModelName(requestedModel);
}

// Helper to generate content with intelligent retry and multi-model quota failover
async function generateContentWithRetry(
  ai: GoogleGenAI, 
  params: any, 
  maxModelAttempts = 4,
  triedModels: string[] = [],
  hasCustomApiKey = false
): Promise<any> {
  const targetModel = normalizeModelName(params.model);
  params.model = targetModel;
  if (!triedModels.includes(targetModel)) {
    triedModels.push(targetModel);
  }

  // Optimize thinking configuration for fast translation
  if (targetModel.startsWith("gemini-3")) {
    if (!params.config) params.config = {};
    if (!params.config.thinkingConfig) {
      params.config.thinkingConfig = { thinkingLevel: ThinkingLevel.LOW };
    }
  } else if (targetModel.startsWith("gemini-2.5")) {
    if (!params.config) params.config = {};
    params.config.thinkingConfig = { thinkingBudget: 0 };
  } else if (params.config?.thinkingConfig) {
    delete params.config.thinkingConfig;
  }

  let lastError: any = null;
  const maxAttemptsForModel = 2;

  for (let attempt = 1; attempt <= maxAttemptsForModel; attempt++) {
    try {
      return await ai.models.generateContent(params);
    } catch (error: any) {
      lastError = error;
      const errorMsg = error.message || error.toString() || "";
      let parsedApiError: any = null;
      try {
        if (typeof errorMsg === "string" && errorMsg.trim().startsWith("{")) {
          parsedApiError = JSON.parse(errorMsg);
        }
      } catch (_) {}

      const errorCode = error.code || parsedApiError?.error?.code || (errorMsg.includes("499") ? 499 : errorMsg.includes("504") ? 504 : errorMsg.includes("503") ? 503 : errorMsg.includes("429") ? 429 : undefined);
      const errorStatus = error.status || parsedApiError?.error?.status || (errorCode === 499 ? "CANCELLED" : errorCode === 504 ? "DEADLINE_EXCEEDED" : errorCode === 503 ? "UNAVAILABLE" : errorCode === 429 ? "RESOURCE_EXHAUSTED" : "");

      const isUnavailable = errorMsg.includes("503") ||
                            errorStatus === "UNAVAILABLE" ||
                            errorCode === 503 ||
                            errorMsg.toLowerCase().includes("unavailable") ||
                            errorMsg.toLowerCase().includes("high demand") ||
                            errorMsg.toLowerCase().includes("spikes in demand");

      const isDeadlineOrCancelled = errorMsg.includes("504") ||
                                    errorMsg.includes("499") ||
                                    errorStatus === "DEADLINE_EXCEEDED" ||
                                    errorStatus === "CANCELLED" ||
                                    errorCode === 504 ||
                                    errorCode === 499 ||
                                    errorMsg.toLowerCase().includes("deadline expired") ||
                                    errorMsg.toLowerCase().includes("operation was cancelled");

      // Check if it is a true daily quota exhaustion
      const isDailyQuotaExceeded = checkIsDailyQuotaExceeded(errorMsg, errorCode, errorStatus);

      // If it's a transient 503 high-demand spike or 504 deadline, wait briefly and retry on the same model
      if ((isUnavailable || isDeadlineOrCancelled) && attempt < maxAttemptsForModel) {
        const jitter = Math.floor(Math.random() * 400);
        const delayMs = (attempt * 1200) + jitter;
        console.warn(`[Gemini Router] Model ${targetModel} attempt ${attempt}/${maxAttemptsForModel} hit ${isUnavailable ? "503 High Demand" : "504 Deadline"}. Retrying in ${delayMs}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      // If daily quota is exhausted for this specific model, break to allow routing to other available models
      if (isDailyQuotaExceeded) {
        console.warn(`[Gemini Router] Model ${targetModel} reached model-specific quota limit. Checking alternate models...`);
        break;
      }

      break;
    }
  }

  // Model failover logic: route to another untried model if available
  const nextModel = ACTIVE_MODELS_ORDER.find(m => !triedModels.includes(m));
  if (nextModel && maxModelAttempts > 1) {
    let failReason = "error";
    if (lastError?.message) {
      try {
        const parsed = JSON.parse(lastError.message);
        failReason = parsed?.error?.message ? parsed.error.message.slice(0, 50) : lastError.message.slice(0, 50);
      } catch (_) {
        failReason = lastError.message.slice(0, 50);
      }
    }
    console.warn(`[Gemini Router] Model ${targetModel} hit (${failReason}). Routing to available model: ${nextModel}...`);
    params.model = nextModel;
    return generateContentWithRetry(ai, params, maxModelAttempts - 1, triedModels, hasCustomApiKey);
  }

  throw lastError;
}

// Helper to parse timecode (e.g. "00:01:20,000 --> 00:01:23,500") and return duration in seconds
function calculateDurationInSeconds(timecode?: string): number {
  if (!timecode) return 3.0;
  try {
    const parts = timecode.split("-->");
    if (parts.length !== 2) return 3.0;
    
    const parseTime = (str: string): number => {
      const cleanStr = str.trim().replace(",", ".");
      const hmsParts = cleanStr.split(":");
      if (hmsParts.length !== 3) return 0;
      const hrs = parseFloat(hmsParts[0]);
      const mins = parseFloat(hmsParts[1]);
      const secs = parseFloat(hmsParts[2]);
      return hrs * 3600 + mins * 60 + secs;
    };
    
    const start = parseTime(parts[0]);
    const end = parseTime(parts[1]);
    const duration = Math.max(0.5, end - start);
    return Math.round(duration * 10) / 10;
  } catch (e) {
    return 3.0;
  }
}

const KHMER_DIGIT_WORDS = ["សូន្យ", "មួយ", "ពីរ", "បី", "បួន", "ប្រាំ", "ប្រាំមួយ", "ប្រាំពីរ", "ប្រាំបី", "ប្រាំបួន"];
const KHMER_TENS_WORDS = ["", "ដប់", "ម្ភៃ", "សាមសិប", "សែសិប", "ហាសិប", "ហុកសិប", "ចិតសិប", "ប៉ែតសិប", "កៅសិប"];

function convertIntegerToKhmerWords(n: bigint | number): string {
  let val = typeof n === "bigint" ? n : BigInt(Math.floor(n));
  if (val === 0n) return "";
  let res = "";

  if (val >= 100000n) {
    const saen = val / 100000n;
    val = val % 100000n;
    res += KHMER_DIGIT_WORDS[Number(saen)] + "សែន";
  }
  if (val >= 10000n) {
    const moeun = val / 10000n;
    val = val % 10000n;
    res += KHMER_DIGIT_WORDS[Number(moeun)] + "ម៉ឺន";
  }
  if (val >= 1000n) {
    const poan = val / 1000n;
    val = val % 1000n;
    res += KHMER_DIGIT_WORDS[Number(poan)] + "ពាន់";
  }
  if (val >= 100n) {
    const roy = val / 100n;
    val = val % 100n;
    res += KHMER_DIGIT_WORDS[Number(roy)] + "រយ";
  }
  if (val > 0n) {
    const rem = Number(val);
    if (rem < 10) {
      res += KHMER_DIGIT_WORDS[rem];
    } else if (rem < 20) {
      res += "ដប់" + (rem > 10 ? KHMER_DIGIT_WORDS[rem - 10] : "");
    } else {
      const t = Math.floor(rem / 10);
      const d = rem % 10;
      res += KHMER_TENS_WORDS[t] + (d > 0 ? KHMER_DIGIT_WORDS[d] : "");
    }
  }
  return res;
}

/**
 * Translates amount numbers into natural Khmer sentence alphabet words:
 * Example: 100000 -> មួយសែន
 * Example: 1000000 -> មួយលាន
 * Example: 10000000 -> ដប់លាន
 * Example: 100000000 -> មួយរយលាន
 * Example: 1000000000 -> មួយពាន់លាន
 * Example: 10000000000 -> ដប់ពាន់លាន
 * Example: 50000 -> ប្រាំម៉ឺន
 * Example: 500000 -> ប្រាំសែន
 */
function numberToKhmerWords(numStr: string): string {
  // Convert any Khmer digits to Arabic digits first
  const khmerDigitsMap: Record<string, string> = {
    "០": "0", "១": "1", "២": "2", "៣": "3", "៤": "4",
    "៥": "5", "៦": "6", "៧": "7", "៨": "8", "៩": "9"
  };
  let clean = numStr.replace(/[\u17e0-\u17e9]/g, (ch) => khmerDigitsMap[ch] || ch);
  clean = clean.replace(/[,.]/g, "").trim();
  if (!clean || !/^\d+$/.test(clean)) return numStr;

  const num = BigInt(clean);
  if (num === 0n) return "សូន្យ";

  const ONE_MILLION = 1000000n;
  if (num >= ONE_MILLION) {
    const millions = num / ONE_MILLION;
    const remainder = num % ONE_MILLION;
    let millionPart = "";
    if (millions >= 1000n) {
      const thousandsOfMillions = millions / 1000n;
      const remThousands = millions % 1000n;
      millionPart = convertIntegerToKhmerWords(thousandsOfMillions) + "ពាន់";
      if (remThousands > 0n) {
        millionPart += convertIntegerToKhmerWords(remThousands);
      }
      millionPart += "លាន";
    } else {
      millionPart = convertIntegerToKhmerWords(millions) + "លាន";
    }
    if (remainder > 0n) {
      return millionPart + " " + convertIntegerToKhmerWords(remainder);
    }
    return millionPart;
  }

  return convertIntegerToKhmerWords(num);
}

/**
 * Replaces amount numbers in sentence with Khmer alphabet words:
 * Example: "100000" -> "មួយសែន"
 * Example: "100,000,000" -> "មួយរយលាន"
 * Example: "1,000,000" -> "មួយលាន"
 * Example: "10,000,000" -> "ដប់លាន"
 * Example: "1,000,000,000" -> "មួយពាន់លាន"
 * Example: "10,000,000,000" -> "ដប់ពាន់លាន"
 */
function convertSentenceAmountsToKhmerWords(text: string): string {
  if (!text) return "";
  let res = text;

  // Match numbers (with commas or plain digits, e.g. 100,000,000 or 100000 or 50000 or 10000)
  res = res.replace(/(?<![a-zA-Z\d])(\d{1,3}(?:,\d{3})+|\d{4,})(?![a-zA-Z\d])/g, (match) => {
    return numberToKhmerWords(match);
  });

  // Also match Khmer numeral amounts (e.g. ១០០០០០ or ១០០,០០០,០០០)
  res = res.replace(/(?<![\u1780-\u17ff\w])([\u17e0-\u17e9]{1,3}(?:,[\u17e0-\u17e9]{3})+|[\u17e0-\u17e9]{4,})(?![\u1780-\u17ff\w])/g, (match) => {
    return numberToKhmerWords(match);
  });

  return res;
}

// Helper to sanitize Khmer text and map known Thai/Lao-influenced words/calques, typos, and leftover Chinese measure words
function sanitizeKhmerText(text: string): string {
  if (!text) return "";
  
  let cleaned = text;

  // 0. Remove ellipses and variations of dot trailers ("...", "…", "....", "( ... )", "（…）", etc.)
  // per user request: "remove the sentence have this sign ( ... ) / remove this sign ( ... ) on the sentence"
  cleaned = cleaned.replace(/\(\s*\.{2,}\s*\)/g, ""); // "( ... )", "(...)"
  cleaned = cleaned.replace(/\(\s*…+\s*\)/g, "");     // "( … )"
  cleaned = cleaned.replace(/（\s*\.{2,}\s*）/g, ""); // "（ ... ）" full-width
  cleaned = cleaned.replace(/（\s*…+\s*）/g, "");     // "（ … ）" full-width
  cleaned = cleaned.replace(/\.{2,}/g, "");          // "..." or ".." or "...."
  cleaned = cleaned.replace(/…+/g, "");              // unicode horizontal ellipsis "…"
  cleaned = cleaned.replace(/·{2,}/g, "");           // double middle dots "··"
  // Clean up any double spaces created by removing ellipsis
  cleaned = cleaned.replace(/[ \t]{2,}/g, " ").trim();

  // 0.1. Remove any accidental stray foreign scripts and characters
  // Fix specific Myanmar / Burmese leaks (e.g., 'ခរុ' / 'ခရុ' = spiral/snail/corrugation leaked from 螺纹 / 螺纹管 / 波纹管)
  cleaned = cleaned.replace(/ခរុ\s*បំពង់|ခរុ\s*បំពង់/g, "បំពង់គូទខ្យង");
  cleaned = cleaned.replace(/បំពង់\s*ခរុ|បំពង់\s*ခរុ/g, "បំពង់គូទខ្យង");
  cleaned = cleaned.replace(/ခរុ|ခរុ/g, "គូទខ្យង");

  // Fix specific Arabic leaks (e.g., Arabic 'ـینگ' leaked from Chinese Pinyin 'ying' / 元婴 / 莹 / 颖)
  cleaned = cleaned.replace(/អុ?[ـ\s]*[یي]نگ/g, "អ៊ិង");
  cleaned = cleaned.replace(/[ـ\s]*[یي]نگ/g, "យីង");

  // Fix common colloquial / transcription slips
  cleaned = cleaned.replace(/នេះដែ(\s+)/g, "នេះដែរ$1");

  // Remove stray Myanmar (\u1000-\u109f, \ua9e0-\ua9fe),
  // Arabic (\u0600-\u06ff, \u0750-\u077f, \u08a0-\u08ff, \ufb50-\ufdff, \ufe70-\ufeff),
  // Thai (\u0e00-\u0e7f), Lao (\u0e80-\u0eff), Cyrillic (\u0400-\u04ff), Devanagari (\u0900-\u097f)
  cleaned = cleaned.replace(/[\u1000-\u109f\ua9e0-\ua9fe\u0e00-\u0e7f\u0e80-\u0eff\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff\u0400-\u04ff\u0900-\u097f]/g, "");

  // Clean orphan Khmer vowels or subscript coengs left behind without a base consonant
  cleaned = cleaned.replace(/(^|\s)[្\u17b6-\u17d1]+/g, "$1");
  cleaned = cleaned.replace(/[ \t]{2,}/g, " ").trim();

  // 1. Map known Thai/Lao calques and false friends to genuine Khmer vocabulary
  // "Crocodile" / "鳄鱼" / "鱷魚" -> "ក្រពេី" (NEVER "ត្រីក្រពើ")
  cleaned = cleaned.replace(/ស្បែកត្រីក្រពើ/g, "ស្បែកក្រពេី");
  cleaned = cleaned.replace(/ស្បែកត្រីក្រពេី/g, "ស្បែកក្រពេី");
  cleaned = cleaned.replace(/កូនត្រីក្រពើ/g, "កូនក្រពេី");
  cleaned = cleaned.replace(/កូនត្រីក្រពេី/g, "កូនក្រពេី");
  cleaned = cleaned.replace(/សត្វត្រីក្រពើ/g, "សត្វក្រពេី");
  cleaned = cleaned.replace(/សត្វត្រីក្រពេី/g, "សត្វក្រពេី");
  cleaned = cleaned.replace(/បឹងត្រីក្រពើ/g, "បឹងក្រពេី");
  cleaned = cleaned.replace(/បឹងត្រីក្រពេី/g, "បឹងក្រពេី");
  cleaned = cleaned.replace(/ត្រីក្រពើ/g, "ក្រពេី");
  cleaned = cleaned.replace(/ត្រីក្រពេី/g, "ក្រពេី");

  // "出现幻觉 / 幻觉" -> "ឃើញរវើរវាយ" / "ភាន់ភ្នែក" / "ស្រវាំងភ្នែក" (NEVER Thai/Lao "ภาพหลอน" -> "ភាពលង" / "ឃាបលង")
  cleaned = cleaned.replace(/ឃើញភាពលងបែបនេះ/g, "ឃើញរវើរវាយបែបនេះ");
  cleaned = cleaned.replace(/ឃើញភាពលង/g, "ឃើញរវើរវាយ");
  cleaned = cleaned.replace(/ភាពលងបែបនេះ/g, "ការរវើរវាយបែបនេះ");
  cleaned = cleaned.replace(/ភាពលង/g, "ការរវើរវាយ");
  cleaned = cleaned.replace(/ឃាបលង/g, "រវើរវាយ");
  cleaned = cleaned.replace(/យាបលង/g, "រវើរវាយ");
  cleaned = cleaned.replace(/ភាន់ភាពលង/g, "ភាន់ភ្នែក");
  cleaned = cleaned.replace(/រូបភាពលង/g, "រូបភាពរវើរវាយ");

  // 2. Map known Thai-influenced loanwords or minor transliteration slips
  cleaned = cleaned.replace(/ឡៃខ្ញុំចេញ/g, "ដេញខ្ញុំចេញ");
  cleaned = cleaned.replace(/ឡៃចេញ/g, "ដេញចេញ");
  cleaned = cleaned.replace(/េលីយងបាយ/g, "លៀងបាយ");
  cleaned = cleaned.replace(/លេីយងបាយ/g, "លៀងបាយ");
  cleaned = cleaned.replace(/លៃយងបាយ/g, "លៀងបាយ");
  cleaned = cleaned.replace(/លីយ៉ង់បាយ/g, "លៀងបាយ");
  cleaned = cleaned.replace(/េលីយង/g, "លៀង");
  cleaned = cleaned.replace(/លេីយង/g, "លៀង");
  cleaned = cleaned.replace(/លៃយង/g, "លៀង");
  cleaned = cleaned.replace(/លីយ៉ង់/g, "លៀង");
  cleaned = cleaned.replace(/លៃខ្ញុំចេញ/g, "ដេញខ្ញុំចេញ");
  cleaned = cleaned.replace(/លៃចេញ/g, "ដេញចេញ");
  cleaned = cleaned.replace(/ឌូអែល/g, "មើលថែ");
  cleaned = cleaned.replace(/ហួងហែង/g, "ព្រួយបារម្ភ");
  cleaned = cleaned.replace(/ស្វាយស្អាត/g, "ស្រស់ស្អាត");

  // 3. First-person pronoun guardrails: NEVER use "អញ" or "អញ់" for "I/me/我"
  // Map angry phrases to "យើង" and standard phrases to "ខ្ញុំ"
  cleaned = cleaned.replace(/អញប្រាប់/g, "យើងប្រាប់");
  cleaned = cleaned.replace(/អញសម្លាប់/g, "យើងសម្លាប់");
  cleaned = cleaned.replace(/អញកាប់/g, "យើងកាប់");
  cleaned = cleaned.replace(/អញវាយ/g, "យើងវាយ");
  cleaned = cleaned.replace(/អញនឹង/g, "យើងនឹង");
  cleaned = cleaned.replace(/អញមិន/g, "យើងមិន");
  cleaned = cleaned.replace(/អញថា/g, "យើងថា");
  cleaned = cleaned.replace(/ស្គាល់អញ/g, "ស្គាល់យើង");
  cleaned = cleaned.replace(/ខ្លាចអញ/g, "ខ្លាចយើង");
  cleaned = cleaned.replace(/ឱ្យអញ/g, "ឱ្យខ្ញុំ");
  cleaned = cleaned.replace(/ឲ្យអញ/g, "ឲ្យខ្ញុំ");
  cleaned = cleaned.replace(/ពីអញ/g, "ពីខ្ញុំ");
  cleaned = cleaned.replace(/លើអញ/g, "លើខ្ញុំ");
  cleaned = cleaned.replace(/ជួយអញ/g, "ជួយខ្ញុំ");
  cleaned = cleaned.replace(/អញ់/g, "យើង");
  cleaned = cleaned.replace(/អញ/g, "ខ្ញុំ");

  // 5. Third-person pronoun guardrails: Block bare "នាង" for third-person pronouns (he/she/him/her/他/她)
  // to prevent male-female confusion and misgendering. Translate to "គាត់" (or "គេ") while preserving
  // valid compounds like "អ្នកនាង", "លោកស្រី", "បងស្រី", "ប្អូនស្រី", "ក្មេងស្រី", "នាងមច្ឆា".
  cleaned = cleaned.replace(/(^|[\s,!?។៕(])នាង(?=[\s,!?។៕)]|$)/g, "$1គាត់");
  cleaned = cleaned.replace(/(^|[\s,!?។៕(])នាងបាន/g, "$1គាត់បាន");
  cleaned = cleaned.replace(/(^|[\s,!?។៕(])នាងមិន/g, "$1គាត់មិន");
  cleaned = cleaned.replace(/(^|[\s,!?។៕(])នាងនឹង/g, "$1គាត់នឹង");
  cleaned = cleaned.replace(/(^|[\s,!?។៕(])នាងថា/g, "$1គាត់ថា");
  cleaned = cleaned.replace(/(^|[\s,!?។៕(])នាងទៅ/g, "$1គាត់ទៅ");
  cleaned = cleaned.replace(/(^|[\s,!?។៕(])នាងមក/g, "$1គាត់មក");
  cleaned = cleaned.replace(/(^|[\s,!?។៕(])នាងនៅ/g, "$1គាត់នៅ");
  cleaned = cleaned.replace(/(^|[\s,!?។៕(])នាងគឺ/g, "$1គាត់គឺ");
  cleaned = cleaned.replace(/(^|[\s,!?។៕(])នាងត្រូវ/g, "$1គាត់ត្រូវ");
  cleaned = cleaned.replace(/(^|[\s,!?។៕(])នាងជា/g, "$1គាត់ជា");
  cleaned = cleaned.replace(/(^|[\s,!?។៕(])នាងចង់/g, "$1គាត់ចង់");
  cleaned = cleaned.replace(/(^|[\s,!?។៕(])នាងដឹង/g, "$1គាត់ដឹង");
  cleaned = cleaned.replace(/(^|[\s,!?។៕(])នាងអាច/g, "$1គាត់អាច");
  cleaned = cleaned.replace(/(^|[\s,!?។៕(])នាងមាន/g, "$1គាត់មាន");
  cleaned = cleaned.replace(/(^|[\s,!?។៕(])នាងនិយាយ/g, "$1គាត់និយាយ");
  cleaned = cleaned.replace(/(^|[\s,!?។៕(])នាងឃើញ/g, "$1គាត់ឃើញ");
  cleaned = cleaned.replace(/(^|[\s,!?។៕(])នាងឮ/g, "$1គាត់ឮ");
  cleaned = cleaned.replace(/(^|[\s,!?។៕(])នាងសួរ/g, "$1គាត់សួរ");
  cleaned = cleaned.replace(/របស់នាង/g, "របស់គាត់");
  cleaned = cleaned.replace(/ពីនាង/g, "ពីគាត់");
  cleaned = cleaned.replace(/លើនាង/g, "លើគាត់");
  cleaned = cleaned.replace(/ឱ្យនាង/g, "ឱ្យគាត់");
  cleaned = cleaned.replace(/ឲ្យនាង/g, "ឲ្យគាត់");
  cleaned = cleaned.replace(/ជាមួយនាង/g, "ជាមួយគាត់");
  cleaned = cleaned.replace(/ប្រាប់នាង/g, "ប្រាប់គាត់");
  cleaned = cleaned.replace(/ជួយនាង/g, "ជួយគាត់");
  cleaned = cleaned.replace(/សម្លាប់នាង/g, "សម្លាប់គាត់");
  cleaned = cleaned.replace(/ស្រឡាញ់នាង/g, "ស្រឡាញ់គាត់");
  cleaned = cleaned.replace(/ឃើញនាង/g, "ឃើញគាត់");
  cleaned = cleaned.replace(/ស្គាល់នាង/g, "ស្គាល់គាត់");
  cleaned = cleaned.replace(/ដឹងថានាង/g, "ដឹងថាគាត់");
  cleaned = cleaned.replace(/ថានាង/g, "ថាគាត់");
  cleaned = cleaned.replace(/ចំពោះនាង/g, "ចំពោះគាត់");

  // 6. Post-mapping for Chinese action classifiers / verbal measure words (like "一顿", "顿")
  // that might leak into Khmer text (e.g., "វាយមួយ顿" -> "វាយមួយប្រាវ" / "វាយមួយដៃ"):
  cleaned = cleaned.replace(/ត្រូវគេវាយមួយ顿/g, "ត្រូវគេវាយមួយប្រាវ");
  cleaned = cleaned.replace(/ត្រូវវាយមួយ顿/g, "ត្រូវវាយមួយប្រាវ");
  cleaned = cleaned.replace(/វាយមួយ顿/g, "វាយមួយប្រាវ");
  cleaned = cleaned.replace(/វាយ១顿/g, "វាយមួយប្រាវ");
  cleaned = cleaned.replace(/វាយ顿/g, "វាយមួយប្រាវ");
  cleaned = cleaned.replace(/ជេរមួយ顿/g, "ជេរមួយប្រាវ");
  cleaned = cleaned.replace(/ជេរ顿/g, "ជេរមួយប្រាវ");
  cleaned = cleaned.replace(/ស្តីមួយ顿/g, "ស្តីឱ្យមួយប្រាវ");
  cleaned = cleaned.replace(/ស្តីបន្ទោសមួយ顿/g, "ស្តីបន្ទោសមួយប្រាវ");
  cleaned = cleaned.replace(/ហូបមួយ顿/g, "ហូបមួយពេល");
  cleaned = cleaned.replace(/ញ៉ាំមួយ顿/g, "ញ៉ាំមួយពេល");
  cleaned = cleaned.replace(/បាយមួយ顿/g, "បាយមួយពេល");
  cleaned = cleaned.replace(/មួយ顿/g, "មួយប្រាវ");
  cleaned = cleaned.replace(/១顿/g, "មួយប្រាវ");
  cleaned = cleaned.replace(/一顿/g, "មួយប្រាវ");
  cleaned = cleaned.replace(/顿/g, "មួយប្រាវ");

  // Other common action classifiers that could leak:
  cleaned = cleaned.replace(/មួយ趟/g, "មួយជើង");
  cleaned = cleaned.replace(/一趟/g, "មួយជើង");
  cleaned = cleaned.replace(/趟/g, "មួយជើង");
  cleaned = cleaned.replace(/មួយ场/g, "មួយប្រកួត");
  cleaned = cleaned.replace(/一场/g, "មួយប្រកួត");
  cleaned = cleaned.replace(/មួយ番/g, "មួយឈុត");
  cleaned = cleaned.replace(/一番/g, "មួយឈុត");
  cleaned = cleaned.replace(/មួយ阵/g, "មួយស្របក់");
  cleaned = cleaned.replace(/一阵/g, "មួយស្របក់");
  cleaned = cleaned.replace(/មួយ遍/g, "មួយលើក");
  cleaned = cleaned.replace(/一遍/g, "មួយលើក");
  cleaned = cleaned.replace(/មួយ次/g, "ម្តង");
  cleaned = cleaned.replace(/一次/g, "ម្តង");

  // 7. Format numbers & amounts: translate to Khmer alphabet words (e.g. 100000 -> មួយសែន, 100000000 -> មួយរយលាន)
  cleaned = convertSentenceAmountsToKhmerWords(cleaned);

  return cleaned;
}

/**
 * Intelligent Kinship Alignment Helper
 * Enforces strict distinction between Husband (ស្វាមី/ប្ដី) and Brother-in-Law (បងថ្លៃ/ប្អូនថ្លៃ)
 * based on standard Chinese kinship terms.
 */
function alignKinshipTerms(khmerText: string, sourceChinese: string): string {
  if (!khmerText || !sourceChinese) return khmerText;

  let result = khmerText;

  // Source Chinese markers
  const hasHusbandTerm = /(丈夫|老公|夫君|相公)/.test(sourceChinese);
  const hasSisterHusbandElder = /姐夫/.test(sourceChinese);
  const hasSisterHusbandYounger = /妹夫/.test(sourceChinese);
  const hasWifeHusbandBrotherElder = /(大舅子|大舅哥|大伯子|大伯哥)/.test(sourceChinese);
  const hasWifeHusbandBrotherYounger = /(小叔子|小叔|小舅子|小舅)/.test(sourceChinese);
  const hasBrotherInLawTerm = hasSisterHusbandElder || hasSisterHusbandYounger || hasWifeHusbandBrotherElder || hasWifeHusbandBrotherYounger;

  // Case A: Source Chinese is explicitly HUSBAND (丈夫, 老公, 夫君, 相公) and NOT brother-in-law
  // If translation mistakenly output brother-in-law (បងថ្លៃ / ប្អូនថ្លៃ), correct it to husband
  if (hasHusbandTerm && !hasBrotherInLawTerm) {
    if (/បងថ្លៃ|ប្អូនថ្លៃ/.test(result)) {
      const preferred = /丈夫|夫君/.test(sourceChinese) ? "ស្វាមី" : "ប្ដី";
      result = result.replace(/បងថ្លៃខ្ញុំ/g, `${preferred}ខ្ញុំ`);
      result = result.replace(/ប្អូនថ្លៃខ្ញុំ/g, `${preferred}ខ្ញុំ`);
      result = result.replace(/បងថ្លៃរបស់ខ្ញុំ/g, `${preferred}របស់ខ្ញុំ`);
      result = result.replace(/ប្អូនថ្លៃរបស់ខ្ញុំ/g, `${preferred}របស់ខ្ញុំ`);
      result = result.replace(/បងថ្លៃ/g, preferred);
      result = result.replace(/ប្អូនថ្លៃ/g, preferred);
    }
  }

  // Case B: Source Chinese is explicitly BROTHER-IN-LAW (姐夫, 妹夫, 大舅子, 小叔子, etc.) and NOT husband
  // If translation mistakenly output husband (ប្ដី / ស្វាមី), correct it to brother-in-law
  if (hasBrotherInLawTerm && !hasHusbandTerm) {
    if (/ប្ដី|ប្តី|ស្វាមី/.test(result)) {
      const inLawTerm = (hasSisterHusbandYounger || hasWifeHusbandBrotherYounger) ? "ប្អូនថ្លៃ" : "បងថ្លៃ";
      result = result.replace(/ប្ដីខ្ញុំ/g, `${inLawTerm}ខ្ញុំ`);
      result = result.replace(/ប្តីខ្ញុំ/g, `${inLawTerm}ខ្ញុំ`);
      result = result.replace(/ស្វាមីខ្ញុំ/g, `${inLawTerm}ខ្ញុំ`);
      result = result.replace(/ប្ដីរបស់ខ្ញុំ/g, `${inLawTerm}របស់ខ្ញុំ`);
      result = result.replace(/ប្តីរបស់ខ្ញុំ/g, `${inLawTerm}របស់ខ្ញុំ`);
      result = result.replace(/ស្វាមីរបស់ខ្ញុំ/g, `${inLawTerm}របស់ខ្ញុំ`);
      result = result.replace(/ប្ដីសម្លាញ់/g, inLawTerm);
      result = result.replace(/ប្តីសម្លាញ់/g, inLawTerm);
      result = result.replace(/ប្ដី/g, inLawTerm);
      result = result.replace(/ប្តី/g, inLawTerm);
      result = result.replace(/ស្វាមី/g, inLawTerm);
    }
  }

  // Case C: Crocodile / 鳄鱼 / 鱷魚 -> ក្រពេី
  const hasCrocodileTerm = /(鳄鱼|鱷魚)/.test(sourceChinese) || /\b(crocodile|alligators?)\b/i.test(sourceChinese);
  if (hasCrocodileTerm) {
    // Replace fish calques ("ត្រីក្រពើ" / "ត្រីក្រពេី") with "ក្រពេី"
    result = result.replace(/ត្រីក្រពើ/g, "ក្រពេី").replace(/ត្រីក្រពេី/g, "ក្រពេី");
    // Normalize to user-preferred spelling "ក្រពេី"
    result = result.replace(/ក្រពើ/g, "ក្រពេី");
    // If source line is purely "Crocodile", "鳄鱼", or "鱷魚"
    const trimmedSource = sourceChinese.trim();
    if (/^(鳄鱼|鱷魚|crocodile|alligator)[.!?\s]*$/i.test(trimmedSource)) {
      if (!result || /^(鳄鱼|鱷魚|crocodile|alligator)$/i.test(result.trim()) || result.includes("ត្រី")) {
        result = "ក្រពេី";
      }
    }
  }

  // Case D: Clean Arabic / foreign script leaks (e.g. 'ـینگ' leaked from Chinese Pinyin 'ying')
  if (/[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff]/.test(result)) {
    result = result.replace(/អុ?[ـ\s]*[یي]نگ/g, "អ៊ិង").replace(/[ـ\s]*[یي]نگ/g, "យីង");
    result = result.replace(/[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff]/g, "");
  }

  return result;
}

/**
 * Resilient JSON parser for LLM outputs.
 * Recovers from truncated responses, unterminated strings, missing closing brackets,
 * unescaped control characters, and markdown formatting.
 */
function safeParseJsonArray(jsonStr: string): Array<{ index: number; translatedText: string; shortenedText?: string }> {
  if (!jsonStr || typeof jsonStr !== "string") return [];
  
  let cleaned = jsonStr.trim();
  
  // Strip Markdown code blocks if present
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }

  const mapItem = (item: any) => {
    const textVal = String(item.translatedText || item.shortenedText || item.text || "");
    const shortVal = item.shortenedText ? String(item.shortenedText) : textVal;
    return {
      index: item.index !== undefined ? Number(item.index) : 0,
      translatedText: textVal,
      shortenedText: shortVal
    };
  };

  // Tier 1: Standard JSON parse
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((item) => item !== null && typeof item === "object")
        .map(mapItem);
    }
    if (parsed && typeof parsed === "object") {
      const possibleArray = (parsed as any).translations || 
                            (parsed as any).results ||
                            (parsed as any).items || 
                            (parsed as any).data || 
                            Object.values(parsed).find((val) => Array.isArray(val));
      if (Array.isArray(possibleArray)) {
        return possibleArray
          .filter((item) => item !== null && typeof item === "object")
          .map(mapItem);
      }
      if (parsed.index !== undefined) {
        return [mapItem(parsed)];
      }
    }
  } catch (e) {
    // Normal JSON parse failed (e.g. unterminated string or cut-off payload)
  }

  // Tier 2: Truncation Repair (Find last complete object and close array)
  try {
    let repaired = cleaned;
    const lastOpenBrace = repaired.lastIndexOf("{");
    const lastCloseBrace = repaired.lastIndexOf("}");

    // If there is an unclosed object at the end
    if (lastOpenBrace > lastCloseBrace) {
      repaired = repaired.substring(0, lastOpenBrace).trim();
      if (repaired.endsWith(",")) {
        repaired = repaired.substring(0, repaired.length - 1).trim();
      }
    }

    if (!repaired.endsWith("]")) {
      repaired += "]";
    }
    if (!repaired.startsWith("[")) {
      const firstBracket = repaired.indexOf("[");
      if (firstBracket !== -1) {
        repaired = repaired.substring(firstBracket);
      } else {
        repaired = "[" + repaired;
      }
    }

    const parsed = JSON.parse(repaired);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((item) => item !== null && typeof item === "object")
        .map(mapItem);
    }
  } catch (e) {
    // Repair failed, proceed to Tier 3 Regex extraction
  }

  // Tier 3: Regex-based extraction of valid {"index": ..., "translatedText"|"shortenedText": "..."} blocks
  const results: Array<{ index: number; translatedText: string; shortenedText?: string }> = [];
  const seenIndexes = new Set<number>();

  // Pattern A: {"index": 123, "translatedText"|"shortenedText": "..."}
  const objRegexA = /\{\s*"index"\s*:\s*(\d+)\s*,\s*"(?:translatedText|shortenedText)"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g;
  let match: RegExpExecArray | null;
  while ((match = objRegexA.exec(cleaned)) !== null) {
    try {
      const idx = parseInt(match[1], 10);
      let txt = match[2];
      try {
        txt = JSON.parse(`"${match[2]}"`);
      } catch (_) {}
      if (!seenIndexes.has(idx)) {
        seenIndexes.add(idx);
        results.push({ index: idx, translatedText: txt, shortenedText: txt });
      }
    } catch (_) {}
  }

  // Pattern B: {"translatedText"|"shortenedText": "...", "index": 123}
  const objRegexB = /\{\s*"(?:translatedText|shortenedText)"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"index"\s*:\s*(\d+)\s*\}/g;
  while ((match = objRegexB.exec(cleaned)) !== null) {
    try {
      const idx = parseInt(match[2], 10);
      let txt = match[1];
      try {
        txt = JSON.parse(`"${match[1]}"`);
      } catch (_) {}
      if (!seenIndexes.has(idx)) {
        seenIndexes.add(idx);
        results.push({ index: idx, translatedText: txt, shortenedText: txt });
      }
    } catch (_) {}
  }

  // Tier 4: Fallback for partially broken or unescaped strings
  if (results.length === 0) {
    const chunkRegex = /"index"\s*:\s*(\d+)[^}]*?"translatedText"\s*:\s*"([^"\r\n]*)"/g;
    while ((match = chunkRegex.exec(cleaned)) !== null) {
      const idx = parseInt(match[1], 10);
      if (!seenIndexes.has(idx)) {
        seenIndexes.add(idx);
        results.push({ index: idx, translatedText: match[2] });
      }
    }
  }

  return results;
}

// AI-Assisted Auto-healing of translated blocks that contain Thai script, leftover Chinese characters, or empty/untranslated results
async function healTranslationsWithAI(
  ai: any,
  model: string,
  failedBlocks: any[],
  styleDescription: string,
  userApiKey?: string
): Promise<Record<number, string>> {
  const systemInstruction = `You are an expert, highly skilled translator specializing in translating text from Chinese to Khmer.
Your absolute, non-negotiable priority is to ensure the output is 100% entirely in the Khmer language.
CRITICAL GUARDRAIL: Under no circumstances should you mix foreign scripts into the translation. Absolutely zero Myanmar/Burmese script (မြန်မာစာ \\u1000-\\u109f, \\ua9e0-\\ua9fe like 'ခ', 'ရ', 'ခရု'), Thai words or script (ภาษาไทย \\u0e00-\\u0e7f), Lao words or script (ພາສາລາວ \\u0e80-\\u0eff), Arabic script (العربية / فارسی / ئۇيغۇرចែ like 'ـینگ', 'ی', 'ن', 'گ' or ranges \\u0600-\\u06ff), Cyrillic, or any non-Khmer characters are allowed. The output MUST be 100% pure genuine Khmer script (អក្សរខ្មែរ). Chinese terms/names ending in 'Ying' / 'Ing' (such as 元婴, 顾蓝莹, 阿英, 颖) MUST be transliterated into Khmer script (e.g. 'យីង', 'អ៊ិង', 'អុីង'), NEVER Arabic script ('ـینگ').

DISTINCT KHMER VOCABULARY (STRICTLY PROHIBIT LAO/THAI CALQUES & FALSE FRIENDS):
- "螺纹 / 螺旋 / 波纹" (screw / spiral / corrugated / thread): Translate into Khmer as "គូទខ្យង", "រាងគូទខ្យង", "វីស", or "រាងរង្វង់". NEVER use Burmese "ခရု" or foreign words.
- "螺纹管 / 波纹管 / 螺旋管" (corrugated pipe / spiral pipe): Translate into Khmer as "បំពង់គូទខ្យង" or "បំពង់រាងគូទខ្យង" (e.g., "这是预埋在垫层里的螺纹管" -> "នេះដែរ ជាបំពង់គូទខ្យងដែលបង្កប់ក្នុងទ្រនាប់ផ្លូវ" / "នេះជាបំពង់រាងគូទខ្យងដែលកប់ក្នុងស្រទាប់ទ្រនាប់").
- "垫层 / 路基垫层" (subgrade / cushion layer): Translate as "ទ្រនាប់ផ្លូវ" or "ស្រទាប់ទ្រនាប់".
- "预埋 / 埋入" (embed / embedded): Translate as "បង្កប់" or "បង្កប់ក្នុង" or "កប់ក្នុង".
- "幻觉 / 出现幻觉 / 产生幻 / 幻象" (hallucination / illusion): Translate ONLY as "ឃើញរវើរវាយ", "ភាន់ភ្នែក", "ស្រវាំងភ្នែក", or "កើតអារម្មណ៍រវើរវាយ". NEVER use Lao/Thai "ภาพหลอน/ພາບຫລອນ" calques like "ឃើញភាពលង", "ភាពលង", or "ឃាបលង".
- "没喝几杯 / 喝几杯" (didn't drink much / drank a few glasses): Translate as "ផឹកមិនទាន់បានប៉ុន្មានកែវផង" / "ផឹកប៉ុន្មានកែវ".
- "喝醉 / 醉了" (drunk): Translate as "ស្រវឹង" / "ស្រវឹងស្រា" (NEVER "ស្រវឹងម៉ៅ").
- "清醒 / 醒酒" (sober up / conscious): Translate as "ស្វាង", "ស្វាងស្រវឹង", or "ដឹងខ្លួន".
- "做梦 / 白日梦" (dream): Translate as "យល់សប្តិ", "សុបិន", or "ស្រមើស្រមៃ".
- "驱赶 / 赶走" (chase away / kick out): Translate as "ដេញ" or "ដេញចេញ" (NEVER "ឡៃ" / "លៃ").
- "请客 / 宴席" (treat / banquet): Translate as "លៀង", "ជប់លៀង", "ប៉ាវបាយ" (NEVER "លេីយង" / "លីយ៉ង់").
- "照顾 / 照应" (take care): Translate as "មើលថែ", "ថែរក្សា" (NEVER "ឌូអែល").
- "担心 / 挂念" (worry): Translate as "បារម្ភ", "ព្រួយបារម្ភ", "ព្រួយចិត្ត" (NEVER "កាំងវ៉ុល" / "ហួង").
- "漂亮 / 好看" (beautiful): Translate as "ស្អាត", "ស្រស់ស្អាត" (NEVER "ស្វាយ").
- "容易 / 简单" (easy): Translate as "ងាយស្រួល", "ស្រួល" (NEVER "ងាយងាយ").
- "Crocodile / 鳄鱼 / 鱷魚" (crocodile): MUST ALWAYS translate as "ក្រពេី" (e.g. "鳄鱼" -> "ក្រពេី", "一条鳄鱼" -> "ក្រពេីមួយក្បាល", "鳄鱼皮" -> "ស្បែកក្រពេី", "鳄鱼潭" -> "បឹងក្រពេី"). NEVER translate as "ត្រីក្រពើ" (do NOT translate Chinese "鱼" as fish "ត្រី"), NEVER output Thai ("จระเข้"), and NEVER leave untranslated.

MANDATORY NUMBER & AMOUNT TRANSLATION RULE (MUST TRANSLATE IN KHMER SENTENCE ALPHABET WORDS):
- When translating amounts, money, quantities, prices, counts, or numbers (e.g. 100000, 1000000, 10000000, 100000000, 1000000000, 10000000000, 100,000, 1,000,000, 一亿, 一千万, 两千万, 5000万, 1000万, 十万, 一万, etc.):
- Amounts and numbers MUST ONLY be translated into natural Khmer sentence alphabet words (ពាក្យខ្មែរអក្សរសុទ្ធ):
  * 100,000 / 100000 / 十万 -> MUST translate to "មួយសែន" (e.g., 200,000 -> ពីរសែន, 500,000 -> ប្រាំសែន)
  * 1,000,000 / 1000000 / 一百万 -> MUST translate to "មួយលាន" (e.g., 2,000,000 -> ពីរលាន, 5,000,000 -> ប្រាំលាន)
  * 10,000,000 / 10000000 / 一千万 -> MUST translate to "ដប់លាន" (e.g., 20,000,000 -> ម្ភៃលាន, 50,000,000 -> ហាសិបលាន)
  * 100,000,000 / 100000000 / 一亿 -> MUST translate to "មួយរយលាន" (e.g., 200,000,000 -> ពីររយលាន, 500,000,000 -> ប្រាំរយលាន)
  * 1,000,000,000 / 1000000000 / 十亿 -> MUST translate to "មួយពាន់លាន" (e.g., 2,000,000,000 -> ពីរពាន់លាន)
  * 10,000,000,000 / 10000000000 / 百亿 -> MUST translate to "ដប់ពាន់លាន" (e.g., 20,000,000,000 -> ម្ភៃពាន់លាន)
  * 10,000 / 10000 / 一万 -> "មួយម៉ឺន" (e.g., 50,000 -> ប្រាំម៉ឺន)
  * 1,000 / 1000 / 一千 -> "មួយពាន់"
- CRITICAL: NEVER output raw digits like "100000" or "100,000,000" in subtitles. ALWAYS write them out in natural Khmer words ("មួយសែន", "មួយលាន", "ដប់លាន", "មួយរយលាន", "មួយពាន់លាន", "ដប់ពាន់លាន").

MANDATORY FIRST-PERSON PRONOUN MANDATE FOR "我" (I / ME / MYSELF):
- STRICT PROHIBITION: NEVER translate "我" / "I" / "me" into "អញ" or "អញ់" under ANY circumstances. The words "អញ" and "អញ់" are strictly banned.
- DEFAULT RULE: Translate "我" (I/me) into "ខ្ញុំ" (khnom) for standard conversations, polite dialogue, everyday interaction, and speaking normally.
- ANGRY / FIGHTING / SCOLDING / CONFLICT RULE: When the speaker/character is angry, furious, arguing, yelling, threatening, fighting, or scolding, translate "我" (I/me) into "យើង" (yeung). NEVER use "អញ" or "អញ់".

MANDATORY THIRD-PERSON PRONOUN RULES (STRICT BAN ON BARE "នាង" FOR "他" / "她" / "he" / "she" / "him" / "her"):
- IN CHINESE DRAMA SUBTITLES: "他" (he) and "她" (she) are homophones ("tā") and frequently confused in transcripts. Translating "she/her/她" or "他" to bare "នាង" causes severe gender confusion where male characters or general subjects are incorrectly referred to as "នាង".
- STRICTLY BAN bare standalone "នាង" for third-person pronouns.
- ALWAYS translate third-person pronouns ("他", "她", "he", "she", "him", "her") into gender-safe, universal, natural Khmer:
  * Default & Universal: Always translate as "គាត់" (koat) for all persons (men, women, elders, colleagues, leaders, general 3rd person).
  * Casual / Collective: Use "គេ" (ke).
  * Explicit Female Titles: If referring to a formal or family title, use explicit compound nouns like "អ្នកនាង" (Miss/Ms), "លោកស្រី" (Madam), "បងស្រី" (elder sister), "ប្អូនស្រី" (younger sister), or "ក្មេងស្រី" (young girl), NEVER standalone "នាង".

STRICT RULE: DO NOT TRANSLATE PROPER NAMES (HUMAN, ANIMAL/PET, OR NAMED OBJECTS) LITERALLY:
1. HUMAN NAMES: Transliterate phonetically into Khmer script sound (e.g., "叶凡" -> "យ៉េ ហ្វាន", "林辰" -> "លីន ឆិន", "苏清雪" -> "ស៊ូ ឈីងសៀវ", "顾蓝莹" -> "គូ ឡានយីង", "白飞飞" -> "ប៉ាយ ហ្វីហ្វី"). NEVER translate literal meanings of name characters (e.g. do not translate "叶" to "ស្លឹក" or "凡" to "ធម្មតា").
2. ANIMAL & PET NAMES: Transliterate pet/animal names phonetically as proper nouns (e.g., "大黄" -> "ដាហួង / តាហួង", "小白" -> "ស៊ាវប៉ាយ", "旺财" -> "វ៉ាងឆាយ", "小黑" -> "ស៊ាវហី", "咪咪" -> "មីមី"). NEVER translate animal names literally into adjectives/colors (e.g. NEVER translate "大黄" to "លឿងធំ" or "小白" to "សតូច").
3. NAMED OBJECTS, WEAPONS, PLACES & COMPANIES: Transliterate the specific proper noun phonetically and translate only the category noun (e.g., "天雪集团" -> "ក្រុមហ៊ុន ធានសៀវ", "玄天剑" -> "ដាវ ស្វៀនធាន", "诛仙剑" -> "ដាវ ជូសៀន", "青云宗" -> "និកាយ ឈីងយុន").

NATURAL CONCISENESS & ZERO OMISSION (បង្រួមខ្លីខ្លឹម ច្បាស់លាស់ មិនធ្លាក់ន័យ):
- Chinese subtitles must be translated into concise, punchy, natural Khmer dialogue without wordy bloat or dragging grammatical particles.
- Preserve 100% of the original meaning, clauses, facts, and character emotions without omission, but express them in clean, economical spoken Khmer.
- ELIMINATE WORDY BLOAT & FILLERS: Strip unnecessary padding like 'គឺជា', 'នៅក្នុង', 'ដែលបាន', 'ធ្វើការ', 'មានការ', 'មួយនេះ'. Replace bulky grammatical expansions with direct, expressive phrasing.

CHINESE VERBAL MEASURE WORDS & CLASSIFIERS (量词):
- Subtitle dialogue frequently uses verbal measure words such as "一顿" (打一顿 = វាយមួយដៃ / វាយមួយប្រាវ / វាយមួយឈុត, 骂一顿 = ជេរមួយប្រាវ, 吃一顿 = ញ៉ាំមួយពេល), "一趟" (去一趟 = ទៅមួយជើង), "一场", "一番", "一阵", "一遍".
- NEVER leave Chinese characters (Hanzi like 顿, 趟, 场, 番, 阵) untranslated or mixed in Khmer (e.g. NEVER write "វាយមួយ顿")! Translate the entire phrase naturally into Khmer.

CHINESE ABBREVIATION, SLANG, & SPLIT-LINE DIALOGUE RECOVERY:
- In subtitle scripts, compound words or sentences are often split across adjacent blocks (e.g., Line 1: "和天雪集", Line 2: "团真是走了" -> combined "和天雪集团" = Tianxue Group).
- Drama subtitles contain name contractions (e.g., "许家" = Xu Family / House of Xu), spoken abbreviations, and ASR phonetic typos/homophones.
- Use the provided 'dialogueContext' (Preceding line -> Target line -> Following line) to reconstruct the full phrase and translate every block into 100% natural Khmer script.
- NEVER leave Chinese characters (Hanzi) and NEVER return an empty string.

CRITICAL KINSHIP & RELATION ACCURACY: HUSBAND (ស្វាមី / ប្ដី) VS BROTHER-IN-LAW (បងថ្លៃ / ប្អូនថ្លៃ):
Strictly distinguish between HUSBAND (ស្វាមី/ប្ដី) and BROTHER-IN-LAW (បងថ្លៃ/ប្អូនថ្លៃ):
1. HUSBAND (ប្ដី / ស្វាមី) — One's own spouse:
- "丈夫" (zhàngfu) -> Husband (Formal) -> Always translate as "ស្វាមី" (formal) or "ប្ដី" (everyday standard). NEVER translate as brother-in-law ("បងថ្លៃ" / "ប្អូនថ្លៃ").
- "老公" (lǎogōng) -> Husband (Casual/Affectionate) -> Always translate as "ប្ដី", "ប្ដីសម្លាញ់", or direct address "បង" (darling husband). NEVER translate as brother-in-law ("បងថ្លៃ" / "ប្អូនថ្លៃ").
- "哥哥" (gēge) / "哥" (gē) -> Romantic Pet Name: When used romantically by a wife/girlfriend to her husband/partner, translate as "បង" / "បងសម្លាញ់" / "ប្ដី" (sweetheart / darling husband). NEVER translate as brother-in-law ("បងថ្លៃ" / "ប្អូនថ្លៃ").
- "夫君" (fūjūn) / "相公" (xiànggong) -> Costume Drama Husband -> "ស្វាមី" / "ប្ដី" / "ម្ចាស់បង". NEVER brother-in-law.
2. BROTHER-IN-LAW (បងថ្លៃ / ប្អូនថ្លៃ) — In-law relatives:
- "姐夫" (jiěfu) -> Elder Sister's Husband -> Always translate as "បងថ្លៃ" (Elder brother-in-law). NEVER translate as husband ("ប្ដី" / "ស្វាមី").
- "妹夫" (mèifu) -> Younger Sister's Husband -> Always translate as "ប្អូនថ្លៃ" (Younger brother-in-law). NEVER translate as husband ("ប្ដី" / "ស្វាមី").
- "大舅子" (dàjiùzi) / "大舅哥" / "大伯子" -> Wife's or Husband's Elder Brother -> Always translate as "បងថ្លៃ". NEVER husband ("ប្ដី").
- "小叔子" (xiǎoshūzi) / "小舅子" / "小叔" -> Wife's or Husband's Younger Brother -> Always translate as "ប្អូនថ្លៃ". NEVER husband ("ប្ដី").

${styleDescription ? `TRANSLATION STYLE/GLOSSARY:\n${styleDescription}\n` : ""}
REPAIR MODE: You are given a list of blocks that failed initial translation (e.g. contains leftover Chinese characters like 顿, Thai script, or empty output).
Your task is to repair and translate every single item into clean, natural Khmer script.`;

  const promptText = `Please repair and translate the following blocks into 100% clean Khmer script. Output a JSON array with objects containing "index" and "translatedText".
Input Blocks to Repair:
${JSON.stringify(failedBlocks, null, 2)}`;

  const hasUserApiKey = !!userApiKey;
  const queryParams = {
    model: getHealthyModel(model),
    contents: promptText,
    config: {
      systemInstruction,
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            index: { type: Type.INTEGER },
            translatedText: { type: Type.STRING }
          },
          required: ["index", "translatedText"]
        }
      },
      temperature: 0.1
    }
  };

  const healedMap: Record<number, string> = {};
  try {
    const response = await generateContentWithRetry(ai, queryParams, 2, [], hasUserApiKey);
    const text = response.text;
    if (text) {
      const parsedArr = safeParseJsonArray(text);
      parsedArr.forEach((item: any) => {
        if (item && item.index !== undefined) {
          healedMap[Number(item.index)] = item.translatedText || "";
        }
      });
    }
  } catch (err: any) {
    console.warn("[healTranslationsWithAI] Non-fatal auto-heal notice:", err?.message || err);
  }
  return healedMap;
}

/**
 * Free Unlimited Translation Engine
 * Directly translates subtitle cues into natural, fluent Khmer without API keys or quota limits.
 * Uses robust multiline and single-request translation with fallback providers,
 * full post-processing (kinship terms, Khmer numerals/measures, ellipsis cleaning, and fauna terminology).
 */
async function translateSingleTextFree(text: string, targetLang = "km"): Promise<string> {
  if (!text || !text.trim()) return "";
  const trimmed = text.trim();

  // Try 1: Google Translate Chrome Extension Endpoint (dict-chrome-ex) - highly reliable, no bot 429
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=dict-chrome-ex&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(trimmed)}`;
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "*/*"
      },
      signal: AbortSignal.timeout(6000)
    });
    if (resp.ok) {
      const data: any = await resp.json();
      if (Array.isArray(data) && Array.isArray(data[0])) {
        const fullTranslation = data[0].map((part: any) => part[0] || "").join("").trim();
        if (fullTranslation && fullTranslation !== trimmed) {
          return fullTranslation;
        }
      }
    }
  } catch (_) {}

  // Try 2: Google Translate tw-ob Endpoint
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=tw-ob&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(trimmed)}`;
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "*/*"
      },
      signal: AbortSignal.timeout(6000)
    });
    if (resp.ok) {
      const data: any = await resp.json();
      if (Array.isArray(data) && Array.isArray(data[0])) {
        const fullTranslation = data[0].map((part: any) => part[0] || "").join("").trim();
        if (fullTranslation && fullTranslation !== trimmed) {
          return fullTranslation;
        }
      }
    }
  } catch (_) {}

  // Try 3: Gemini fallback with server key if available
  try {
    const defaultAi = getAiClient();
    const fallbackResp = await defaultAi.models.generateContent({
      model: "gemini-3.1-flash-lite",
      contents: `Translate the following text to natural colloquial Khmer (Cambodian). Output ONLY the final Khmer translation, no explanation:\n\n${trimmed}`
    });
    const resultText = fallbackResp.text?.trim();
    if (resultText) return resultText;
  } catch (_) {}

  return trimmed;
}

export async function translateWithFreeUnlimitedEngine(
  blocks: Array<{ index: number; text: string; timecode?: string }>,
  targetLang = "km",
  _khmerStyle?: string
): Promise<Array<{ index: number; translatedText: string }>> {
  if (!blocks || blocks.length === 0) return [];

  // Group into chunks of 12 for high-speed batched newline translation
  const CHUNK_SIZE = 12;
  const results: Array<{ index: number; translatedText: string }> = [];

  for (let i = 0; i < blocks.length; i += CHUNK_SIZE) {
    const chunk = blocks.slice(i, i + CHUNK_SIZE);
    const chunkTexts = chunk.map((b) => (b.text || "").replace(/\r?\n/g, " ").trim());

    let translatedLines: string[] | null = null;

    // Attempt fast batched translation across newlines
    for (const client of ["dict-chrome-ex", "tw-ob"]) {
      try {
        const combined = chunkTexts.join("\n");
        const url = `https://translate.googleapis.com/translate_a/single?client=${client}&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(combined)}`;
        const resp = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0" },
          signal: AbortSignal.timeout(7000)
        });
        if (resp.ok) {
          const data: any = await resp.json();
          if (Array.isArray(data) && Array.isArray(data[0])) {
            const fullTranslation = data[0].map((p: any) => p[0] || "").join("");
            const parts = fullTranslation.split("\n");
            if (parts.length === chunk.length) {
              translatedLines = parts;
              break;
            }
          }
        }
      } catch (_) {}
    }

    // Fallback: translate line-by-line if batched translation didn't match line count
    if (!translatedLines || translatedLines.length !== chunk.length) {
      translatedLines = await Promise.all(
        chunkTexts.map((txt) => translateSingleTextFree(txt, targetLang))
      );
    }

    for (let j = 0; j < chunk.length; j++) {
      const block = chunk[j];
      const rawTranslated = translatedLines[j] || block.text;
      let cleaned = sanitizeKhmerText(rawTranslated);
      cleaned = alignKinshipTerms(cleaned, block.text);
      // Fauna terminology rule: Crocodile / 鳄鱼 / 鱷魚 -> ក្រពេី
      if (/鳄鱼|鱷魚/i.test(block.text)) {
        cleaned = cleaned.replace(/ត្រីក្រពើ/g, "ក្រពេី").replace(/ក្រពើ/g, "ក្រពេី");
      }
      // Remove lingering Thai characters
      cleaned = cleaned.replace(/[\u0e00-\u0e7f]/g, "");

      results.push({
        index: Number(block.index),
        translatedText: cleaned
      });
    }

    if (i + CHUNK_SIZE < blocks.length) {
      await new Promise((r) => setTimeout(r, 40));
    }
  }

  return results;
}

// Dedicated endpoint for Free Unlimited Subtitle Translation
app.post("/api/translate-unlimited-free", async (req, res) => {
  try {
    const { blocks, khmerStyle } = req.body;
    const items = Array.isArray(blocks) ? blocks : [];
    const translations = await translateWithFreeUnlimitedEngine(items, "km", khmerStyle);
    return res.json({
      translations,
      usedModel: "Free Unlimited Engine (100% Free / No Quota Limits)",
      usedEngine: "unlimited_free",
      count: translations.length
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "Failed to translate with free engine" });
  }
});

app.post("/api/translate-batch", async (req, res) => {
  let cleanUserApiKey: string | undefined = undefined;
  const { blocks, model, isRepair, enrichedBlocks, styleDescription, khmerStyle, apiKey, userApiKey, engineMode } = req.body || {};
  const rawApiKey = apiKey || userApiKey;
  cleanUserApiKey = (rawApiKey && typeof rawApiKey === "string" && rawApiKey.trim() !== "" && rawApiKey !== "MY_GEMINI_API_KEY") ? rawApiKey.trim() : undefined;

  // Use enrichedBlocks if available, or build from blocks
  const rawBlocksInput = (Array.isArray(enrichedBlocks) && enrichedBlocks.length > 0) 
    ? enrichedBlocks 
    : (Array.isArray(blocks) ? blocks : []);

  if (!rawBlocksInput || rawBlocksInput.length === 0) {
    return res.json({ translations: [], usedModel: getHealthyModel(model) });
  }

  // Direct Free Unlimited Engine execution (No API key, zero quota limits)
  if (engineMode === "unlimited_free") {
    console.log(`[Free Unlimited Engine] Translating batch of ${rawBlocksInput.length} cues without quota limits...`);
    const freeTranslations = await translateWithFreeUnlimitedEngine(rawBlocksInput, "km", khmerStyle);
    return res.json({
      translations: freeTranslations,
      usedModel: "Free Unlimited Engine (100% Free / No Quota)",
      usedEngine: "unlimited_free",
      isUnlimited: true
    });
  }

  try {
    const ai = getAiClient(cleanUserApiKey);
    const hasUserApiKey = !!cleanUserApiKey;

    // When not repairing, use clean compact blocks to dramatically accelerate model parsing speed
    const processedBlocks = isRepair
      ? rawBlocksInput.map((b: any, i: number, arr: any[]) => {
          const duration = calculateDurationInSeconds(b.timecode || "");
          const recommendedWords = Math.max(2, Math.round(duration * 2.8));
          const prevText = b.prevContext || (i > 0 ? arr[i - 1].text : "");
          const nextText = b.nextContext || (i < arr.length - 1 ? arr[i + 1].text : "");
          return {
            index: b.index,
            text: b.text || "",
            timecode: b.timecode || "",
            durationSeconds: duration,
            maxKhmerWordsRecommended: recommendedWords,
            dialogueContext: (prevText || nextText) 
              ? `[Preceding: "${prevText}"] -> [Target Line: "${b.text}"] -> [Following: "${nextText}"]` 
              : undefined,
            currentIncorrectTranslation: b.currentTranslation || undefined,
            reportedIssues: b.issues || undefined
          };
        })
      : rawBlocksInput.map((b: any, i: number, arr: any[]) => {
          const prevText = b.prevContext || (i > 0 ? arr[i - 1].text : "");
          const nextText = b.nextContext || (i < arr.length - 1 ? arr[i + 1].text : "");
          // Compact block with lightweight context only when needed for split phrases
          return {
            index: b.index,
            text: b.text || "",
            ...(prevText || nextText ? { context: `prev: "${prevText}" | next: "${nextText}"` } : {})
          };
        });

    let effectiveStyleDescription = styleDescription || "";
    if (khmerStyle === "funny") {
      const funnySlangPool = [
        "អាសណ្តានសៀម", "អាចោរសៀម", "អាសៀម",
        "អាគេបាញ់", "អារលាយ", "អាចង្រៃ", "អាឡប់", "អាបែកកាវ", 
        "អាមហាចង្រៃ", "អាភ្លើ", "អាឆ្កួត", "អាចោរម្សៀត", "អាងាប់", 
        "យាយកញ្ចាស់", "អារន្ទះបាញ់", "ចុយ!", "ចុយម៉ាយ!", "ចុយម៉ាយអើយ!", 
        "ចុមយក្ស!", "ចុកឈាមហ្មង!", "ឡូយញាក់សាច់!", "ក្តៅស្លឹកត្រចៀក!", 
        "យីស៊យម៉េះ!", "រលាយហ្មង!", "ឡូយប្លែក!", "ចុម!", "អីយ៉ា!"
      ];
      // Randomly shuffle the pool of funny words so each batch translation gets varied word choices
      const shuffled = [...funnySlangPool].sort(() => Math.random() - 0.5);
      effectiveStyleDescription += `\n\nFUNNY & COMEDIC SLANG TRANSLATION MODE:
- When characters are yelling, cursing, teasing, fighting, arguing, or expressing shock, translate with punchy, hilarious Cambodian movie dubbing slang and funny expressions:
1. SURPRISE / AMAZED / SHOCKED / WTF EXCLAMATIONS (e.g., 卧槽, 我去, 哎呀, 我的妈呀, 天哪, 哇塞, 绝了, 不会吧, 见鬼, 妈呀):
   - Translate dynamically with punchy, hilarious surprise words: "ចុយ!", "ចុយម៉ាយ!", "ចុយម៉ាយអើយ!", "ចុមយក្ស!", "ចុម!", "អីយ៉ា!", "ចុកឈាមហ្មង!", "ឡូយញាក់សាច់!", "យីស៊យម៉េះ!".
2. BAD OLD WOMAN / EVIL OLD WOMAN / OLD HAG (e.g., 老太婆, 老妖婆, 死老太婆, 恶毒老妇, 泼妇):
   - Translate as "យាយកញ្ចាស់" or "យាយកញ្ចាស់ចង្រៃ" (do NOT translate as gentle/polite "ស្ត្រីចំណាស់" or "យាយចាស់" during comedic fights/insults).
3. COMEDIC SCOLDING & CURSE WORDS:
   - Use a diverse variety of comedic scolding words and slang expressions, such as: ${shuffled.slice(0, 12).join(", ")}.
4. DYNAMIC SHUFFLE & ANTI-REPETITION MANDATE:
   - Do NOT use the exact same slang, curse, or exclamation word again and again. Randomly shuffle and alternate between different comedic expressions across different dialogue lines to make the dialogue hilarious, natural, and entertaining.
5. FIRST-PERSON PRONOUN MANDATE: Even in funny/comedic mode, NEVER translate "我" (I/me) into "អញ" or "អញ់" — translate as "យើង" during angry/shouting/teasing/fighting moments and "ខ្ញុំ" normally.`;
    } else if (khmerStyle === "concise") {
      effectiveStyleDescription += `\n\nCONCISE & CLEAR PUNCHY STYLE (បង្រួមខ្លីខ្លឹម ច្បាស់លាស់ មិនវៀចវេរ):
- PRIORITIZE MAXIMUM CONCISENESS WITH ZERO MEANING LOSS: Deliver crisp, direct, punchy Khmer dialogue that perfectly conveys the original meaning and nuances without wordy bloat.
- STRIP GRAMMATICAL PADDING & FILLERS: Drop unnecessary connector words like 'គឺជា' (use 'ជា' or direct noun), 'នៅក្នុង' (use 'ក្នុង' or 'នៅ'), 'ដែលបាន', 'ធ្វើការ', 'មានការ', 'មួយនេះ', 'ទាំងអស់គ្នា' (when already clear from context).
- PUNCHY SPOKEN PHRASING: Replace dragging, multi-word clauses with sharp, natural colloquial expressions that are effortless to read rapidly on screen.
- FULL FIDELITY: Never drop plot facts, character emotions, or story details — express the full thought with fewer, better, more natural words.`;
    } else if (khmerStyle === "formal") {
      effectiveStyleDescription += `\n\nFORMAL & DIGNIFIED TRANSLATION STYLE: Use polite, literary, and respectful Khmer vocabulary.`;
    } else if (khmerStyle === "literal") {
      effectiveStyleDescription += `\n\nFAITHFUL & ACCURATE TRANSLATION: Translate directly and accurately matching the source Chinese syntax.`;
    } else if (khmerStyle === "voiceover") {
      effectiveStyleDescription += `\n\nVOICEOVER & DUBBING COMPACT STYLE (បង្រួមពាក្យខ្លីសម្រាប់បញ្ចូលសំឡេង / TTS-Friendly):
- Prioritize concise, punchy, conversational spoken Khmer dialogue tailored for voiceover artists and Text-To-Speech (TTS/Balabolka) pacing.
- Keep the sentence structure short and direct so it fits comfortably within the subtitle duration without rushing the voice speed.
- Strip redundant grammatical particles and formal fillers (e.g., replace 'គឺជា' with 'ជា' or omit, drop 'នៅក្នុង', 'ដែលបាន', 'ទាំងអស់គ្នា', 'មានការ', 'មួយនេះ').
- Never lose the original meaning, emotion, or comedic tone — communicate the exact same idea using crisp, economical spoken words.`;
    }

    const systemInstruction = `You are an expert, highly skilled translator specializing in translating text from Chinese, Korean, English, Japanese, or any source language to Khmer.
Your absolute, non-negotiable priority is to ensure the output is entirely in the Khmer language.

CRITICAL GUARDRAIL: Under no circumstances should you mix foreign scripts into the translation. Absolutely zero Myanmar/Burmese script (မြန်မာစာ \\u1000-\\u109f, \\ua9e0-\\ua9fe like 'ခ', 'ရ', 'ခរុ'), Thai words or script (ภาษาไทย), Lao words or script (ພາສາລາວ), Arabic script (العربية / فارسی / ئۇيغۇرចែ like 'ـینگ', 'ی', 'ن', 'گ' or ranges \\u0600-\\u06ff), Cyrillic, or any non-Khmer characters are allowed. Even if a Chinese word looks similar to a concept shared by neighboring languages, you must exclusively use native, standard Khmer words and the Khmer script (អក្សរខ្មែរ). Chinese terms/names ending in 'Ying' / 'Ing' (such as 元婴, 顾蓝莹, 阿英, 颖) MUST be transliterated into natural Khmer script (e.g. 'យីង', 'អ៊ិង', 'អុីង'), NEVER Arabic script ('ـینگ').

DISTINCT KHMER VOCABULARY (STRICTLY PROHIBIT LAO/THAI CALQUES & FALSE FRIENDS):
- "螺纹 / 螺旋 / 波纹" (screw / spiral / corrugated / thread): Translate into Khmer as "គូទខ្យង", "រាងគូទខ្យង", "វីស", or "រាងរង្វង់". NEVER use Burmese "ခរុ" or foreign words.
- "螺纹管 / 波纹管 / 螺旋管" (corrugated pipe / spiral pipe): Translate into Khmer as "បំពង់គូទខ្យង" or "បំពង់រាងគូទខ្យង" (e.g., "这是预埋在垫层里的螺纹管" -> "នេះដែរ ជាបំពង់គូទខ្យងដែលបង្កប់ក្នុងទ្រនាប់ផ្លូវ" / "នេះជាបំពង់រាងគូទខ្យងដែលកប់ក្នុងស្រទាប់ទ្រនាប់").
- "垫层 / 基层 / 路基垫层" (subgrade / cushion layer): Translate as "ទ្រនាប់ផ្លូវ" or "ស្រទាប់ទ្រនាប់".
- "预埋 / 埋设" (embed / embedded): Translate as "បង្កប់" or "បង្កប់ក្នុង" or "កប់ក្នុង".
- "幻觉 / 出现幻觉 / 产生幻 / 幻象" (hallucination / illusion / seeing things): Translate ONLY as "ឃើញរវើរវាយ", "ភាន់ភ្នែក", "ស្រវាំងភ្នែក", or "កើតអារម្មណ៍រវើរវាយ" (e.g., "怎么就出现幻" -> "ហេតុអ្វីក៏ស្រាប់តែឃើញរវើរវាយបែបនេះ" / "ស្រាប់តែភាន់ភ្នែកបែបនេះ"). NEVER use Lao/Thai "ภาพหลอน/ພາບຫລອນ" calques like "ឃើញភាពលង", "ភាពលង", or "ឃាបលង".
- "没喝几杯 / 喝几杯" (didn't drink much / drank a few glasses): Translate as "ផឹកមិនទាន់បានប៉ុន្មានកែវផង" / "ផឹកប៉ុន្មានកែវ" / "ផឹកមិនទាន់បានប៉ុន្មានផង".
- "喝醉 / 醉了" (drunk): Translate as "ស្រវឹង" / "ស្រវឹងស្រា" (NEVER "ស្រវឹងម៉ៅ").
- "清醒 / 醒酒 / 醒来" (sober up / conscious / awake): Translate as "ស្វាង", "ស្វាងស្រវឹង", "ដឹងខ្លួន", or "ភ្ញាក់ដឹងខ្លួន".
- "做梦 / 白日梦 / 梦见" (dream / daydream): Translate as "យល់សប្តិ", "សុបិន", or "ស្រមើស្រមៃ".
- "驱赶 / 赶走" (drive away / kick out): Translate as "ដេញ" or "ដេញចេញ" or "កុំដេញខ្ញុំ" (NEVER transliterate Thai "ไล่" into "ឡៃ" or "លៃ").
- "请客 / 宴席 / 招待" (treat to food / banquet): Translate as "លៀង", "ជប់លៀង", "លៀងបាយ", or "ប៉ាវបាយ" (NEVER transliterate Thai "เลี้ยง" into "លេីយង", "េលីយង", or "លីយ៉ង់").
- "照顾 / 照应" (take care): Translate as "មើលថែ", "ថែរក្សា", or "ជួយមើល" (NEVER "ឌូអែល").
- "担心 / 挂念" (worry): Translate as "បារម្ភ", "ព្រួយបារម្ភ", or "ព្រួយចិត្ត" (NEVER "កាំងវ៉ុល" / "ហួង").
- "漂亮 / 好看" (beautiful): Translate as "ស្អាត", "ស្រស់ស្អាត" (NEVER "ស្វាយ").
- "容易 / 简单" (easy): Translate as "ងាយស្រួល", "ស្រួល" (NEVER "ងាយងាយ").

MANDATORY NUMBER & AMOUNT TRANSLATION RULE (MUST TRANSLATE IN KHMER SENTENCE ALPHABET WORDS):
- When translating amounts, money, quantities, prices, counts, or numbers (e.g. 100000, 1000000, 10000000, 100000000, 1000000000, 10000000000, 100,000, 1,000,000, 一亿, 一千万, 两千万, 5000万, 1000万, 十万, 一万, etc.):
- Amounts and numbers MUST ONLY be translated into natural Khmer sentence alphabet words (ពាក្យខ្មែរអក្សរសុទ្ធ):
  * 100,000 / 100000 / 十万 -> MUST translate to "មួយសែន" (e.g., 200,000 -> ពីរសែន, 500,000 -> ប្រាំសែន)
  * 1,000,000 / 1000000 / 一百万 -> MUST translate to "មួយលាន" (e.g., 2,000,000 -> ពីរលាន, 5,000,000 -> ប្រាំលាន)
  * 10,000,000 / 10000000 / 一千万 -> MUST translate to "ដប់លាន" (e.g., 20,000,000 -> ម្ភៃលាន, 50,000,000 -> ហាសិបលាន)
  * 100,000,000 / 100000000 / 一亿 -> MUST translate to "មួយរយលាន" (e.g., 200,000,000 -> ពីររយលាន, 500,000,000 -> ប្រាំរយលាន)
  * 1,000,000,000 / 1000000000 / 十亿 -> MUST translate to "មួយពាន់លាន" (e.g., 2,000,000,000 -> ពីរពាន់លាន)
  * 10,000,000,000 / 10000000000 / 百亿 -> MUST translate to "ដប់ពាន់លាន" (e.g., 20,000,000,000 -> ម្ភៃពាន់លាន)
  * 10,000 / 10000 / 一万 -> "មួយម៉ឺន" (e.g., 50,000 -> ប្រាំម៉ឺន)
  * 1,000 / 1000 / 一千 -> "មួយពាន់"
- CRITICAL: NEVER output raw digits like "100000" or "100,000,000" in subtitles. ALWAYS write them out in natural Khmer words ("មួយសែន", "មួយលាន", "ដប់លាន", "មួយរយលាន", "មួយពាន់លាន", "ដប់ពាន់លាន").

MANDATORY FIRST-PERSON PRONOUN RULES FOR "我" (I / ME / MYSELF):
- STRICT BAN: NEVER translate "我" / "I" / "me" into "អញ" or "អញ់" under ANY circumstances. The words "អញ" and "អញ់" are strictly forbidden.
- DEFAULT TRANSLATION: Always translate "我" (I/me) as "ខ្ញុំ" (khnom) for standard conversations, polite dialogue, everyday interaction, talking with elders/bosses/friends, or general monologue.
- ANGRY / CONFLICT / FIGHTING / SCOLDING SENTENCES: When the character is angry, furious, arguing, yelling, threatening, fighting, or scolding, translate "我" (I/me) as "យើង" (yeung). NEVER use "អញ" or "អញ់".

MANDATORY THIRD-PERSON PRONOUN RULES (STRICT BAN ON BARE "នាង" FOR "他" / "她" / "he" / "she" / "him" / "her"):
- IN CHINESE DRAMAS & ASR SUBTITLES: "他" (he) and "她" (she) are homophones ("tā") and constantly confused. Translating "she/her/她" or "他" to bare "នាង" causes severe gender confusion where male characters or general subjects are incorrectly referred to as "នាង".
- STRICTLY BAN bare standalone "នាង" for third-person pronouns.
- ALWAYS translate third-person pronouns ("他", "她", "he", "she", "him", "her") into gender-safe, universal, natural Khmer:
  * Default & Universal: Always translate as "គាត់" (koat) for all persons (men, women, elders, colleagues, leaders, general 3rd person).
  * Casual / Collective: Use "គេ" (ke).
  * Explicit Female Titles: If referring to a formal or family title, use explicit compound nouns like "អ្នកនាង" (Miss/Ms), "លោកស្រី" (Madam), "បងស្រី" (elder sister), "ប្អូនស្រី" (younger sister), or "ក្មេងស្រី" (young girl), NEVER standalone "នាង".

KHMER UNICODE STORAGE ORDER RULE: In Khmer Unicode, ALL vowel characters (such as េ, ែ, ៃ, ោ, ៅ) MUST be stored logical-order-wise AFTER the consonant or consonant cluster they belong to. NEVER write vowel characters before the base consonant character, even though some vowels appear visually on the left when rendered. Writing vowels before consonants is a critical Unicode violation and results in rendering error dotted circles (e.g., ◌ោ, ◌ៅ, ◌េ).

PREFERRED NATIVE VOCABULARY: Always use 100% correct Khmer words. For "drive away/expel/get out", use native Khmer "ដេញ" or "ដេញចេញ" or "កុំដេញខ្ញុំ" (NEVER transliterate Thai "ไล่" into "លៃ" or "ៃល"). For "treat to food/feast/host", use native Khmer "លៀង", "ជប់លៀង", "លៀងបាយ", or "ប៉ាវបាយ" (NEVER transliterate Thai "เลี้ยง" into "លេីយង" or "េលីយង"). For "Crocodile" / "鳄鱼" / "鱷魚", ALWAYS translate as "ក្រពេី" (e.g. "鳄鱼" -> "ក្រពេី", "鳄鱼皮" -> "ស្បែកក្រពេី", "鳄鱼潭" -> "បឹងក្រពេី"; NEVER translate literally as "ត្រីក្រពើ" due to Chinese character 鱼, and NEVER leak Thai "จระเข้").

CHINESE DRAMA ABBREVIATIONS, SPLIT SENTENCES, & ASR CAPTIONS:
1. SPLIT PHRASES ACROSS BLOCKS: Chinese subtitles often cut a sentence or compound name across adjacent blocks (e.g., Block 1: "和天雪集", Block 2: "团真是走了" -> combined "和天雪集团" = Tianxue Group).
   - Use the provided 'dialogueContext' ([Preceding] -> [Target Line] -> [Following]) to reconstruct full phrases before translating each block into Khmer.
2. DRAMA CONTRACTIONS & SLANG: Chinese dramas use family contractions (e.g. "许家" = Xu Family / House of Xu), company abbreviations ("天雪集" + "团" = Tianxue Group), internet slang, and spoken ASR homophone typos.
   - Infer the intended meaning from dialogue context and translate into smooth, natural, idiomatic Khmer dialogue.
3. ZERO UNTRANSLATED BLOCKS: You MUST translate every block provided. NEVER leave Chinese characters (Hanzi: [\u4e00-\u9fff]) and NEVER return an empty string.

CHINESE VERBAL MEASURE WORDS & ACTION CLASSIFIERS (量词):
- Chinese subtitles heavily use verbal measure words like "一顿" (dùn), "一趟" (tàng), "一场" (chǎng), "一番" (fān), "一阵" (zhèn), "一遍" (biàn), "一次" (cì), "一遭" (zāo).
- NEVER leave these characters in Chinese Hanzi or half-translated (e.g., NEVER output "វាយមួយ顿")! Translate the whole phrase idiomatically into Khmer:
  * "打一顿" / "揍一顿" / "挨打一顿" -> "វាយមួយដៃ" / "វាយមួយប្រាវ" / "វាយមួយឈុត" / "វាយឱ្យចាស់ដៃ" (e.g., "放开否则待会儿就不是打一顿这么简单了" -> "លែងដៃភ្លាម បើមិនដូច្នោះទេ ពេលបន្តិចទៀតនេះវាមិនមែនត្រឹមតែត្រូវគេវាយមួយប្រាវធម្មតានោះទេ")
  * "骂一顿" / "训一顿" -> "ជេរមួយប្រាវ" / "ស្តីបន្ទោសមួយប្រាវ" / "ស្តីឱ្យមួយឈុត"
  * "吃一顿" / "一顿饭" / "饱餐一顿" -> "ញ៉ាំមួយពេល" / "ហូបមួយពេល" / "បាយមួយពេល" / "ញ៉ាំមួយឆ្អែត"
  * "去一趟" / "走一趟" / "跑一趟" -> "ទៅមួយជើង" / "ទៅមួយជុំ" / "ធ្វើដំណើរមួយជើង"
  * "闹一场" / "打一场" -> "ឈ្លោះគ្នាមួយក្តី" / "វាយគ្នាមួយប្រកួត"
  * "折腾一番" / "一番话" -> "រករឿងមួយឈុត" / "សម្តីមួយឈុត"
  * "一阵" -> "មួយស្របក់" / "មួយភ្លែត"
  * "看一遍" / "说一遍" -> "មើលមួយលើក" / "និយាយម្តងទៀត" / "មួយសារ"
  * "一遭" -> "មួយជុំ" / "មួយលើក"

CHINESE NAMES AND PROPER NOUNS (HUMAN, ANIMAL, OBJECT, PLACES, WEAPONS):
- STRICT RULE: DO NOT TRANSLATE PROPER NAMES LITERALLY.
  * Human Names: Transliterate phonetically into Khmer script sound (e.g., "叶凡" -> "យ៉េ ហ្វាន", "林辰" -> "លីន ឆិន", "苏清雪" -> "ស៊ូ ឈីងសៀវ", "顾蓝莹" -> "គូ ឡានយីង", "楚阳" -> "ឈូ យ៉ាង", "沈浪" -> "សិន ឡាំង", "白飞飞" -> "ប៉ាយ ហ្វីហ្វី", "李峰" -> "លី ហ្វេង"). NEVER translate the dictionary meaning of characters in a person's name (e.g. do NOT translate "叶" as "ស្លឹក" or "凡" as "ធម្មតា").
  * Animal / Pet Names: Transliterate pet/animal names phonetically as proper nouns (e.g., "大黄" -> "ដាហួង" / "តាហួង", "小白" -> "ស៊ាវប៉ាយ", "旺财" -> "វ៉ាងឆាយ", "小黑" -> "ស៊ាវហី", "咪咪" -> "មីមី"). NEVER translate animal names literally into generic color/size words (e.g. NEVER translate "大黄" as "លឿងធំ" or "小白" as "សតូច").
  * Named Objects, Artifacts, Weapons, Sects, Places, Companies: Transliterate the specific proper noun phonetically and keep the category noun clear (e.g., "天雪集团" -> "ក្រុមហ៊ុន ធានសៀវ", "玄天剑" -> "ដាវ ស្វៀនធាន", "诛仙剑" -> "ដាវ ជូសៀន", "青云门" -> "និកាយ ឈីងយុន", "兰博基尼" -> "ឡាំបូហ្គីនី").
- If a name is too complex to phoneticize into Khmer script, write it in clean English/Pinyin letters (e.g., "Gu Lanying"). NEVER keep names in Chinese Hanzi characters.

NATURAL CONCISENESS & ZERO OMISSION (បង្រួមខ្លីខ្លឹម ច្បាស់លាស់ មិនវៀចវេរ និងរក្សាខ្លឹមសារពេញលេញ):
- AVOID OVERLY WORDY TRANSLATIONS: Chinese expressions must NOT be translated word-for-word into bloated, trailing Khmer sentences. As an intelligent translator, deliver a concise, crisp translation that remains crystal-clear and preserves 100% of the original meaning, emotion, and character intent.
- ELIMINATE WORDY BLOAT & GRAMMATICAL FILLERS:
  * Drop artificial connector bloat: avoid 'គឺជា' (use 'ជា' or direct noun clause), avoid 'នៅក្នុង' (use 'ក្នុង' or 'នៅ'), avoid 'ដែលបាន', avoid 'ធ្វើការ' before verbs (e.g. 'ស៊ើបអង្កេត' not 'ធ្វើការស៊ើបអង្កេត'), avoid 'មានការ', avoid 'មួយនេះ'.
  * Simplify trailing temporal padding: 'ពេលបន្តិចទៀតនេះ' -> 'បន្តិចទៀត' / 'មួយភ្លែតទៀត'; 'នៅពេលនេះ' -> 'ឥឡូវ' / 'ឥឡូវនេះ'.
  * Avoid dragging out threats or dialogue: (e.g., "放开否则待会儿就不是打一顿这么简单了" -> "លែងដៃ! បើមិនចឹងមិនមែនត្រឹមត្រូវមួយប្រាវទេ!").
  * Express ideas in natural, punchy, conversational spoken Khmer that flows effortlessly in subtitles and voiceover pacing.
- PRESERVE 100% OF CORE MEANING & NUANCE: Conciseness never means dropping story facts, plot points, questions, negations, or emotional intensity. Convey every sentence's full meaning with fewer, more effective words.

GENDER, PRONOUNS, AND SPEAKING SEX RECOGNITION:
- Carefully determine gender from titles and context (他, 她, 爸, 妈, 哥, 姐, 兄弟, 丫头).
- PRONOUN RULE FOR 我 (I/me): NEVER translate as "អញ" or "អញ់". Always translate as "ខ្ញុំ" (khnom) by default. If the dialogue is angry, arguing, threatening, or fighting, use "យើង" (yeung).
- PRONOUN RULE FOR 你 (you): "អ្នក" or "អ្នកឯង" by default. Use respectful terms ("បង", "លោក", "អ្នក", "គាត់") for elders/bosses.
- PRONOUN RULE FOR 他 / 她 (he/she/him/her): Default to "គាត់" (koat) or "គេ" (ke) for all third-person references to maintain gender safety and eliminate misgendering. STRICTLY PROHIBIT bare standalone "នាង". Only use compound titles like "អ្នកនាង" or "លោកស្រី" when formal.

CRITICAL KINSHIP & RELATION ACCURACY: HUSBAND (ស្វាមី / ប្ដី) VS BROTHER-IN-LAW (បងថ្លៃ / ប្អូនថ្លៃ):
You must clearly and strictly distinguish between HUSBAND (ស្វាមី/ប្ដី) and BROTHER-IN-LAW (បងថ្លៃ/ប្អូនថ្លៃ). Never confuse, swap, or invert these relations:

1. HUSBAND (ប្ដី / ស្វាមី) — A woman's own spouse:
- "丈夫" (zhàngfu) -> Husband (Formal/Standard) -> Always translate as "ស្វាមី" (formal) or "ប្ដី" (everyday standard). NEVER translate as brother-in-law ("បងថ្លៃ" / "ប្អូនថ្លៃ").
- "老公" (lǎogōng) -> Husband (Casual/Affectionate) -> Always translate as "ប្ដី" or "ប្ដីសម្លាញ់" or address directly as "បង" (darling husband). NEVER translate as brother-in-law ("បងថ្លៃ" / "ប្អូនថ្លៃ").
- "哥哥" (gēge) / "哥" (gē) / "X哥" -> Romantic Pet Name: In romantic couples, dating relationships, or when a wife addresses her husband affectionately, "哥哥/哥" means "បង" / "បងសម្លាញ់" / "ប្ដី" (sweetheart / darling husband). NEVER translate this romantic pet name as brother-in-law ("បងថ្លៃ" / "ប្អូនថ្លៃ") and do NOT confuse it with in-laws!
- "夫君" (fūjūn) / "相公" (xiànggong) -> Costume/Period Drama Husband -> Always translate as "ស្វាមី", "ប្ដី", or "ម្ចាស់បង". NEVER brother-in-law.
- "爱人" (àiren) -> Spouse/Husband -> "ស្វាមី" or "ប្ដី".

2. BROTHER-IN-LAW (បងថ្លៃ / ប្អូនថ្លៃ) — In-law relatives (sister's husband or spouse's brother):
- "姐夫" (jiěfu) -> Elder Sister's Husband -> Always translate as "បងថ្លៃ" (Elder brother-in-law). NEVER translate as husband ("ប្ដី" / "ស្វាមី").
- "妹夫" (mèifu) -> Younger Sister's Husband -> Always translate as "ប្អូនថ្លៃ" (Younger brother-in-law). NEVER translate as husband ("ប្ដី" / "ស្វាមី").
- "大舅子" (dàjiùzi) / "大舅哥" (dàjiùgē) -> Wife's Elder Brother -> Always translate as "បងថ្លៃ". NEVER husband ("ប្ដី").
- "小舅子" (xiǎojiùzi) / "小舅" -> Wife's Younger Brother -> Always translate as "ប្អូនថ្លៃ". NEVER husband ("ប្ដី").
- "大伯子" (dàbǎizi) / "大伯哥" -> Husband's Elder Brother -> Always translate as "បងថ្លៃ". NEVER husband ("ប្ដី").
- "小叔子" (xiǎoshūzi) / "小叔" -> Husband's Younger Brother -> Always translate as "ប្អូនថ្លៃ". NEVER husband ("ប្ដី").

3. SISTER-IN-LAW (បងថ្លៃ / ប្អូនថ្លៃ / បងស្រីថ្លៃ / ប្អូនស្រីថ្លៃ):
- "嫂子" (sǎozi) -> Elder brother's wife -> "បងថ្លៃ" / "បងស្រីថ្លៃ".
- "弟妹" (dìmèi) / "弟媳" (dìxí) -> Younger brother's wife -> "ប្អូនថ្លៃ" / "ប្អូនស្រីថ្លៃ".
- "大姑子" / "大姨子" -> Elder sister-in-law -> "បងថ្លៃ".
- "小姑子" / "小姨子" -> Younger sister-in-law -> "ប្អូនថ្លៃ".

SUMMARY GOLDEN RULE:
- If referring to one's own husband (丈夫, 老公, romantic 哥哥, 夫君, 相公) -> ALWAYS USE HUSBAND: "ស្វាមី" / "ប្ដី" / "បងសម្លាញ់".
- If referring to a sister's husband or in-law brother (姐夫, 妹夫, 大舅子, 小叔子, 小舅子, 大伯子) -> ALWAYS USE BROTHER-IN-LAW: "បងថ្លៃ" / "ប្អូនថ្លៃ".

HIGH-QUALITY CONTEXTUAL TRANSLATION (NOT MECHANICAL LITERAL):
- Translate the full emotional and narrative context into equivalent powerful, fluent, and idiomatic Khmer dialogue as in professional Cambodian movie dubs.

NO ELLIPSIS SIGNS / REMOVE DOT TRAILERS ("...", "…", "( ... )"):
- Do NOT output ellipsis signs like "...", "…", "....", or "( ... )" in the translated sentences. Subtitles must be clean, spoken dialogue without lingering trailing dots or parenthesis ellipsis signs.

${effectiveStyleDescription ? `TRANSLATION STYLE / SPECIAL GLOSSARY:\n${effectiveStyleDescription}\n` : ""}`;

    let finalSystemInstruction = systemInstruction;
    if (isRepair) {
      finalSystemInstruction += `\n\nCRITICAL - REPAIR & ABBREVIATION FIX MODE ACTIVE:
The user has requested to fix specific subtitle blocks that were untranslated, contained remaining Chinese characters, or suffered from Chinese split-phrase / abbreviation confusion.
Your highest priority is to output 100% clean, complete Khmer translation for every single input block using the dialogueContext provided.`;
    }

    // Format the blocks into a clear string for the model prompt
    let promptText = "";
    if (isRepair) {
      promptText = `REPAIR REQUEST: Please fix and complete the translations for the following Chinese subtitle blocks using dialogue context. Ensure every output 'translatedText' is 100% clean Khmer.
Input Blocks to Repair:
${JSON.stringify(processedBlocks, null, 2)}`;
    } else {
      promptText = `Translate the following Chinese subtitle blocks into Khmer. 
Each block contains 'dialogueContext' to help resolve split phrases, Chinese abbreviations, and character names.
Input Blocks:
${JSON.stringify(processedBlocks, null, 2)}`;
    }

    const queryParams = {
      model: getHealthyModel(model),
      contents: promptText,
      config: {
        systemInstruction: finalSystemInstruction,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              index: {
                type: Type.INTEGER,
                description: "The unique index matching the input subtitle block.",
              },
              translatedText: {
                type: Type.STRING,
                description: "The translated Khmer subtitle line.",
              },
            },
            required: ["index", "translatedText"],
          },
        },
        temperature: 0.2,
      },
    };

    const response = await generateContentWithRetry(ai, queryParams, 2, [], hasUserApiKey);
    const responseText = response.text;
    if (!responseText) {
      throw new Error("No response received from the Gemini model.");
    }

    const parsedTranslations = safeParseJsonArray(responseText);
    let translations = parsedTranslations.map((t: any) => {
      const idx = t.index !== undefined ? Number(t.index) : 0;
      const origBlock = blocks.find((b: any) => Number(b.index) === idx);
      const origText = origBlock ? (origBlock.text || "") : "";
      let txt = sanitizeKhmerText(t.translatedText || "");
      txt = alignKinshipTerms(txt, origText);
      return {
        index: idx,
        translatedText: txt
      };
    });

    const inputIndexes = blocks.map((b: any) => Number(b.index));
    const receivedIndexes = new Set(translations.map((t: any) => Number(t.index)));
    const missingBlocks = blocks.filter((b: any) => !receivedIndexes.has(Number(b.index)));

    if (missingBlocks.length > 0) {
      console.log(`[Backend Fallback] Found ${missingBlocks.length} missing blocks in response. Running second-pass translate...`);
      try {
        const fallbackEnriched = missingBlocks.map((b: any) => {
          const duration = calculateDurationInSeconds(b.timecode);
          const recommendedWords = Math.max(2, Math.round(duration * 2.8));
          return {
            index: b.index,
            text: b.text,
            timecode: b.timecode || "",
            durationSeconds: duration,
            maxKhmerWordsRecommended: recommendedWords
          };
        });

        const fallbackPromptText = `Translate the following specific subtitle blocks into Khmer. These were previously missed or omitted, so please ensure they are translated accurately.
Input Blocks:
${JSON.stringify(fallbackEnriched, null, 2)}`;

        const fallbackParams = {
          model: queryParams.model || model,
          contents: fallbackPromptText,
          config: {
            systemInstruction: queryParams.config.systemInstruction,
            responseMimeType: "application/json",
            responseSchema: queryParams.config.responseSchema,
            temperature: 0.1,
          }
        };

        const fallbackResponse = await generateContentWithRetry(ai, fallbackParams, 2, [], hasUserApiKey);
        const fallbackResponseText = fallbackResponse.text;
        if (fallbackResponseText) {
          const fallbackParsed = safeParseJsonArray(fallbackResponseText);
          fallbackParsed.forEach((t: any) => {
            if (t && t.index !== undefined) {
              const idx = Number(t.index);
              const origBlock = blocks.find((b: any) => Number(b.index) === idx);
              const origText = origBlock ? (origBlock.text || "") : "";
              let txt = sanitizeKhmerText(t.translatedText || "");
              txt = alignKinshipTerms(txt, origText);
              translations.push({
                index: idx,
                translatedText: txt
              });
              console.log(`[Backend Fallback] Successfully recovered block ${idx}`);
            }
          });
        }
      } catch (fallbackError) {
        console.warn("[Backend Fallback] Non-fatal recovery fallback issue:", (fallbackError as any)?.message || fallbackError);
      }
    }

    const finalReceivedIndexes = new Set(translations.map((t: any) => Number(t.index)));
    blocks.forEach((b: any) => {
      const idx = Number(b.index);
      if (!finalReceivedIndexes.has(idx)) {
        console.log(`[Backend Fallback Safety Net] Block ${idx} is still missing. Adding best-effort empty translation.`);
        translations.push({
          index: idx,
          translatedText: ""
        });
      }
    });

    const thaiRegex = /[\u0e00-\u0e7f]/;
    const laoRegex = /[\u0e80-\u0eff]/;
    const chineseRegex = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u2e80-\u2eff\u2f00-\u2fdf\u31c0-\u31ef]/;
    const japaneseRegex = /[\u3040-\u309f\u30a0-\u30ff\u31f0-\u31ff]/;
    const koreanRegex = /[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/;
    const arabicRegex = /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff]/;
    const myanmarRegex = /[\u1000-\u109f\ua9e0-\ua9fe]/;
    const foreignRegex = /[\u0400-\u04ff\u0900-\u097f]/;
    const khmerRegex = /[\u1780-\u17ff\u19e0-\u19ff]/;
    
    // Identify any blocks that are untranslated, contain foreign scripts (Chinese Hanzi, Thai, Lao, Arabic, Myanmar, Japanese, Korean), or lack Khmer characters
    const failedTranslationBlocks = translations.filter((t: any) => {
      const txt = t.translatedText || "";
      const originalBlock = (blocks || []).find((b: any) => Number(b.index) === Number(t.index));
      const origText = originalBlock ? (originalBlock.text || "") : "";
      
      const hasThai = thaiRegex.test(txt);
      const hasChinese = chineseRegex.test(txt);
      const hasLao = laoRegex.test(txt);
      const hasArabic = arabicRegex.test(txt);
      const hasMyanmar = myanmarRegex.test(txt);
      const hasForeign = foreignRegex.test(txt);
      const hasJp = japaneseRegex.test(txt);
      const hasKr = koreanRegex.test(txt);
      const isEmpty = txt.trim() === "";
      const origHadChinese = chineseRegex.test(origText);
      const hasKhmer = khmerRegex.test(txt);
      const isIdentical = origHadChinese && origText.trim().length > 0 && txt.trim() === origText.trim();
      const hasLatin = /[a-zA-Z]/.test(txt);
      
      return hasThai || hasChinese || hasLao || hasArabic || hasMyanmar || hasForeign || hasJp || hasKr || isEmpty || isIdentical || (origHadChinese && !hasKhmer && !hasLatin);
    });
    
    // Only trigger secondary AI healing if isRepair was explicitly requested OR if more than 40% of the batch failed
    const shouldRunAiHeal = isRepair || (failedTranslationBlocks.length >= Math.max(3, Math.ceil(blocks.length * 0.4)));
    if (failedTranslationBlocks.length > 0 && shouldRunAiHeal) {
      console.log(`[Backend Auto-Heal] Found ${failedTranslationBlocks.length} blocks with issues (Thai, Chinese Hanzi, foreign scripts, or empty). Healing with context...`);
      const failedBlocksToHeal = failedTranslationBlocks.map((t: any) => {
        const idxInBlocks = (blocks || []).findIndex((b: any) => Number(b.index) === Number(t.index));
        const originalBlock = idxInBlocks >= 0 ? blocks[idxInBlocks] : null;
        
        const prevText = idxInBlocks > 0 ? blocks.slice(Math.max(0, idxInBlocks - 2), idxInBlocks).map((b: any) => b.text).join(" / ") : "";
        const nextText = idxInBlocks >= 0 && idxInBlocks < blocks.length - 1 ? blocks.slice(idxInBlocks + 1, Math.min(blocks.length, idxInBlocks + 3)).map((b: any) => b.text).join(" / ") : "";
        
        const issues: string[] = [];
        const txt = t.translatedText || "";
        if (thaiRegex.test(txt)) issues.push("Contains Thai script");
        if (chineseRegex.test(txt)) issues.push("Contains leftover Chinese Hanzi characters");
        if (laoRegex.test(txt)) issues.push("Contains Lao script");
        if (arabicRegex.test(txt)) issues.push("Contains Arabic/Persian script (العربية / فارسی)");
        if (myanmarRegex.test(txt)) issues.push("Contains Myanmar/Burmese script (ခរុ...)");
        if (foreignRegex.test(txt)) issues.push("Contains foreign script (Cyrillic/Devanagari)");
        if (japaneseRegex.test(txt)) issues.push("Contains Japanese script");
        if (koreanRegex.test(txt)) issues.push("Contains Korean script");
        if (txt.trim() === "") issues.push("Empty translation / Missed block");
        if (originalBlock && chineseRegex.test(originalBlock.text) && txt.trim() === originalBlock.text.trim()) issues.push("Untranslated: identical to source Chinese");
        if (originalBlock && chineseRegex.test(originalBlock.text) && !khmerRegex.test(txt)) issues.push("Lacks Khmer characters");

        return {
          index: t.index,
          originalChineseText: originalBlock ? originalBlock.text : "",
          dialogueContext: `[Preceding: "${prevText}"] -> [Target Line: "${originalBlock ? originalBlock.text : ""}"] -> [Following: "${nextText}"]`,
          currentIncorrectTranslation: t.translatedText,
          issues
        };
      });

      try {
        const healedMap = await healTranslationsWithAI(
          ai,
          queryParams.model || model,
          failedBlocksToHeal,
          effectiveStyleDescription,
          cleanUserApiKey
        );

        translations = translations.map((t: any) => {
          if (healedMap[t.index] !== undefined && healedMap[t.index].trim() !== "") {
            const origBlock = blocks.find((b: any) => Number(b.index) === Number(t.index));
            const origText = origBlock ? (origBlock.text || "") : "";
            let healedText = sanitizeKhmerText(healedMap[t.index]);
            healedText = alignKinshipTerms(healedText, origText);
            if (thaiRegex.test(healedText)) {
              healedText = healedText.replace(/[\u0e00-\u0e7f]/g, "");
            }
            return {
              index: t.index,
              translatedText: healedText
            };
          }
          return t;
        });
      } catch (healError) {
        console.warn("[Backend Auto-Heal] Non-fatal heal issue:", (healError as any)?.message || healError);
      }
    }

    translations = translations.map((t: any) => {
      const origBlock = blocks.find((b: any) => Number(b.index) === Number(t.index));
      const origText = origBlock ? (origBlock.text || "") : "";
      let txt = t.translatedText || "";
      txt = alignKinshipTerms(txt, origText);
      if (thaiRegex.test(txt)) {
        txt = txt.replace(/[\u0e00-\u0e7f]/g, "");
      }
      return {
        ...t,
        translatedText: txt
      };
    });

    return res.json({ 
      translations,
      usedModel: queryParams.model
    });
  } catch (error: any) {
    const errorMsg = error.message || error.toString() || "";
    let cleanMessage = errorMsg;
    let parsedApiError: any = null;
    try {
      if (typeof errorMsg === "string" && errorMsg.trim().startsWith("{")) {
        parsedApiError = JSON.parse(errorMsg);
        if (parsedApiError?.error?.message) {
          cleanMessage = parsedApiError.error.message;
        }
      }
    } catch (_) {}

    const errorCode = error.code || parsedApiError?.error?.code;
    const errorStatus = error.status || parsedApiError?.error?.status;

    const isRateLimit = errorMsg.includes("429") || 
                        errorMsg.toLowerCase().includes("quota") || 
                        errorMsg.includes("RESOURCE_EXHAUSTED") ||
                        errorStatus === "RESOURCE_EXHAUSTED" ||
                        errorCode === 429;

    const isUnavailable = errorMsg.includes("503") ||
                          errorStatus === "UNAVAILABLE" ||
                          errorCode === 503 ||
                          cleanMessage.toLowerCase().includes("high demand") ||
                          cleanMessage.toLowerCase().includes("unavailable");

    const isDeadlineOrCancelled = errorMsg.includes("504") ||
                                  errorMsg.includes("499") ||
                                  errorStatus === "DEADLINE_EXCEEDED" ||
                                  errorStatus === "CANCELLED" ||
                                  errorCode === 504 ||
                                  errorCode === 499 ||
                                  cleanMessage.toLowerCase().includes("deadline expired") ||
                                  cleanMessage.toLowerCase().includes("operation was cancelled");

    const isDailyQuotaExceeded = checkIsDailyQuotaExceeded(errorMsg, errorCode, errorStatus);
    const isQuotaExceeded = isDailyQuotaExceeded;

    if (isDailyQuotaExceeded || isRateLimit) {
      console.warn(`[translate-batch] Quota limit reached (429): ${cleanMessage.slice(0, 100)}`);
    } else {
      console.error("Translation Error:", error.stack || error);
    }

    const isTransient = !isDailyQuotaExceeded && (
      isUnavailable || 
      isDeadlineOrCancelled || 
      errorMsg.toLowerCase().includes("timeout") ||
      errorMsg.toLowerCase().includes("fetch failed") ||
      (isRateLimit && !isDailyQuotaExceeded)
    );

    const httpStatus = isRateLimit ? 429 : isUnavailable ? 503 : isDeadlineOrCancelled ? 504 : 500;

    // Auto-Failover to Free Unlimited Engine on ANY Gemini Error / Quota Exhaustion / 503 / 504
    if (engineMode !== "gemini_only") {
      console.warn(`[Auto-Failover to Free Unlimited Engine] Gemini issue encountered (${cleanMessage.slice(0, 100)}). Seamlessly translating batch with Free Unlimited Engine...`);
      try {
        const fallbackTranslations = await translateWithFreeUnlimitedEngine(rawBlocksInput, "km", khmerStyle);
        if (fallbackTranslations && fallbackTranslations.length > 0) {
          const noticeMsg = (isDailyQuotaExceeded || isRateLimit)
            ? "Gemini daily quota limit was reached. Your batch was seamlessly translated using the Free Unlimited Engine with zero interruptions!"
            : "Gemini AI model encountered temporary high demand or an error. Your batch was seamlessly translated using the Free Unlimited Engine with zero interruptions!";
          return res.json({
            translations: fallbackTranslations,
            usedModel: "Free Unlimited Engine (Auto-Failover)",
            usedEngine: "unlimited_free",
            usedFallbackEngine: true,
            isUnlimited: true,
            notice: noticeMsg
          });
        }
      } catch (freeErr: any) {
        console.warn("[Auto-Failover] Free Unlimited Engine fallback error:", freeErr?.message || freeErr);
      }
    }

    let userFriendlyMessage = cleanMessage;
    if (isDailyQuotaExceeded) {
      userFriendlyMessage = cleanUserApiKey
        ? "Your custom Gemini API key has exceeded its daily free tier quota (500 requests). You can switch keys or use the Free Unlimited Engine."
        : "The shared server Gemini quota has reached its daily free limit (500 requests). Switch to the Free Unlimited Engine to continue translating immediately with no quota limits.";
    }

    return res.status(httpStatus).json({
      error: userFriendlyMessage,
      rawError: errorMsg,
      isRateLimit,
      isQuotaExceeded,
      isTransient,
      isUnavailable,
      isDeadline: isDeadlineOrCancelled,
      code: errorCode,
      status: errorStatus,
      requiresUserKey: !cleanUserApiKey && isDailyQuotaExceeded,
    });
  }
});

// Endpoint to smart-condense and shorten Khmer subtitles for voiceover, dubbing, and TTS pacing
app.post("/api/condense-voice", async (req, res) => {
  try {
    const { items, brevityLevel = "natural", model, apiKey, userApiKey } = req.body;
    const rawApiKey = apiKey || userApiKey;
    const cleanUserApiKey = (rawApiKey && typeof rawApiKey === "string" && rawApiKey.trim() !== "" && rawApiKey !== "MY_GEMINI_API_KEY") ? rawApiKey.trim() : undefined;
    const ai = getAiClient(cleanUserApiKey);

    const rawItems = Array.isArray(items) ? items : (items ? [items] : []);
    if (rawItems.length === 0) {
      return res.json({ results: [], usedModel: getHealthyModel(model) });
    }

    // Clean input payload for AI
    const inputPayload = rawItems.map((item: any) => {
      const duration = typeof item.durationSeconds === "number" ? item.durationSeconds : calculateDurationInSeconds(item.timecode || "");
      return {
        index: Number(item.index),
        sourceChinese: item.source || item.text || undefined,
        currentKhmer: item.khmer || item.translatedText || "",
        durationSeconds: duration > 0 ? Number(duration.toFixed(1)) : undefined,
      };
    });

    const isUltra = brevityLevel === "ultra";
    const systemInstruction = `You are a master Cambodian cinema dialogue adapter and Khmer voiceover script editor.
Your mission is to CONDENSE and SHORTEN Khmer subtitle text so voice actors and Text-To-Speech (TTS/Balabolka) engines can speak comfortably within the timecode duration without needing to rush speech speed or overflow.

ABSOLUTE MANDATES:
1. NEVER LOSE THE CORE MEANING: Preserve 100% of the original meaning, emotion, key character facts, and dialogue intent.
2. REMOVE VERBOSITY & REDUNDANT FILLERS:
   - Strip redundant formal connectors: remove or simplify 'គឺជា' (omit or use 'ជា'), 'នៅក្នុង' (use 'នៅ'), 'ដែលបាន' (drop), 'ដើម្បីឱ្យ' (use 'ឱ្យ'), 'មានការ' (omit), 'ទាំងអស់គ្នា' (use 'យើង' or omit if clear from context).
   - Replace complex multi-word clauses with crisp, natural, conversational spoken Khmer words (ពាក្យខ្លី ងាយនិយាយ ខ្លឹមសារនៅដដែល).
   - Cut unnecessary wordy syllables that don't add to the core sentence meaning.
3. BREVITY LEVEL: ${isUltra 
   ? "ULTRA-COMPACT (ខ្លីខ្លឹមបំផុត): Aim for maximum conciseness. Short punchy words suitable for fast speech / rapid dialogue." 
   : "NATURAL SPOKEN (ខ្លីល្មមធម្មជាតិ): Balanced conversational brevity that sounds fluent and natural when spoken aloud at normal 1.0x human speed."}
4. STRICT PURITY & KHMER NUMBER WORDS: Pure Khmer language and script (អក្សរខ្មែរ) only. Absolutely NO Thai characters (\\u0e00-\\u0eff), Lao characters (\\u0e80-\\u0eff), Arabic characters (\\u0600-\\u06ff like 'ـینگ'), or any foreign scripts. Format all amount numbers in Khmer sentence words (e.g. មួយសែន, មួយលាន, ដប់លាន, មួយរយលាន, មួយពាន់លាន, ដប់ពាន់លាន).
5. JSON Output Schema: Return a JSON array of objects with 'index' (number) and 'shortenedText' (string).`;

    const prompt = `Condense and shorten the following Khmer subtitle dialogue lines for natural voice timing without losing meaning:\n${JSON.stringify(inputPayload)}`;

    const chosenModel = getHealthyModel(model);

    const queryParams: any = {
      model: chosenModel,
      contents: prompt,
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              index: { type: Type.INTEGER },
              shortenedText: { type: Type.STRING }
            },
            required: ["index", "shortenedText"]
          }
        },
        temperature: 0.2
      }
    };

    if (chosenModel.startsWith("gemini-3")) {
      queryParams.config.thinkingConfig = { thinkingLevel: ThinkingLevel.LOW };
    } else if (chosenModel.startsWith("gemini-2.5")) {
      queryParams.config.thinkingConfig = { thinkingBudget: 0 };
    }

    const response = await generateContentWithRetry(ai, queryParams, 2, [], !!cleanUserApiKey);
    const responseText = response.text || "[]";
    const parsed = safeParseJsonArray(responseText);

    const thaiRegex = /[\u0e00-\u0e7f]/g;
    const laoRegex = /[\u0e80-\u0eff]/g;

    // Compute reduction metrics and sanitize
    const results = rawItems.map((origItem: any) => {
      const origIndex = Number(origItem.index);
      const matched = parsed.find((p: any) => Number(p.index) === origIndex);
      const origKhmer = (origItem.khmer || origItem.translatedText || "").trim();
      let shortened = matched && typeof matched.shortenedText === "string" ? matched.shortenedText.trim() : "";
      
      // Clean foreign scripts if any and sanitize (strip ellipses, foreign scripts)
      shortened = sanitizeKhmerText(shortened.replace(thaiRegex, "").replace(laoRegex, "").trim());
      if (!shortened) shortened = sanitizeKhmerText(origKhmer); // fallback to original sanitized

      const origLen = origKhmer.length;
      const newLen = shortened.length;
      const reductionPercent = origLen > 0 ? Math.max(0, Math.round(((origLen - newLen) / origLen) * 100)) : 0;

      return {
        index: origIndex,
        shortenedText: shortened,
        originalKhmer: origKhmer,
        originalLength: origLen,
        shortenedLength: newLen,
        reductionPercent
      };
    });

    return res.json({
      results,
      usedModel: queryParams.model || chosenModel
    });
  } catch (error: any) {
    console.error("[api/condense-voice] Error:", error);
    const errorMsg = error.message || String(error);
    return res.status(500).json({
      error: errorMsg || "Failed to condense subtitles for voice."
    });
  }
});

// Endpoint to transcribe video/audio stream into synchronized SRT subtitles
app.post("/api/transcribe-video", async (req, res) => {
  try {
    const { base64Audio, mimeType = "audio/wav", apiKey, userApiKey } = req.body;
    if (!base64Audio) {
      return res.status(400).json({ error: "Missing audio payload (base64Audio)." });
    }

    const rawApiKey = apiKey || userApiKey;
    const cleanUserApiKey = (rawApiKey && typeof rawApiKey === "string" && rawApiKey.trim() !== "" && rawApiKey !== "MY_GEMINI_API_KEY") ? rawApiKey.trim() : undefined;
    const ai = getAiClient(cleanUserApiKey);

    const systemPrompt = `You are a professional subtitle transcriber and audio timing specialist.
Your task is to transcribe all spoken dialogue from the audio into standard SRT (SubRip) subtitle format.
Guidelines:
1. Capture all spoken Chinese (or spoken dialogue) accurately word-for-word.
2. Break long speeches into natural, readable subtitle chunks (1-2 short sentences per subtitle, 2-6 seconds each).
3. Generate precise timestamps in standard SRT format:
1
00:00:01,200 --> 00:00:04,500
[Chinese dialogue line]

2
00:00:05,000 --> 00:00:08,200
[Next Chinese dialogue line]

4. Output ONLY the valid raw SRT text block. Do not include markdown code block backticks, explanations, or commentary.`;

    const audioPart = {
      inlineData: {
        mimeType: mimeType,
        data: base64Audio,
      },
    };

    let srtResult = "";
    let usedModel = "gemini-3.5-transcribe";

    try {
      const response = await ai.models.generateContent({
        model: "gemini-3.5-transcribe",
        contents: [
          audioPart,
          { text: "Please transcribe this audio into standard SRT subtitle format with accurate timecodes and Chinese text." }
        ],
        config: {
          systemInstruction: systemPrompt,
          temperature: 0.1,
        }
      });
      srtResult = response.text || "";
    } catch (transcribeErr: any) {
      console.warn("gemini-3.5-transcribe fallback to gemini-3.7-flash:", transcribeErr.message);
      usedModel = "gemini-3.7-flash";
      const fallbackResponse = await ai.models.generateContent({
        model: "gemini-3.7-flash",
        contents: [
          audioPart,
          { text: "Please transcribe this audio into standard SRT subtitle format with accurate timecodes and Chinese text." }
        ],
        config: {
          systemInstruction: systemPrompt,
          temperature: 0.1,
        }
      });
      srtResult = fallbackResponse.text || "";
    }

    // Clean markdown formatting if present
    let cleanSrt = srtResult.trim();
    if (cleanSrt.startsWith("```srt")) cleanSrt = cleanSrt.substring(6);
    else if (cleanSrt.startsWith("```")) cleanSrt = cleanSrt.substring(3);
    if (cleanSrt.endsWith("```")) cleanSrt = cleanSrt.substring(0, cleanSrt.length - 3);
    cleanSrt = cleanSrt.trim();

    return res.json({
      srt: cleanSrt,
      usedModel,
    });
  } catch (error: any) {
    console.error("Transcription Error:", error);
    return res.status(500).json({
      error: error.message || "Failed to transcribe audio from video.",
    });
  }
});

// Endpoint to download the full application source code as a complete ZIP archive
app.get("/api/download-source-zip", async (req, res) => {
  try {
    const zip = new JSZip();

    // List of all project source code files required to run the full-stack app
    const sourceFiles = [
      "package.json",
      "tsconfig.json",
      "vite.config.ts",
      "index.html",
      "metadata.json",
      ".env.example",
      "README.md",
      "server.ts",
      "src/main.tsx",
      "src/App.tsx",
      "src/types.ts",
      "src/index.css",
      "src/components/VideoPlayerStudio.tsx",
      "src/utils/srtParser.ts",
      "src/utils/exampleSubtitles.ts",
      "src/utils/videoSubtitleExtractor.ts",
    ];

    for (const relPath of sourceFiles) {
      const fullPath = path.join(process.cwd(), relPath);
      if (fs.existsSync(fullPath)) {
        const fileData = fs.readFileSync(fullPath);
        zip.file(relPath, fileData);
      }
    }

    const zipBuffer = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
    });

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", 'attachment; filename="chinese-khmer-translator-source.zip"');
    res.setHeader("Content-Length", zipBuffer.length);
    return res.send(zipBuffer);
  } catch (error: any) {
    console.error("Error creating source code zip archive:", error);
    return res.status(500).json({ error: error.message || "Failed to create source code zip." });
  }
});

function generateAllCodeHtml(projectRoot: string): string {
  const sourceFiles = [
    { path: "server.ts", title: "server.ts (Backend & AI API)", desc: "Express backend and Gemini AI translation batch routes" },
    { path: "src/App.tsx", title: "src/App.tsx (Frontend Studio)", desc: "React UI, video synchronizer, subtitle state, and controls" },
    { path: "src/utils/srtParser.ts", title: "src/utils/srtParser.ts (Parser & Numbers)", desc: "Subtitle parser, exporter, and amount-to-Khmer words converter" },
    { path: "src/components/VideoPlayerStudio.tsx", title: "src/components/VideoPlayerStudio.tsx", desc: "Video player with karaoke subtitle overlay" },
    { path: "src/types.ts", title: "src/types.ts", desc: "TypeScript interface and data structure definitions" },
    { path: "package.json", title: "package.json", desc: "Project dependencies and build scripts" },
    { path: "README.md", title: "README.md", desc: "Local setup, API keys, and deployment guide" },
    { path: "vite.config.ts", title: "vite.config.ts", desc: "Vite build configuration" },
    { path: "tsconfig.json", title: "tsconfig.json", desc: "TypeScript compiler settings" },
    { path: "index.html", title: "index.html", desc: "HTML template shell" },
    { path: ".env.example", title: ".env.example", desc: "Environment template with GEMINI_API_KEY" },
  ];

  const filesData = sourceFiles.map((file) => {
    const fullPath = path.join(projectRoot, file.path);
    let content = "";
    if (fs.existsSync(fullPath)) {
      content = fs.readFileSync(fullPath, "utf-8");
    } else {
      content = `// File not found: ${file.path}`;
    }
    return {
      ...file,
      content,
      lineCount: content.split("\n").length,
    };
  });

  const filesJson = JSON.stringify(filesData).replace(/<\/script>/g, "<\\/script>");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Chinese-Khmer Translator • Complete Application Source Code</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #0D0D0D; color: #E0E0E0; line-height: 1.5; }
    header { background: #141414; border-bottom: 1px solid #242424; padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; position: sticky; top: 0; z-index: 100; }
    .logo-area { display: flex; items: center; gap: 12px; }
    .badge { background: #FF9F0A; color: black; font-weight: bold; width: 32px; height: 32px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 16px; }
    h1 { font-size: 16px; font-weight: 700; color: #FFF; }
    .subtitle { font-size: 11px; color: #888; }
    .btn { background: #222; border: 1px solid #333; color: #EEE; font-size: 12px; font-weight: 600; padding: 8px 16px; border-radius: 8px; cursor: pointer; transition: all 0.2s; display: inline-flex; align-items: center; gap: 6px; text-decoration: none; }
    .btn:hover { background: #2A2A2A; color: #FFF; border-color: #444; }
    .btn-primary { background: #10B981; color: #000; border: none; }
    .btn-primary:hover { background: #059669; }
    .container { display: flex; height: calc(100vh - 65px); }
    .sidebar { width: 320px; background: #111; border-right: 1px solid #222; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 6px; }
    .file-item { padding: 10px 12px; border-radius: 8px; border: 1px solid transparent; cursor: pointer; transition: all 0.15s; display: flex; flex-direction: column; gap: 2px; }
    .file-item:hover { background: #1A1A1A; border-color: #262626; }
    .file-item.active { background: #1E293B; border-color: #38BDF8; }
    .file-name { font-size: 13px; font-weight: 600; font-family: monospace; color: #38BDF8; }
    .file-desc { font-size: 10px; color: #888; }
    .file-lines { font-size: 10px; color: #555; }
    .code-area { flex: 1; display: flex; flex-direction: column; overflow: hidden; background: #090909; }
    .code-header { background: #141414; border-bottom: 1px solid #222; padding: 10px 20px; display: flex; align-items: center; justify-content: space-between; }
    .code-title { font-size: 13px; font-family: monospace; font-weight: 600; color: #FFF; }
    .code-meta { font-size: 11px; color: #777; }
    pre { flex: 1; overflow: auto; padding: 20px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; line-height: 1.6; color: #E2E8F0; white-space: pre; }
    .copied-toast { position: fixed; bottom: 20px; right: 20px; background: #10B981; color: black; font-weight: bold; padding: 10px 18px; border-radius: 8px; font-size: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); opacity: 0; pointer-events: none; transition: opacity 0.2s; }
    .copied-toast.show { opacity: 1; }
    @media (max-width: 768px) {
      .container { flex-direction: column; height: auto; }
      .sidebar { width: 100%; height: 250px; }
      pre { height: 500px; }
    }
  </style>
</head>
<body>
  <header>
    <div class="logo-area">
      <div class="badge">Σ</div>
      <div>
        <h1>Chinese-Khmer Translator • Source Code Archive</h1>
        <p class="subtitle">Complete full-stack repository code in a single standalone HTML file</p>
      </div>
    </div>
    <div style="display: flex; gap: 8px;">
      <button class="btn" onclick="copyCurrentFile()">📋 Copy Current File</button>
      <button class="btn" onclick="downloadCurrentFile()">💾 Download Current File</button>
      <button class="btn btn-primary" onclick="copyAllCode()">📦 Copy All Files (Single Bundle)</button>
    </div>
  </header>

  <div class="container">
    <div class="sidebar" id="fileList"></div>
    <div class="code-area">
      <div class="code-header">
        <span class="code-title" id="activeFileName">server.ts</span>
        <span class="code-meta" id="activeFileMeta">Loading...</span>
      </div>
      <pre id="codeView"></pre>
    </div>
  </div>

  <div class="copied-toast" id="toast">Copied to clipboard!</div>

  <script>
    const files = \${filesJson};
    let activeIndex = 0;

    function renderSidebar() {
      const list = document.getElementById("fileList");
      list.innerHTML = "";
      files.forEach((f, idx) => {
        const item = document.createElement("div");
        item.className = "file-item" + (idx === activeIndex ? " active" : "");
        item.onclick = () => selectFile(idx);
        item.innerHTML = \\\`
          <div class="file-name">\\\${f.path}</div>
          <div class="file-desc">\\\${f.desc}</div>
          <div class="file-lines">\\\${f.lineCount} lines</div>
        \\\`;
        list.appendChild(item);
      });
    }

    function selectFile(index) {
      activeIndex = index;
      renderSidebar();
      const f = files[index];
      document.getElementById("activeFileName").textContent = f.path;
      document.getElementById("activeFileMeta").textContent = f.lineCount + " lines • UTF-8";
      document.getElementById("codeView").textContent = f.content;
    }

    function showToast(msg) {
      const t = document.getElementById("toast");
      t.textContent = msg || "Copied to clipboard!";
      t.classList.add("show");
      setTimeout(() => t.classList.remove("show"), 2000);
    }

    function copyCurrentFile() {
      const content = files[activeIndex].content;
      navigator.clipboard.writeText(content).then(() => {
        showToast("Copied " + files[activeIndex].path + " to clipboard!");
      });
    }

    function downloadCurrentFile() {
      const f = files[activeIndex];
      const blob = new Blob([f.content], { type: "text/plain;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = f.path.split("/").pop() || "file.txt";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }

    function copyAllCode() {
      let combined = "// CHINESE-KHMER SUBTITLE TRANSLATOR - FULL SOURCE REPOSITORY\\\\n\\\\n";
      files.forEach(f => {
        combined += "/* ==========================================================================\\\\n";
        combined += "   FILE: " + f.path + "\\\\n";
        combined += "   ========================================================================== */\\\\n\\\\n";
        combined += f.content + "\\\\n\\\\n";
      });
      navigator.clipboard.writeText(combined).then(() => {
        showToast("Copied all 11 repository files to clipboard!");
      });
    }

    selectFile(0);
  </script>
</body>
</html>`;
}

function generateStandaloneAppHtml(): string {
  return `<!DOCTYPE html>
<html lang="km">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Chinese-Khmer SRT Subtitle Translator • Standalone Web App</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Kantumruy+Pro:wght@300;400;500;600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Inter', 'Kantumruy Pro', -apple-system, sans-serif; background: #0D0D0D; color: #EBEBEB; }
    .khmer-font { font-family: 'Kantumruy Pro', sans-serif; }
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: #111; }
    ::-webkit-scrollbar-thumb { background: #333; border-radius: 4px; }
  </style>
</head>
<body class="min-h-screen flex flex-col antialiased">
  <header class="bg-[#121212] border-b border-[#222] px-6 py-3.5 flex items-center justify-between sticky top-0 z-50">
    <div class="flex items-center gap-3">
      <div class="w-8 h-8 rounded-lg bg-[#FF9F0A] flex items-center justify-center font-bold text-black text-sm">Σ</div>
      <div>
        <h1 class="text-sm font-bold text-white tracking-tight">Chinese-Khmer SRT Translator</h1>
        <p class="text-[10px] text-[#777]">Standalone Single-File Web App • Runs in Any Browser</p>
      </div>
    </div>
    <div class="flex items-center gap-2">
      <div class="flex items-center bg-[#1A1A1A] border border-[#2E2E2E] rounded-lg px-2.5 py-1 text-xs">
        <span class="text-[#888] mr-2 text-[11px]">Gemini API Key:</span>
        <input id="userApiKey" type="password" placeholder="AIzaSy..." class="bg-transparent text-white font-mono text-xs focus:outline-none w-36" onchange="localStorage.setItem('gemini_api_key', this.value.trim())">
      </div>
      <button onclick="handleExportSRT()" class="px-3 py-1.5 bg-[#FF9F0A] hover:bg-[#e68e09] text-black font-semibold text-xs rounded-lg transition-colors">Export .SRT</button>
      <button onclick="handleExportVTT()" class="px-3 py-1.5 bg-[#222] hover:bg-[#2A2A2A] text-white font-medium text-xs rounded-lg transition-colors border border-[#333]">Export .VTT</button>
    </div>
  </header>
  <main class="flex-1 p-6 max-w-7xl w-full mx-auto grid grid-cols-1 lg:grid-cols-12 gap-6">
    <div class="lg:col-span-5 space-y-4">
      <div class="bg-[#141414] border border-[#242424] rounded-xl p-4 space-y-3">
        <div class="text-xs font-bold text-white uppercase tracking-wider">Load Subtitle or Video</div>
        <div class="grid grid-cols-2 gap-2">
          <label class="flex flex-col items-center justify-center p-4 border border-dashed border-[#333] hover:border-sky-500 rounded-lg cursor-pointer bg-[#0D0D0D]">
            <span class="text-xs text-sky-400 font-semibold mb-1">📄 Load SRT / VTT</span>
            <input type="file" accept=".srt,.vtt,.txt" class="hidden" onchange="handleSubFile(event)">
          </label>
          <label class="flex flex-col items-center justify-center p-4 border border-dashed border-[#333] hover:border-emerald-500 rounded-lg cursor-pointer bg-[#0D0D0D]">
            <span class="text-xs text-emerald-400 font-semibold mb-1">🎬 Load Video</span>
            <input type="file" accept="video/*" class="hidden" onchange="handleVidFile(event)">
          </label>
        </div>
      </div>
      <div class="bg-[#141414] border border-[#242424] rounded-xl p-3 relative overflow-hidden">
        <div class="relative bg-black rounded-lg aspect-video flex items-center justify-center overflow-hidden">
          <video id="videoPlayer" class="w-full h-full object-contain" ontimeupdate="handleTimeUpdate()"></video>
          <div id="subtitleOverlay" class="absolute bottom-4 left-4 right-4 text-center pointer-events-none text-white font-bold text-sm bg-black/75 px-3 py-1.5 rounded-lg border border-white/10 hidden khmer-font"></div>
        </div>
      </div>
      <div class="bg-[#141414] border border-[#242424] rounded-xl p-4 space-y-2">
        <button onclick="cleanAmounts()" class="w-full text-left px-3 py-2 rounded-lg bg-[#1A1A1A] hover:bg-[#222] border border-[#2A2A2A] text-xs text-amber-300 font-medium">✨ Convert Numbers to Khmer Words (100000 ➔ មួយសែន)</button>
        <button onclick="cleanForeign()" class="w-full text-left px-3 py-2 rounded-lg bg-[#1A1A1A] hover:bg-[#222] border border-[#2A2A2A] text-xs text-sky-300 font-medium">🧹 Purge Burmese & Arabic Leaks (ခរុ, ـینگ ➔ ខ្មែរ)</button>
      </div>
    </div>
    <div class="lg:col-span-7 flex flex-col bg-[#141414] border border-[#242424] rounded-xl overflow-hidden">
      <div class="p-4 border-b border-[#242424] flex items-center justify-between bg-[#161616]">
        <div>
          <h2 class="text-sm font-bold text-white">Subtitle Workbench</h2>
          <p class="text-xs text-[#777]" id="statsLabel">3 blocks</p>
        </div>
        <button onclick="translateGemini()" class="px-3.5 py-1.5 bg-emerald-500 hover:bg-emerald-400 text-black font-bold text-xs rounded-lg shadow-md shadow-emerald-950/40">✨ Translate All (Gemini)</button>
      </div>
      <div id="subtitlesList" class="flex-1 p-4 overflow-y-auto max-h-[680px] space-y-3"></div>
    </div>
  </main>
  <script>
    let blocks = [
      { index: 1, timecode: "00:00:01,000 --> 00:00:03,500", text: "这里有100000元，给你做投资。", translatedText: "នេះជាប្រាក់មួយសែនយ័ន ទុកសម្រាប់អ្នកវិនិយោគ។" },
      { index: 2, timecode: "00:00:04,000 --> 00:00:07,000", text: "我们需要100,000,000资金支持项目！", translatedText: "យើងត្រូវការទុនមួយរយលាន ដើម្បីគាំទ្រគម្រោងនេះ!" },
      { index: 3, timecode: "00:00:07,500 --> 00:00:10,000", text: "姐夫，你能不能借我1000000元？", translatedText: "បងថ្លៃ តើបងអាចឱ្យខ្ញុំខ្ចីមួយលានយ័នបានទេ?" }
    ];
    const K_DIGITS = ["សូន្យ", "មួយ", "ពីរ", "បី", "បួន", "ប្រាំ", "ប្រាំមួយ", "ប្រាំពីរ", "ប្រាំបី", "ប្រាំបួន"];
    const K_TENS = ["", "ដប់", "ម្ភៃ", "សាមសិប", "សែសិប", "ហាសិប", "ហុកសិប", "ចិតសិប", "ប៉ែតសិប", "កៅសិប"];

    window.addEventListener("DOMContentLoaded", () => {
      const k = localStorage.getItem("gemini_api_key");
      if (k) document.getElementById("userApiKey").value = k;
      render();
    });

    function render() {
      document.getElementById("statsLabel").textContent = blocks.length + " subtitle blocks";
      document.getElementById("subtitlesList").innerHTML = blocks.map((b, i) => \\\`
        <div class="bg-[#181818] border border-[#262626] rounded-xl p-3 space-y-2">
          <div class="flex items-center justify-between text-[11px] text-[#777]"><span class="font-bold text-sky-400">#\\\${b.index}</span><span class="font-mono">\\\${b.timecode}</span></div>
          <div class="text-xs text-[#CCC]">\\\${b.text}</div>
          <input type="text" value="\\\${b.translatedText || ''}" onchange="blocks[\\\${i}].translatedText=this.value" class="w-full bg-[#101010] border border-[#2E2E2E] rounded-lg px-3 py-1.5 text-xs text-white khmer-font focus:outline-none" />
        </div>
      \\\`).join("");
    }

    function intToWords(val) {
      let n = BigInt(val);
      if (n === 0n) return "";
      let r = "";
      if (n >= 100000n) { r += K_DIGITS[Number(n / 100000n)] + "សែន"; n %= 100000n; }
      if (n >= 10000n) { r += K_DIGITS[Number(n / 10000n)] + "ម៉ឺន"; n %= 10000n; }
      if (n >= 1000n) { r += K_DIGITS[Number(n / 1000n)] + "ពាន់"; n %= 1000n; }
      if (n >= 100n) { r += K_DIGITS[Number(n / 100n)] + "រយ"; n %= 100n; }
      if (n > 0n) {
        const rem = Number(n);
        if (rem < 10) r += K_DIGITS[rem];
        else if (rem < 20) r += "ដប់" + (rem > 10 ? K_DIGITS[rem - 10] : "");
        else r += K_TENS[Math.floor(rem / 10)] + ((rem % 10) > 0 ? K_DIGITS[rem % 10] : "");
      }
      return r;
    }

    function numToKhmer(s) {
      const c = s.replace(/[,.]/g, "").trim();
      if (!c || !/^\\\\d+$/.test(c)) return s;
      const num = BigInt(c);
      if (num === 0n) return "សូន្យ";
      if (num >= 1000000n) {
        const mil = num / 1000000n;
        const rem = num % 1000000n;
        const p = mil >= 1000n ? (intToWords(mil / 1000n) + "ពាន់" + intToWords(mil % 1000n) + "លាន") : (intToWords(mil) + "លាន");
        return rem > 0n ? p + " " + intToWords(rem) : p;
      }
      return intToWords(num);
    }

    function convertAmounts(t) { return (t || "").replace(/(?<![a-zA-Z\\\\d])(\\\\d{1,3}(?:,\\\\d{3})+|\\\\d{4,})(?![a-zA-Z\\\\d])/g, m => numToKhmer(m)); }
    function cleanAmounts() { blocks.forEach(b => { if (b.translatedText) b.translatedText = convertAmounts(b.translatedText); }); render(); }
    function cleanForeign() { blocks.forEach(b => { if (b.translatedText) b.translatedText = b.translatedText.replace(/ခរុ/g, "គូទខ្យង").replace(/[\\\\u1000-\\\\u109f\\\\u0600-\\\\u06ff]/g, "").trim(); }); render(); }

    async function translateGemini() {
      const k = document.getElementById("userApiKey").value.trim() || localStorage.getItem("gemini_api_key");
      if (!k) return alert("Please enter your Gemini API Key in the top bar.");
      const text = blocks.map(b => "#" + b.index + ": " + b.text).join("\\\\n");
      const prompt = "Translate into natural Khmer. 100000->មួយសែន, 1000000->មួយលាន, 10000000->ដប់លាន, 100000000->មួយរយលាន. Husband->ស្វាមី/ប្ដី, Brother-in-law->បងថ្លៃ. Format: #idx: [Khmer]\\\\n\\\\n" + text;
      try {
        const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + k, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        });
        const d = await res.json();
        const t = d.candidates?.[0]?.content?.parts?.[0]?.text || "";
        t.split("\\\\n").forEach(l => {
          const m = l.match(/^#(\\\\d+):\\\\s*(.*)$/);
          if (m) {
            const b = blocks.find(x => x.index === parseInt(m[1], 10));
            if (b) b.translatedText = convertAmounts(m[2].trim());
          }
        });
        render();
        alert("Translation complete!");
      } catch (e) { alert("Error: " + e.message); }
    }

    function handleVidFile(e) {
      const f = e.target.files?.[0]; if (f) { const v = document.getElementById("videoPlayer"); v.src = URL.createObjectURL(f); v.play(); }
    }
    function handleSubFile(e) {
      const f = e.target.files?.[0];
      if (f) {
        const r = new FileReader();
        r.onload = ev => {
          const clean = ev.target.result.replace(/\\\\r\\\\n/g, "\\\\n").replace(/\\\\r/g, "\\\\n");
          blocks = clean.split(/\\\\n\\\\s*\\\\n/).map(p => {
            const l = p.trim().split("\\\\n");
            return { index: parseInt(l[0], 10) || 1, timecode: l[1] || "", text: l.slice(2).join(" "), translatedText: "" };
          }).filter(x => x.timecode.includes("-->"));
          render();
        };
        r.readAsText(f);
      }
    }
    function handleTimeUpdate() {
      const cur = document.getElementById("videoPlayer").currentTime;
      const b = blocks.find(x => {
        const p = x.timecode.split("-->");
        if (p.length === 2) {
          const s = parseT(p[0]), e = parseT(p[1]);
          return cur >= s && cur <= e;
        }
        return false;
      });
      const o = document.getElementById("subtitleOverlay");
      if (b && (b.translatedText || b.text)) { o.textContent = b.translatedText || b.text; o.classList.remove("hidden"); }
      else o.classList.add("hidden");
    }
    function parseT(t) { const p = t.trim().replace(",", ".").split(":"); return p.length === 3 ? parseFloat(p[0])*3600 + parseFloat(p[1])*60 + parseFloat(p[2]) : 0; }
    function handleExportSRT() {
      const c = blocks.map(b => \\\`\\\${b.index}\\\\n\\\${b.timecode}\\\\n\\\${b.translatedText || b.text}\\\`).join("\\\\n\\\\n");
      const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([c], { type: "text/srt;charset=utf-8;" })); a.download = "subtitles_khmer.srt"; a.click();
    }
    function handleExportVTT() {
      const c = "WEBVTT\\\\n\\\\n" + blocks.map(b => \\\`\\\${b.index}\\\\n\\\${b.timecode.replace(/,/g, ".")}\\\\n\\\${b.translatedText || b.text}\\\`).join("\\\\n\\\\n");
      const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([c], { type: "text/vtt;charset=utf-8;" })); a.download = "subtitles_khmer.vtt"; a.click();
    }
  </script>
</body>
</html>`;
}

// Endpoint to download the standalone, single-file runnable HTML App
app.get("/api/download-app-html", (req, res) => {
  try {
    const html = generateStandaloneAppHtml();
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="chinese-khmer-translator-app.html"');
    return res.send(html);
  } catch (error: any) {
    console.error("Error creating standalone app HTML:", error);
    return res.status(500).json({ error: error.message || "Failed to generate standalone HTML app." });
  }
});

// Endpoint to download all project source code compiled into a single interactive HTML file
app.get("/api/download-all-code-html", (req, res) => {
  try {
    const html = generateAllCodeHtml(process.cwd());
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="chinese-khmer-translator-all-code.html"');
    return res.send(html);
  } catch (error: any) {
    console.error("Error creating all-code HTML bundle:", error);
    return res.status(500).json({ error: error.message || "Failed to generate code HTML bundle." });
  }
});

// Endpoint to view any source file directly
app.get("/api/source-file", (req, res) => {
  const queryPath = req.query.path as string;
  if (!queryPath) {
    return res.status(400).json({ error: "Query parameter 'path' is required." });
  }

  // Whitelist safe allowed files to prevent path traversal
  const allowedFiles = [
    "package.json",
    "tsconfig.json",
    "vite.config.ts",
    "index.html",
    "metadata.json",
    ".env.example",
    "README.md",
    "server.ts",
    "src/main.tsx",
    "src/App.tsx",
    "src/types.ts",
    "src/index.css",
    "src/components/VideoPlayerStudio.tsx",
    "src/utils/srtParser.ts",
    "src/utils/exampleSubtitles.ts",
    "src/utils/videoSubtitleExtractor.ts",
  ];

  if (!allowedFiles.includes(queryPath)) {
    return res.status(403).json({ error: "Access to this file path is not permitted." });
  }

  const fullPath = path.join(process.cwd(), queryPath);
  if (!fs.existsSync(fullPath)) {
    return res.status(404).json({ error: "File not found." });
  }

  try {
    const content = fs.readFileSync(fullPath, "utf-8");
    return res.json({ path: queryPath, content });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "Failed to read file." });
  }
});

// Configure Vite middleware or static serving
async function startServer() {
  // Dedicated health check endpoints for Cloud Run / load balancers / deployment rollout probes
  app.get(["/healthz", "/_health", "/health", "/api/health"], (req, res) => {
    return res.status(200).json({ status: "healthy", timestamp: Date.now() });
  });

  // Ensure all unhandled /api/* requests return JSON 404 and NEVER fall through to HTML SPA fallback
  app.all("/api/*", (req, res) => {
    res.status(404).json({ error: `API route ${req.method} ${req.originalUrl} not found.` });
  });

  const distPath = path.join(process.cwd(), "dist");
  const indexPath = path.join(distPath, "index.html");
  const hasBuiltDist = fs.existsSync(indexPath);
  const isDevMode = process.env.NODE_ENV === "development";

  // When deployed to production (Cloud Run, Docker container, or whenever dist has been built):
  // serve pre-built static bundle to ensure fast startup (<200ms) and avoid spinning up Vite dev server.
  if (!isDevMode && hasBuiltDist) {
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(indexPath);
    });
  } else {
    // Mount Vite in middleware mode for local development
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
      },
      appType: "spa",
    });
    app.use(vite.middlewares);
  }

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server is running on http://0.0.0.0:${PORT}`);
  });

  server.on("error", (err: any) => {
    console.error(`[Server Error] Failed to listen on 0.0.0.0:${PORT}:`, err);
  });

  // Handle graceful shutdown for Cloud Run container revisions
  process.on("SIGTERM", () => {
    console.log("SIGTERM signal received: closing HTTP server");
    server.close(() => {
      console.log("HTTP server closed.");
      process.exit(0);
    });
  });
}

startServer();
