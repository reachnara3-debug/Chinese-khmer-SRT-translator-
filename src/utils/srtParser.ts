import { SubtitleBlock } from "../types";

/**
 * Strips ellipses and variations of dot trailers ("...", "…", "....", "( ... )", etc.)
 * from sentence text.
 */
export function cleanEllipses(text: string): string {
  if (!text) return "";
  return text
    .replace(/\(\s*\.{2,}\s*\)/g, "") // "( ... )"
    .replace(/\(\s*…+\s*\)/g, "")     // "( … )"
    .replace(/（\s*\.{2,}\s*）/g, "") // full-width "（ ... ）"
    .replace(/（\s*…+\s*）/g, "")     // full-width "（ … ）"
    .replace(/\.{2,}/g, "")          // "..." or ".."
    .replace(/…+/g, "")              // "…"
    .replace(/·{2,}/g, "")           // "··"
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export const KHMER_DIGIT_WORDS = ["សូន្យ", "មួយ", "ពីរ", "បី", "បួន", "ប្រាំ", "ប្រាំមួយ", "ប្រាំពីរ", "ប្រាំបី", "ប្រាំបួន"];
export const KHMER_TENS_WORDS = ["", "ដប់", "ម្ភៃ", "សាមសិប", "សែសិប", "ហាសិប", "ហុកសិប", "ចិតសិប", "ប៉ែតសិប", "កៅសិប"];

export function convertIntegerToKhmerWords(n: bigint | number): string {
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
export function numberToKhmerWords(numStr: string): string {
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
export function convertSentenceAmountsToKhmerWords(text: string): string {
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

/**
 * Normalizes numbers and amounts to pure digits without commas (,) or periods (.) as thousand separators.
 */
export function formatAmountNumbers(text: string): string {
  if (!text) return "";
  return convertSentenceAmountsToKhmerWords(text);
}

/**
 * Automatically purges and repairs foreign scripts, leaks, and slips into genuine Khmer:
 * - Translates amount numbers into Khmer sentence words (100000 -> មួយសែន, 100000000 -> មួយរយលាន)
 * - Converts Burmese/Myanmar leaks (e.g. "ခរុ" / "ခរុ" snail/spiral/corrugated -> "គូទខ្យង" / "បំពង់គូទខ្យង")
 * - Converts Arabic leaks (e.g. "ـینگ" -> "អ៊ិង" / "យីង")
 * - Fixes common colloquial/typo slips (e.g. "នេះដែ " -> "នេះដែរ ")
 * - Purges stray Myanmar, Arabic, Thai, Lao, Cyrillic, Devanagari characters
 * - Cleans orphaned Khmer vowels or subscript coengs left behind
 * - Cleans multiple spaces
 */
export function cleanForeignAndAnomalousScripts(text: string, sourceChinese?: string): string {
  if (!text) return "";
  let res = convertSentenceAmountsToKhmerWords(text);

  // 1. Myanmar / Burmese leaks: "ခរុ" / "ခរុ" (spiral/snail/corrugation)
  res = res.replace(/ခរុ\s*បំពង់|ခរុ\s*បំពង់/g, "បំពង់គូទខ្យង");
  res = res.replace(/បំពង់\s*ခរុ|បំពង់\s*ခរុ/g, "បំពង់គូទខ្យង");
  res = res.replace(/ခរុ|ခរុ/g, "គូទខ្យង");

  // 2. Arabic leaks: 'ـینگ' leaked from Chinese Pinyin 'ying'
  res = res.replace(/អុ?[ـ\s]*[یي]نگ/g, "អ៊ិង");
  res = res.replace(/[ـ\s]*[یي]نگ/g, "យីង");

  // 3. Crocodile calques
  res = res.replace(/ស្បែកត្រីក្រពើ|ស្បែកត្រីក្រពេី/g, "ស្បែកក្រពេី");
  res = res.replace(/កូនត្រីក្រពើ|កូនត្រីក្រពេី/g, "កូនក្រពេី");
  res = res.replace(/ត្រីក្រពើ|ត្រីក្រពេី/g, "ក្រពេី");
  res = res.replace(/ក្រពើ/g, "ក្រពេី");

  // 4. Common colloquial or transcription typos
  res = res.replace(/នេះដែ(\s+)/g, "នេះដែរ$1");

  // 5. Remove any foreign scripts:
  // Myanmar: \u1000-\u109f, \ua9e0-\ua9fe
  // Arabic: \u0600-\u06ff, \u0750-\u077f, \u08a0-\u08ff, \ufb50-\ufdff, \ufe70-\ufeff
  // Thai: \u0e00-\u0e7f
  // Lao: \u0e80-\u0eff
  // Cyrillic: \u0400-\u04ff
  // Devanagari: \u0900-\u097f
  res = res.replace(/[\u1000-\u109f\ua9e0-\ua9fe\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff\u0e00-\u0e7f\u0e80-\u0eff\u0400-\u04ff\u0900-\u097f]/g, "");

  // 6. Clean orphaned Khmer vowels or subscript coengs left behind (e.g. ' ុបំពង់' -> 'បំពង់')
  res = res.replace(/(^|\s)[្\u17b6-\u17d1]+/g, "$1");

  // 7. Strip ellipses if any
  res = res.replace(/\(\s*\.{2,}\s*\)/g, "").replace(/\.{2,}|…|·{2,}/g, "");

  // 8. Clean double spaces
  res = res.replace(/[ \t]{2,}/g, " ").trim();

  // If source text is available, align kinship as well
  if (sourceChinese) {
    res = alignKinshipTerms(res, sourceChinese);
  }

  // Final format check for amount numbers
  res = convertSentenceAmountsToKhmerWords(res);

  return res;
}

/**
 * Converts milliseconds to standard SRT timecode (00:00:00,000)
 */
export function msToSRTTimecode(ms: number): string {
  const safeMs = Math.max(0, Math.round(ms));
  const totalSec = Math.floor(safeMs / 1000);
  const msec = safeMs % 1000;
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  return `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(msec).padStart(3, "0")}`;
}

/**
 * Converts various time specifications in subtitles (especially SAMI) to milliseconds.
 * Supports integer ms, decimal seconds, timecodes (HH:MM:SS.mmm, MM:SS.mmm), and trailing ms/s units.
 */
export function parseSamiTimeToMs(val: string): number {
  if (!val) return 0;
  const clean = val.trim().replace(/['"]/g, "");
  
  // Format: 00:01:23.456 or 01:23.456 or 00:01:23,456
  if (clean.includes(":")) {
    const parts = clean.replace(",", ".").split(":");
    if (parts.length === 3) {
      const h = parseFloat(parts[0]) || 0;
      const m = parseFloat(parts[1]) || 0;
      const s = parseFloat(parts[2]) || 0;
      return Math.round((h * 3600 + m * 60 + s) * 1000);
    } else if (parts.length === 2) {
      const m = parseFloat(parts[0]) || 0;
      const s = parseFloat(parts[1]) || 0;
      return Math.round((m * 60 + s) * 1000);
    }
  }

  // Format: "1.5s"
  if (clean.toLowerCase().endsWith("s") && !clean.toLowerCase().endsWith("ms")) {
    const sec = parseFloat(clean.slice(0, -1));
    return isNaN(sec) ? 0 : Math.round(sec * 1000);
  }

  // Format: "1234ms"
  if (clean.toLowerCase().endsWith("ms")) {
    const ms = parseFloat(clean.slice(0, -2));
    return isNaN(ms) ? 0 : Math.round(ms);
  }

  // Raw integer or decimal ms
  const num = parseFloat(clean);
  return isNaN(num) ? 0 : Math.round(num);
}

/**
 * Decodes HTML entities and strips non-dialogue HTML tags from SAMI cues
 */
export function cleanHtmlText(html: string): string {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#160;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, dec) => {
      try {
        return String.fromCharCode(parseInt(dec, 10));
      } catch {
        return "";
      }
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      try {
        return String.fromCharCode(parseInt(hex, 16));
      } catch {
        return "";
      }
    })
    .trim();
}

/**
 * Robustly reads any subtitle file (SMI, SRT, VTT, etc.) with automatic encoding detection.
 * Handles UTF-8 (BOM or no BOM), UTF-16LE, UTF-16BE, EUC-KR / CP949 (standard Korean SMI),
 * GB18030 / GBK / GB2312 (standard Chinese SMI), Big5, Shift-JIS, and Windows-1252.
 */
export async function readSubtitleFileAsText(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  if (bytes.length === 0) return "";

  // 1. Check UTF-8 BOM: EF BB BF
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }

  // 2. Check UTF-16LE BOM: FF FE
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }

  // 3. Check UTF-16BE BOM: FE FF
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }

  // 4. Check for UTF-16LE without BOM (common in Windows Notepad saves)
  if (bytes.length >= 4) {
    if (bytes[1] === 0x00 && bytes[3] === 0x00) {
      try {
        const decoded = new TextDecoder("utf-16le").decode(bytes);
        if (/<sami|<sync|<head|<title|-->/i.test(decoded)) {
          return decoded;
        }
      } catch {}
    }
  }

  // 5. Try strict UTF-8 first
  try {
    const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
    const text = utf8Decoder.decode(bytes);

    // Check if there is an explicit charset declared in HTML/SAMI header (e.g. charset=euc-kr)
    const charsetMatch = text.match(/charset\s*=\s*['"]?([a-zA-Z0-9_-]+)/i);
    if (charsetMatch) {
      const declared = charsetMatch[1].toLowerCase();
      if (declared.includes("euc-kr") || declared.includes("cp949") || declared.includes("korean")) {
        try {
          return new TextDecoder("euc-kr").decode(bytes);
        } catch {}
      } else if (declared.includes("gb2312") || declared.includes("gbk") || declared.includes("gb18030")) {
        try {
          return new TextDecoder("gb18030").decode(bytes);
        } catch {}
      } else if (declared.includes("big5")) {
        try {
          return new TextDecoder("big5").decode(bytes);
        } catch {}
      } else if (declared.includes("shift_jis") || declared.includes("sjis")) {
        try {
          return new TextDecoder("shift_jis").decode(bytes);
        } catch {}
      }
    }

    return text;
  } catch {
    // If invalid UTF-8 byte sequences found, check ASCII header for declared charset
    const asciiPreview = String.fromCharCode(...Array.from(bytes.subarray(0, Math.min(bytes.length, 1200))));
    const charsetMatch = asciiPreview.match(/charset\s*=\s*['"]?([a-zA-Z0-9_-]+)/i);
    if (charsetMatch) {
      const declared = charsetMatch[1].toLowerCase();
      const enc = declared.includes("gb") ? "gb18030" :
                  declared.includes("kr") || declared.includes("949") ? "euc-kr" :
                  declared.includes("big5") ? "big5" :
                  declared.includes("shift") || declared.includes("jis") ? "shift_jis" : "utf-8";
      try {
        return new TextDecoder(enc).decode(bytes);
      } catch {}
    }

    // Try common Asian legacy encodings: EUC-KR (most common for .smi), then GB18030, Big5, Shift_JIS
    for (const fallback of ["euc-kr", "gb18030", "big5", "shift_jis", "windows-1252"]) {
      try {
        const decoded = new TextDecoder(fallback).decode(bytes);
        if (decoded && (/<SYNC/i.test(decoded) || /<sami/i.test(decoded) || /-->/.test(decoded))) {
          return decoded;
        }
      } catch {}
    }

    return new TextDecoder("utf-8").decode(bytes);
  }
}

/**
 * Checks if the text has any valid subtitle timestamps across all supported formats
 */
export function isSRTFormat(text: string): boolean {
  if (!text) return false;
  return (
    text.includes("-->") ||
    /<SYNC\b/i.test(text) ||
    /<sami\b/i.test(text) ||
    /\[\d{2}:\d{2}\.\d{2,3}\]/.test(text) ||
    text.includes("Dialogue:") ||
    /<p[^>]*begin=/i.test(text) ||
    /^\d{1,2}:\d{2}:\d{2}[,.]\d+/m.test(text)
  );
}

/**
 * Checks if text is in SAMI (.smi, .sami) format
 */
export function isSamiSubtitle(text: string): boolean {
  if (!text) return false;
  return /<SYNC\b/i.test(text) || /<SAMI\b/i.test(text);
}

/**
 * Normalizes time format to standard SRT (00:00:00,000)
 */
export function normalizeSRTTimecode(timestamp: string): string {
  let clean = timestamp.trim().replace(".", ",");
  const parts = clean.split(":");
  if (parts.length === 2) {
    // MM:SS,mmm -> 00:MM:SS,mmm
    clean = `00:${clean}`;
  }
  const [hms, ms] = clean.split(",");
  const [h, m, s] = (hms || "00:00:00").split(":");
  const hh = String(parseInt(h || "0", 10)).padStart(2, "0");
  const mm = String(parseInt(m || "0", 10)).padStart(2, "0");
  const ss = String(parseInt(s || "0", 10)).padStart(2, "0");
  const mmm = String(parseInt((ms || "000").padEnd(3, "0").slice(0, 3), 10)).padStart(3, "0");
  return `${hh}:${mm}:${ss},${mmm}`;
}

export interface SubtitleLanguageTrack {
  id: string; // e.g. "zh", "kr", "en", "all", "KRCC", etc.
  code: string; // "zh", "ko", "en", "ja", "other"
  label: string; // e.g. "🇨🇳 Chinese (ZH)", "🇰🇷 Korean (KO)", "🇺🇸 English (EN)"
  className?: string;
  cueCount: number;
  sampleText: string;
  isPrimary?: boolean;
}

/**
 * Detects the language script of a sample text
 */
export function detectTextScript(text: string): { code: string; label: string; flag: string } {
  const clean = text.replace(/<[^>]+>/g, "").replace(/&[a-z]+;/gi, " ").trim();
  
  const hanziCount = (clean.match(/[\u4e00-\u9fa5]/g) || []).length;
  const hangulCount = (clean.match(/[\uac00-\ud7af\u1100-\u11ff]/g) || []).length;
  const kanaCount = (clean.match(/[\u3040-\u30ff]/g) || []).length;
  const khmerCount = (clean.match(/[\u1780-\u17ff]/g) || []).length;
  const thaiCount = (clean.match(/[\u0e00-\u0e7f]/g) || []).length;
  const latinCount = (clean.match(/[a-zA-Z]/g) || []).length;

  if (hanziCount > 2 || (hanziCount > 0 && hanziCount >= hangulCount && hanziCount >= kanaCount)) {
    return { code: "zh", label: "Chinese (ZH)", flag: "🇨🇳" };
  }
  if (hangulCount > 2 || hangulCount > hanziCount) {
    return { code: "ko", label: "Korean (KO)", flag: "🇰🇷" };
  }
  if (kanaCount > 2 || kanaCount > hanziCount) {
    return { code: "ja", label: "Japanese (JA)", flag: "🇯🇵" };
  }
  if (khmerCount > 2) {
    return { code: "km", label: "Khmer (KM)", flag: "🇰🇭" };
  }
  if (thaiCount > 2) {
    return { code: "th", label: "Thai (TH)", flag: "🇹🇭" };
  }
  if (latinCount > 0) {
    return { code: "en", label: "English (EN)", flag: "🇺🇸" };
  }
  return { code: "other", label: "Other Track", flag: "🌐" };
}

/**
 * Scans SAMI subtitle text and detects all available language tracks using fast linear scanning
 */
export function detectSAMILanguageTracks(samiText: string): SubtitleLanguageTrack[] {
  const cleanText = samiText.replace(/\r\n/g, "\n");
  
  // 1. Check <STYLE> section for defined classes (e.g. .ENCC { Name: English; lang: en-US; })
  const styleMatch = cleanText.match(/<STYLE[^>]*>([\s\S]*?)<\/STYLE>/i);
  const styleClasses: Record<string, { name?: string; lang?: string }> = {};
  if (styleMatch) {
    const styleBody = styleMatch[1];
    const classDefRegex = /\.([a-zA-Z0-9_-]+)\s*\{([^}]+)\}/g;
    let cm: RegExpExecArray | null;
    while ((cm = classDefRegex.exec(styleBody)) !== null) {
      const cls = cm[1];
      const props = cm[2];
      const nameM = props.match(/\bName\s*:\s*([^;}\r\n]+)/i);
      const langM = props.match(/\blang\s*:\s*([^;}\r\n]+)/i);
      styleClasses[cls.toLowerCase()] = {
        name: nameM ? nameM[1].trim() : undefined,
        lang: langM ? langM[1].trim() : undefined,
      };
    }
  }

  // 2. Fast linear scan of all <SYNC ...> tags
  const syncTagRegex = /<SYNC\b([^>]*)>/gi;
  interface SyncLoc {
    startMs: number;
    contentStart: number;
    contentEnd: number;
  }
  const syncLocs: SyncLoc[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = syncTagRegex.exec(cleanText)) !== null) {
    const attrs = sm[1];
    const startMatch = attrs.match(/\bStart\s*=\s*(['"]?)([^'"\s>]+)\1/i);
    if (!startMatch) continue;
    const startMs = parseSamiTimeToMs(startMatch[2]);
    if (syncLocs.length > 0) {
      syncLocs[syncLocs.length - 1].contentEnd = sm.index;
    }
    syncLocs.push({
      startMs,
      contentStart: sm.index + sm[0].length,
      contentEnd: cleanText.length,
    });
  }

  const classData: Record<
    string,
    {
      cues: { startMs: number; text: string }[];
      sample: string;
      originalClass: string;
    }
  > = {};

  const pTagRegex = /<P\b([^>]*)>/gi;

  for (const loc of syncLocs) {
    let rawContent = cleanText.slice(loc.contentStart, loc.contentEnd);
    const closingIdx = rawContent.search(/<\/(?:BODY|SAMI)/i);
    if (closingIdx !== -1) {
      rawContent = rawContent.substring(0, closingIdx);
    }

    pTagRegex.lastIndex = 0;
    interface PLoc {
      cls: string;
      originalClass: string;
      bodyStart: number;
      bodyEnd: number;
    }
    const pLocs: PLoc[] = [];
    let pm: RegExpExecArray | null;
    while ((pm = pTagRegex.exec(rawContent)) !== null) {
      const attrs = pm[1];
      const classMatch = attrs.match(/\bclass\s*=\s*(['"]?)([^'">\s]+)\1/i);
      const rawCls = classMatch ? classMatch[2] : "default";
      const cls = rawCls.toLowerCase();
      if (pLocs.length > 0) {
        pLocs[pLocs.length - 1].bodyEnd = pm.index;
      }
      pLocs.push({
        cls,
        originalClass: rawCls,
        bodyStart: pm.index + pm[0].length,
        bodyEnd: rawContent.length,
      });
    }

    if (pLocs.length > 0) {
      for (const pl of pLocs) {
        const bodyText = rawContent.slice(pl.bodyStart, pl.bodyEnd);
        const cleanDialogue = cleanHtmlText(bodyText);
        if (!classData[pl.cls]) {
          classData[pl.cls] = { cues: [], sample: "", originalClass: pl.originalClass };
        }
        if (cleanDialogue && cleanDialogue !== "&nbsp;") {
          classData[pl.cls].cues.push({ startMs: loc.startMs, text: cleanDialogue });
          if (!classData[pl.cls].sample && cleanDialogue.length > 2) {
            classData[pl.cls].sample = cleanDialogue;
          }
        }
      }
    } else {
      const plainText = cleanHtmlText(rawContent);
      if (plainText && plainText !== "&nbsp;") {
        if (!classData["default"]) {
          classData["default"] = { cues: [], sample: "", originalClass: "default" };
        }
        classData["default"].cues.push({ startMs: loc.startMs, text: plainText });
        if (!classData["default"].sample) {
          classData["default"].sample = plainText;
        }
      }
    }
  }

  const tracks: SubtitleLanguageTrack[] = [];
  for (const [clsKey, data] of Object.entries(classData)) {
    if (data.cues.length === 0) continue;
    const styleMeta = styleClasses[clsKey];
    const scriptInfo = detectTextScript(data.sample || (data.cues[0]?.text || ""));

    let label = `${scriptInfo.flag} ${scriptInfo.label}`;
    if (styleMeta?.name) {
      label = `${scriptInfo.flag} ${styleMeta.name} (${data.originalClass})`;
    } else if (clsKey !== "default") {
      if (/zh|chi|cmn/i.test(clsKey)) {
        label = `🇨🇳 Chinese (${data.originalClass})`;
      } else if (/kr|ko|kor/i.test(clsKey)) {
        label = `🇰🇷 Korean (${data.originalClass})`;
      } else if (/en|eng/i.test(clsKey)) {
        label = `🇺🇸 English (${data.originalClass})`;
      } else if (/ja|jp|jpn/i.test(clsKey)) {
        label = `🇯🇵 Japanese (${data.originalClass})`;
      }
    }

    tracks.push({
      id: clsKey,
      code: scriptInfo.code,
      label,
      className: data.originalClass,
      cueCount: data.cues.length,
      sampleText: data.sample || data.cues[0]?.text || "",
    });
  }

  tracks.sort((a, b) => {
    const order: Record<string, number> = { zh: 1, ko: 2, en: 3, ja: 4, km: 5 };
    const orderA = order[a.code] || 99;
    const orderB = order[b.code] || 99;
    if (orderA !== orderB) return orderA - orderB;
    return b.cueCount - a.cueCount;
  });

  return tracks;
}

/**
 * Parses SAMI (.smi, .sami) subtitle format with optional single language track filtering
 */
export function parseSAMI(samiText: string, selectedTrackId?: string): SubtitleBlock[] {
  const cleanText = samiText.replace(/\r\n/g, "\n");

  // Start reading from the first <SYNC tag to avoid missing cues or getting tripped by malformed tags
  const firstSyncIdx = cleanText.search(/<SYNC\b/i);
  let textToParse = cleanText;
  if (firstSyncIdx !== -1) {
    textToParse = cleanText.substring(firstSyncIdx);
  } else {
    const bodyIdx = cleanText.search(/<BODY\b/i);
    if (bodyIdx !== -1) {
      textToParse = cleanText.substring(bodyIdx);
    }
  }

  const availableTracks = detectSAMILanguageTracks(samiText);
  let targetTrack = selectedTrackId?.toLowerCase();

  if (!targetTrack || targetTrack === "auto") {
    if (availableTracks.length > 0) {
      const zhTrack = availableTracks.find((t) => t.code === "zh");
      if (zhTrack) {
        targetTrack = zhTrack.id;
      } else {
        targetTrack = availableTracks[0].id;
      }
    }
  }

  // 1. Linear scan of all <SYNC ...> tags in textToParse
  const syncTagRegex = /<SYNC\b([^>]*)>/gi;
  interface RawSyncCue {
    startMs: number;
    endMsExplicit?: number;
    contentStart: number;
    contentEnd: number;
  }
  const syncLocs: RawSyncCue[] = [];
  let match: RegExpExecArray | null;

  while ((match = syncTagRegex.exec(textToParse)) !== null) {
    const attrs = match[1];
    const startMatch = attrs.match(/\bStart\s*=\s*(['"]?)([^'"\s>]+)\1/i);
    if (!startMatch) continue;
    const startMs = parseSamiTimeToMs(startMatch[2]);

    let endMsExplicit: number | undefined;
    const endMatch = attrs.match(/\bEnd\s*=\s*(['"]?)([^'"\s>]+)\1/i);
    if (endMatch) {
      endMsExplicit = parseSamiTimeToMs(endMatch[2]);
    } else {
      const durMatch = attrs.match(/\bDuration\s*=\s*(['"]?)([^'"\s>]+)\1/i);
      if (durMatch) {
        endMsExplicit = startMs + parseSamiTimeToMs(durMatch[2]);
      }
    }

    if (syncLocs.length > 0) {
      syncLocs[syncLocs.length - 1].contentEnd = match.index;
    }

    syncLocs.push({
      startMs,
      endMsExplicit,
      contentStart: match.index + match[0].length,
      contentEnd: textToParse.length,
    });
  }

  if (syncLocs.length === 0) return [];

  // Helper to extract dialogue for a cue from its content substring
  const extractDialogueForCue = (
    rawContent: string,
    trackId?: string
  ): { text: string; isExplicitBlank: boolean; trackMatched: boolean } => {
    let content = rawContent;
    const closingIdx = content.search(/<\/(?:BODY|SAMI)/i);
    if (closingIdx !== -1) {
      content = content.substring(0, closingIdx);
    }

    const pTagRegex = /<P\b([^>]*)>/gi;
    interface PLoc {
      cls: string;
      bodyStart: number;
      bodyEnd: number;
    }
    const pLocs: PLoc[] = [];
    let pm: RegExpExecArray | null;
    while ((pm = pTagRegex.exec(content)) !== null) {
      const attrs = pm[1];
      const classMatch = attrs.match(/\bclass\s*=\s*(['"]?)([^'">\s]+)\1/i);
      const cls = classMatch ? classMatch[2].toLowerCase() : "default";
      if (pLocs.length > 0) {
        pLocs[pLocs.length - 1].bodyEnd = pm.index;
      }
      pLocs.push({
        cls,
        bodyStart: pm.index + pm[0].length,
        bodyEnd: content.length,
      });
    }

    if (pLocs.length > 0) {
      const pItems = pLocs.map((pl) => {
        const rawBody = content.slice(pl.bodyStart, pl.bodyEnd);
        const clean = cleanHtmlText(rawBody);
        return { cls: pl.cls, rawBody, clean };
      });

      if (trackId && trackId !== "all" && trackId !== "default") {
        const matchingItems = pItems.filter((m) => {
          return (
            m.cls === trackId ||
            (trackId === "zh" && /zh|chi|cmn/i.test(m.cls)) ||
            (trackId === "ko" && /kr|ko|kor/i.test(m.cls)) ||
            (trackId === "en" && /en|eng/i.test(m.cls)) ||
            (trackId === "ja" && /ja|jp|jpn/i.test(m.cls))
          );
        });

        if (matchingItems.length > 0) {
          const combinedClean = matchingItems
            .map((m) => m.clean)
            .filter((t) => t && t !== "&nbsp;")
            .join("\n");
          const isBlank =
            !combinedClean ||
            matchingItems.every((m) => !m.clean || m.clean === "&nbsp;" || /^\s*(&nbsp;)?\s*$/i.test(m.rawBody));
          return { text: isBlank ? "" : combinedClean, isExplicitBlank: isBlank, trackMatched: true };
        }

        // Target track was specified but this sync block belongs to another track
        return { text: "", isExplicitBlank: true, trackMatched: false };
      }

      // No specific track or track is "all"/"default"
      const validItems = pItems.filter((m) => m.clean && m.clean !== "&nbsp;");
      if (validItems.length > 0) {
        return { text: validItems.map((m) => m.clean).join("\n"), isExplicitBlank: false, trackMatched: true };
      }

      const allBlank = pItems.every((m) => !m.clean || m.clean === "&nbsp;");
      return { text: "", isExplicitBlank: allBlank, trackMatched: true };
    }

    // Direct text inside sync without <P>
    const directClean = cleanHtmlText(content);
    const isBlank = !directClean || directClean === "&nbsp;" || /^\s*(&nbsp;)?\s*$/i.test(content);
    return { text: isBlank ? "" : directClean, isExplicitBlank: isBlank, trackMatched: true };
  };

  interface ProcessedCue {
    startMs: number;
    endMs: number;
    text: string;
  }

  const processed: ProcessedCue[] = [];
  let activeCue: { startMs: number; endMsExplicit?: number; text: string } | null = null;

  for (let i = 0; i < syncLocs.length; i++) {
    const loc = syncLocs[i];
    const rawContent = textToParse.slice(loc.contentStart, loc.contentEnd);
    const { text, isExplicitBlank, trackMatched } = extractDialogueForCue(rawContent, targetTrack);

    // If target track was specified and this sync tag belongs to a completely different language track,
    // skip it so it neither steals another track nor incorrectly closes the active cue.
    if (targetTrack && targetTrack !== "all" && targetTrack !== "default" && !trackMatched) {
      continue;
    }

    if (isExplicitBlank || text.length === 0) {
      if (activeCue) {
        const endMs = activeCue.endMsExplicit || Math.max(activeCue.startMs + 400, loc.startMs);
        processed.push({
          startMs: activeCue.startMs,
          endMs,
          text: activeCue.text,
        });
        activeCue = null;
      }
    } else {
      if (activeCue) {
        let endMs = activeCue.endMsExplicit;
        if (!endMs) {
          const maxDur = Math.max(2500, Math.min(7500, activeCue.text.length * 150));
          if (loc.startMs - activeCue.startMs > maxDur) {
            endMs = activeCue.startMs + maxDur;
          } else {
            endMs = Math.max(activeCue.startMs + 400, loc.startMs);
          }
        }
        processed.push({
          startMs: activeCue.startMs,
          endMs,
          text: activeCue.text,
        });
      }

      activeCue = {
        startMs: loc.startMs,
        endMsExplicit: loc.endMsExplicit,
        text,
      };
    }
  }

  if (activeCue) {
    const endMs =
      activeCue.endMsExplicit ||
      activeCue.startMs + Math.max(2500, Math.min(6000, activeCue.text.length * 150));
    processed.push({
      startMs: activeCue.startMs,
      endMs,
      text: activeCue.text,
    });
  }

  // Sort and ensure strictly positive durations
  processed.sort((a, b) => a.startMs - b.startMs);

  const blocks: SubtitleBlock[] = [];
  for (let i = 0; i < processed.length; i++) {
    const item = processed[i];
    const safeEndMs = Math.max(item.startMs + 400, item.endMs);
    const startStr = msToSRTTimecode(item.startMs);
    const endStr = msToSRTTimecode(safeEndMs);
    const timecode = `${startStr} --> ${endStr}`;
    const isTranslatable = item.text.length > 0;

    blocks.push({
      index: i + 1,
      timecode,
      text: item.text,
      translatedText: isTranslatable ? "" : item.text,
      status: isTranslatable ? "pending" : "done",
    });
  }

  return blocks;
}

/**
 * Filters a list of subtitle blocks by writing script (e.g. Chinese Hanzi, Korean Hangul, English)
 */
export function filterBlocksByScript(
  blocks: SubtitleBlock[],
  scriptFilter: "all" | "zh" | "ko" | "en" | "ja"
): SubtitleBlock[] {
  if (scriptFilter === "all") return blocks;

  return blocks.filter((b) => {
    const text = b.text.trim();
    if (scriptFilter === "zh") {
      return /[\u4e00-\u9fa5]/.test(text);
    }
    if (scriptFilter === "ko") {
      return /[\uac00-\ud7af\u1100-\u11ff]/.test(text);
    }
    if (scriptFilter === "ja") {
      return /[\u3040-\u30ff]/.test(text);
    }
    if (scriptFilter === "en") {
      // Latin letters, no CJK
      return /[a-zA-Z]/.test(text) && !/[\u4e00-\u9fa5\uac00-\ud7af\u3040-\u30ff]/.test(text);
    }
    return true;
  });
}

/**
 * Parses TTML / DFXP XML subtitle format (<p begin="..." end="...">text</p>)
 */
export function parseTTML(xmlText: string): SubtitleBlock[] {
  const pRegex = /<p[^>]*begin=['"]?([^'"]+)['"]?[^>]*end=['"]?([^'"]+)['"]?[^>]*>([\s\S]*?)<\/p>/gi;
  const blocks: SubtitleBlock[] = [];
  let match: RegExpExecArray | null;

  const parseTtmlTime = (tStr: string): string => {
    let clean = tStr.trim();
    if (clean.endsWith("s")) {
      const sec = parseFloat(clean);
      return msToSRTTimecode(sec * 1000);
    }
    return normalizeSRTTimecode(clean);
  };

  while ((match = pRegex.exec(xmlText)) !== null) {
    const startRaw = match[1];
    const endRaw = match[2];
    let content = match[3]
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .trim();

    if (content) {
      const start = parseTtmlTime(startRaw);
      const end = parseTtmlTime(endRaw);
      const timecode = `${start} --> ${end}`;
      const hasLetters = /[a-zA-Z\u4e00-\u9fa5\d]/.test(content);
      const isTranslatable = content.length > 0 && hasLetters;

      blocks.push({
        index: blocks.length + 1,
        timecode,
        text: content,
        translatedText: isTranslatable ? "" : content,
        status: isTranslatable ? "pending" : "done",
      });
    }
  }

  return blocks;
}

/**
 * Parses SubViewer (.sub) and SBV (.sbv) subtitle files
 */
export function parseSubViewer(subText: string): SubtitleBlock[] {
  const normalized = subText.replace(/\r\n/g, "\n").trim();
  const sections = normalized.split(/\n\s*\n/);
  const blocks: SubtitleBlock[] = [];

  for (const section of sections) {
    const lines = section.trim().split("\n");
    if (lines.length >= 2) {
      const timeLine = lines[0].trim();
      const parts = timeLine.split(",");
      if (parts.length === 2 && (parts[0].includes(":") || parts[0].includes("."))) {
        const start = normalizeSRTTimecode(parts[0]);
        const end = normalizeSRTTimecode(parts[1]);
        const text = lines.slice(1).join("\n").replace(/\[br\]/gi, "\n").trim();
        if (text) {
          const hasLetters = /[a-zA-Z\u4e00-\u9fa5\d]/.test(text);
          const isTranslatable = text.length > 0 && hasLetters;
          blocks.push({
            index: blocks.length + 1,
            timecode: `${start} --> ${end}`,
            text,
            translatedText: isTranslatable ? "" : text,
            status: isTranslatable ? "pending" : "done",
          });
        }
      }
    }
  }
  return blocks;
}

/**
 * Parses WebVTT (.vtt) text into SubtitleBlocks
 */
export function parseVTT(vttText: string): SubtitleBlock[] {
  const normalized = vttText
    .replace(/^WEBVTT[^\n]*\n+/i, "")
    .replace(/NOTE[^\n]*\n[\s\S]*?\n\n/g, "")
    .replace(/\r\n/g, "\n")
    .trim();

  const sections = normalized.split(/\n\s*\n/);
  const blocks: SubtitleBlock[] = [];

  for (const section of sections) {
    const lines = section.trim().split("\n");
    if (!lines || lines.length === 0) continue;

    let timeLineIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("-->")) {
        timeLineIdx = i;
        break;
      }
    }

    if (timeLineIdx >= 0) {
      const timeParts = lines[timeLineIdx].split("-->");
      if (timeParts.length === 2) {
        // Strip out any WebVTT position/align cue settings (e.g. line:0% position:50% align:middle)
        const startRaw = timeParts[0].trim();
        const endRaw = timeParts[1].trim().split(/\s+/)[0];

        const start = normalizeSRTTimecode(startRaw);
        const end = normalizeSRTTimecode(endRaw);
        const timecode = `${start} --> ${end}`;

        const textLines = lines.slice(timeLineIdx + 1);
        const text = textLines
          .join("\n")
          .replace(/<[^>]+>/g, "") // strip VTT tags like <c.yellow> or <b>
          .trim();

        if (text) {
          const hasLetters = /[a-zA-Z\u4e00-\u9fa5\d]/.test(text);
          const isTranslatable = text.length > 0 && hasLetters;

          blocks.push({
            index: blocks.length + 1,
            timecode,
            text,
            translatedText: isTranslatable ? "" : text,
            status: isTranslatable ? "pending" : "done",
          });
        }
      }
    }
  }

  return blocks;
}

/**
 * Parses ASS/SSA (.ass, .ssa) text into SubtitleBlocks
 */
export function parseASS(assText: string): SubtitleBlock[] {
  const lines = assText.replace(/\r\n/g, "\n").split("\n");
  const blocks: SubtitleBlock[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("Dialogue:")) {
      const payload = trimmed.substring("Dialogue:".length).trim();
      const parts = payload.split(",");
      // Standard ASS format has at least 10 fields: Marked/Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
      if (parts.length >= 9) {
        const startRaw = parts[1].trim();
        const endRaw = parts[2].trim();
        const rawText = parts.slice(9).join(",").trim();

        // Strip ASS style tags {\pos...}, {\an8}, \N
        const text = rawText
          .replace(/\{[^\}]+\}/g, "")
          .replace(/\\N/g, "\n")
          .replace(/\\n/g, "\n")
          .trim();

        if (text) {
          const start = normalizeSRTTimecode(startRaw);
          const end = normalizeSRTTimecode(endRaw);
          const timecode = `${start} --> ${end}`;

          const hasLetters = /[a-zA-Z\u4e00-\u9fa5\d]/.test(text);
          const isTranslatable = text.length > 0 && hasLetters;

          blocks.push({
            index: blocks.length + 1,
            timecode,
            text,
            translatedText: isTranslatable ? "" : text,
            status: isTranslatable ? "pending" : "done",
          });
        }
      }
    }
  }

  return blocks;
}

/**
 * Parses LRC (.lrc) timestamped lyrics/subtitles into SubtitleBlocks
 */
export function parseLRC(lrcText: string): SubtitleBlock[] {
  const lines = lrcText.replace(/\r\n/g, "\n").split("\n");
  const entries: { sec: number; text: string }[] = [];

  for (const line of lines) {
    const match = line.match(/\[(\d{2}):(\d{2})(?:\.(\d{2,3}))?\](.*)/);
    if (match) {
      const min = parseInt(match[1], 10);
      const sec = parseInt(match[2], 10);
      const ms = match[3] ? parseInt(match[3].padEnd(3, "0").slice(0, 3), 10) : 0;
      const totalSec = min * 60 + sec + ms / 1000;
      const text = match[4].trim();
      if (text) {
        entries.push({ sec: totalSec, text });
      }
    }
  }

  entries.sort((a, b) => a.sec - b.sec);

  const blocks: SubtitleBlock[] = [];
  for (let i = 0; i < entries.length; i++) {
    const curr = entries[i];
    const nextSec = i + 1 < entries.length ? entries[i + 1].sec : curr.sec + 3.5;
    const duration = Math.min(Math.max(1.0, nextSec - curr.sec), 6.0);

    const formatSec = (s: number) => {
      const hrs = Math.floor(s / 3600).toString().padStart(2, "0");
      const mins = Math.floor((s % 3600) / 60).toString().padStart(2, "0");
      const secs = Math.floor(s % 60).toString().padStart(2, "0");
      const ms = Math.floor((s % 1) * 1000).toString().padStart(3, "0");
      return `${hrs}:${mins}:${secs},${ms}`;
    };

    const hasLetters = /[a-zA-Z\u4e00-\u9fa5\d]/.test(curr.text);
    const isTranslatable = curr.text.length > 0 && hasLetters;

    blocks.push({
      index: i + 1,
      timecode: `${formatSec(curr.sec)} --> ${formatSec(curr.sec + duration)}`,
      text: curr.text,
      translatedText: isTranslatable ? "" : curr.text,
      status: isTranslatable ? "pending" : "done",
    });
  }

  return blocks;
}

/**
 * Universal Subtitle Auto-Parser (SAMI, SRT, WebVTT, ASS/SSA, TTML, LRC, SubViewer, Plain Text)
 */
export function parseSubtitleAuto(text: string, selectedTrackId?: string): SubtitleBlock[] {
  const trimmed = text.trim();

  // 1. SAMI (.smi, .sami) format (HTML-based synchronized accessible media)
  if (/<SYNC\b/i.test(trimmed) || /<SAMI\b/i.test(trimmed)) {
    const samiBlocks = parseSAMI(text, selectedTrackId);
    if (samiBlocks.length > 0) return samiBlocks;
    // Fallback: If requested track had 0 cues, try auto-detection
    if (selectedTrackId && selectedTrackId !== "auto") {
      const fallbackBlocks = parseSAMI(text);
      if (fallbackBlocks.length > 0) return fallbackBlocks;
    }
    // If text has SAMI markup, never fall through to convert HTML to subtitle lines!
    return [];
  }

  // 2. WebVTT (.vtt) format
  if (trimmed.startsWith("WEBVTT") || (/-->\s*\d/.test(trimmed) && trimmed.includes("."))) {
    const vttBlocks = parseVTT(text);
    if (vttBlocks.length > 0) return vttBlocks;
  }

  // 3. ASS / SSA (.ass, .ssa) format
  if (trimmed.includes("[Script Info]") || trimmed.includes("Dialogue:")) {
    const assBlocks = parseASS(text);
    if (assBlocks.length > 0) return assBlocks;
  }

  // 4. TTML / DFXP XML (<p begin="..." end="...">)
  if (/<tt/i.test(trimmed) || (/<p[^>]*begin=/i.test(trimmed) && trimmed.includes("</p>"))) {
    const ttmlBlocks = parseTTML(text);
    if (ttmlBlocks.length > 0) return ttmlBlocks;
  }

  // 5. LRC (.lrc) format
  if (/\[\d{2}:\d{2}\.\d{2,3}\]/.test(trimmed)) {
    const lrcBlocks = parseLRC(text);
    if (lrcBlocks.length > 0) return lrcBlocks;
  }

  // 6. SubViewer / SBV format
  if (/^\d{1,2}:\d{2}:\d{2}[,.]\d{2,3},\d{1,2}:\d{2}:\d{2}/m.test(trimmed)) {
    const subBlocks = parseSubViewer(text);
    if (subBlocks.length > 0) return subBlocks;
  }

  // 7. Standard SRT format (or plain text fallback)
  return parseSRT(text);
}

/**
 * Parses a standard SRT string into SubtitleBlocks
 */
export function parseSRT(srtText: string): SubtitleBlock[] {
  const normalized = srtText.replace(/\r\n/g, "\n").trim();
  
  // Split by double newlines or more
  const sections = normalized.split(/\n\s*\n/);
  const blocks: SubtitleBlock[] = [];
  
  for (let section of sections) {
    const lines = section.trim().split("\n");
    if (lines.length >= 2) {
      const indexStr = lines[0].trim();
      const timecodeLine = lines[1].trim();
      
      // Check if second line is a timecode
      if (timecodeLine.includes("-->")) {
        const index = parseInt(indexStr, 10) || (blocks.length + 1);
        const textLines = lines.slice(2);
        const text = textLines.join("\n").trim();
        
        const hasLetters = /[a-zA-Z\u4e00-\u9fa5\d]/.test(text);
        const isTranslatable = text.length > 0 && hasLetters;
        
        blocks.push({
          index,
          timecode: timecodeLine,
          text,
          translatedText: isTranslatable ? "" : text,
          status: isTranslatable ? "pending" : "done"
        });
      } else {
        // Fallback: If it starts with a timestamp without an index line
        if (indexStr.includes("-->")) {
          const index = blocks.length + 1;
          const text = lines.slice(1).join("\n").trim();
          
          const hasLetters = /[a-zA-Z\u4e00-\u9fa5\d]/.test(text);
          const isTranslatable = text.length > 0 && hasLetters;
          
          blocks.push({
            index,
            timecode: indexStr,
            text,
            translatedText: isTranslatable ? "" : text,
            status: isTranslatable ? "pending" : "done"
          });
        }
      }
    }
  }

  // If we couldn't parse anything but the input is not empty, try line-by-line fallback
  // BUT do NOT convert HTML/XML/SAMI markup into fake subtitle blocks!
  if (blocks.length === 0 && normalized.length > 0) {
    if (/<sami|<sync|<head|<body|<html|<style/i.test(normalized)) {
      return [];
    }
    return convertPlainTextToBlocks(srtText);
  }

  return blocks;
}

/**
 * Automatically converts raw plain text lines into SubtitleBlocks with fake sequential timestamps
 */
export function convertPlainTextToBlocks(text: string): SubtitleBlock[] {
  const lines = text
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0);

  return lines.map((line, i) => {
    const startSec = i * 4;
    const endSec = startSec + 3;

    const formatTime = (totalSec: number) => {
      const hrs = Math.floor(totalSec / 3600).toString().padStart(2, "0");
      const mins = Math.floor((totalSec % 3600) / 60).toString().padStart(2, "0");
      const secs = (totalSec % 60).toString().padStart(2, "0");
      return `${hrs}:${mins}:${secs},000`;
    };

    const hasLetters = /[a-zA-Z\u4e00-\u9fa5\d]/.test(line);
    const isTranslatable = line.length > 0 && hasLetters;

    return {
      index: i + 1,
      timecode: `${formatTime(startSec)} --> ${formatTime(endSec)}`,
      text: line,
      translatedText: isTranslatable ? "" : line,
      status: isTranslatable ? "pending" : "done"
    };
  });
}

/**
 * Formats blocks back into standard SRT string
 */
export function stringifySRT(blocks: SubtitleBlock[], useKhmer = true): string {
  return blocks
    .map(block => {
      let rawText = useKhmer 
        ? (block.translatedText.trim() || block.text.trim()) 
        : block.text.trim();
      const textToExport = useKhmer ? formatAmountNumbers(cleanEllipses(rawText)) : rawText;
      return `${block.index}\n${block.timecode}\n${textToExport}`;
    })
    .join("\n\n");
}

/**
 * Formats blocks into standard WebVTT string
 */
export function stringifyVTT(blocks: SubtitleBlock[], useKhmer = true): string {
  const cues = blocks.map(block => {
    let rawText = useKhmer 
      ? (block.translatedText.trim() || block.text.trim()) 
      : block.text.trim();
    const textToExport = useKhmer ? formatAmountNumbers(cleanEllipses(rawText)) : rawText;
    const vttTimecode = block.timecode.replace(/,/g, ".");
    return `${block.index}\n${vttTimecode}\n${textToExport}`;
  }).join("\n\n");

  return `WEBVTT\n\n${cues}`;
}

/**
 * Shifts all timecodes by a specified number of seconds (+ or -)
 */
export function shiftTimecodes(blocks: SubtitleBlock[], offsetSeconds: number): SubtitleBlock[] {
  return blocks.map(block => {
    const parts = block.timecode.split("-->");
    if (parts.length !== 2) return block;

    const parseTime = (str: string): number => {
      const cleanStr = str.trim().replace(",", ".");
      const hmsParts = cleanStr.split(":");
      if (hmsParts.length !== 3) return 0;
      const hrs = parseFloat(hmsParts[0]);
      const mins = parseFloat(hmsParts[1]);
      const secs = parseFloat(hmsParts[2]);
      return hrs * 3600 + mins * 60 + secs;
    };

    const formatSec = (s: number) => {
      const positiveSec = Math.max(0, s);
      const hrs = Math.floor(positiveSec / 3600).toString().padStart(2, "0");
      const mins = Math.floor((positiveSec % 3600) / 60).toString().padStart(2, "0");
      const secs = Math.floor(positiveSec % 60).toString().padStart(2, "0");
      const ms = Math.floor((positiveSec % 1) * 1000).toString().padStart(3, "0");
      return `${hrs}:${mins}:${secs},${ms}`;
    };

    const start = Math.max(0, parseTime(parts[0]) + offsetSeconds);
    const end = Math.max(start + 0.5, parseTime(parts[1]) + offsetSeconds);

    return {
      ...block,
      timecode: `${formatSec(start)} --> ${formatSec(end)}`,
    };
  });
}

/**
 * Parses timecode (e.g. "00:01:20,000 --> 00:01:23,500") and returns duration in seconds
 */
export function parseTimecodeToSeconds(timecode: string): number {
  if (!timecode) return 0;
  try {
    const parts = timecode.split("-->");
    if (parts.length !== 2) return 0;
    
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
    const duration = Math.max(0, end - start);
    return Math.round(duration * 10) / 10;
  } catch (e) {
    return 0;
  }
}

/**
 * Checks for translation anomalies like left-over Chinese, accidental Thai characters,
 * Japanese, Korean, Lao, or lack of Khmer script when the original contains translatable Chinese text.
 */
export function detectTranslationIssues(translatedText: string, originalText: string): string[] {
  const issues: string[] = [];
  const cleanOriginal = (originalText || "").trim();
  const cleanTranslated = (translatedText || "").trim();

  // 1. Check if translation is completely missing when original has translatable content
  const origHadLetters = /[a-zA-Z\u4e00-\u9fa5\d]/.test(cleanOriginal) || /[\p{Script=Han}]/u.test(cleanOriginal);
  if (origHadLetters && (!cleanTranslated || cleanTranslated.length === 0)) {
    issues.push("Missing translation (empty line)");
    return issues;
  }

  if (!cleanTranslated) return [];

  // 2. Comprehensive Chinese / Hanzi character check (across all Unicode CJK blocks & extensions)
  let hanziMatches: string[] = [];
  try {
    const matched = cleanTranslated.match(/\p{Script=Han}/gu);
    if (matched) hanziMatches = Array.from(new Set(matched));
  } catch (e) {
    const matched = cleanTranslated.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u2e80-\u2eff\u2f00-\u2fdf\u31c0-\u31ef]/g);
    if (matched) hanziMatches = Array.from(new Set(matched));
  }

  if (hanziMatches.length > 0) {
    const sample = hanziMatches.slice(0, 5).join(" ");
    issues.push(`Contains Chinese Hanzi character(s): ${sample}${hanziMatches.length > 5 ? ' ...' : ''}`);
  }

  // 3. Check for Thai script
  let thaiMatches: string[] = [];
  try {
    const matched = cleanTranslated.match(/\p{Script=Thai}/gu);
    if (matched) thaiMatches = Array.from(new Set(matched));
  } catch (e) {
    const matched = cleanTranslated.match(/[\u0e00-\u0e7f]/g);
    if (matched) thaiMatches = Array.from(new Set(matched));
  }

  if (thaiMatches.length > 0) {
    const sample = thaiMatches.slice(0, 5).join("");
    issues.push(`Contains Thai script: ${sample}`);
  }

  // 4. Check for Lao script
  let laoMatches: string[] = [];
  try {
    const matched = cleanTranslated.match(/\p{Script=Lao}/gu);
    if (matched) laoMatches = Array.from(new Set(matched));
  } catch (e) {
    const matched = cleanTranslated.match(/[\u0e80-\u0eff]/g);
    if (matched) laoMatches = Array.from(new Set(matched));
  }
  if (laoMatches.length > 0) {
    issues.push(`Contains Lao script`);
  }

  // 5. Check for Japanese Kana (Hiragana / Katakana)
  let jpMatches: string[] = [];
  try {
    const matched = cleanTranslated.match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu);
    if (matched) jpMatches = Array.from(new Set(matched));
  } catch (e) {
    const matched = cleanTranslated.match(/[\u3040-\u309f\u30a0-\u30ff\u31f0-\u31ff]/g);
    if (matched) jpMatches = Array.from(new Set(matched));
  }
  if (jpMatches.length > 0) {
    issues.push(`Contains Japanese Kana`);
  }

  // 6. Check for Korean Hangul
  let krMatches: string[] = [];
  try {
    const matched = cleanTranslated.match(/\p{Script=Hangul}/gu);
    if (matched) krMatches = Array.from(new Set(matched));
  } catch (e) {
    const matched = cleanTranslated.match(/[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/g);
    if (matched) krMatches = Array.from(new Set(matched));
  }
  if (krMatches.length > 0) {
    issues.push(`Contains Korean Hangul`);
  }

  // 7. Check for foreign alphabets/scripts (Myanmar, Arabic, Cyrillic, Devanagari)
  const hasMyanmar = /[\u1000-\u109f\ua9e0-\ua9fe]/.test(cleanTranslated);
  if (hasMyanmar) {
    issues.push("Contains Myanmar/Burmese script (ခរុ...) -> convert to Khmer (គូទខ្យង/ខ្យង)");
  }
  const hasArabic = /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff]/.test(cleanTranslated);
  if (hasArabic) {
    issues.push("Contains Arabic/Persian script (العربية) -> must be pure Khmer");
  }
  const hasOtherForeign = /[\u0400-\u04ff\u0900-\u097f]/.test(cleanTranslated);
  if (hasOtherForeign) {
    issues.push("Contains foreign/unsupported script");
  }

  // 7.1. Check for orphaned Khmer vowels/subscripts without a preceding base consonant
  if (/(?:^|\s)[្\u17b6-\u17d1]/.test(cleanTranslated)) {
    issues.push("Contains broken/orphan Khmer vowel or subscript mark");
  }

  // 8. Check if identical to original Chinese text (Untranslated copy-paste)
  let origHadHanzi = false;
  try {
    origHadHanzi = /\p{Script=Han}/u.test(cleanOriginal);
  } catch (e) {
    origHadHanzi = /[\u4e00-\u9fff]/.test(cleanOriginal);
  }

  if (origHadHanzi && cleanOriginal.length > 0 && cleanTranslated === cleanOriginal) {
    if (!issues.some(i => i.includes("Contains Chinese"))) {
      issues.push("Untranslated: line is identical to source Chinese text");
    }
  }

  // 9. Original had translatable Chinese text, but translation has NO Khmer characters
  const hasKhmer = /[\u1780-\u17ff\u19e0-\u19ff]/.test(cleanTranslated);
  const hasLatinLetters = /[a-zA-Z]/.test(cleanTranslated);
  
  if (origHadHanzi && !hasKhmer) {
    if (hanziMatches.length > 0 || thaiMatches.length > 0 || laoMatches.length > 0 || jpMatches.length > 0 || krMatches.length > 0 || hasOtherForeign) {
      // already categorized under specific foreign language
    } else if (hasLatinLetters) {
      // If it contains only Latin letters without Khmer, note that it's in Romanized/English script
      // If it's a short valid transliteration (e.g. "Gu Lanying"), it's an acceptable fallback,
      // but if user wants 100% notice, we provide a soft notice:
      const wordCount = cleanTranslated.split(/\s+/).length;
      if (wordCount > 6) {
        issues.push("No Khmer script (English/Pinyin text only)");
      }
    } else {
      const isPurePunctuation = /^[0-9:\s.,\-!@#$%^&*()_+={}\[\]|\\:;"'<>,.?\/~`]+$/.test(cleanTranslated);
      if (!isPurePunctuation) {
        issues.push("Missing Khmer characters (Untranslated)");
      }
    }
  }

  // 10. Check for prohibited pronouns or Lao/Thai calques ("អញ", "អញ់", "នាង", "ភាពលង", "ឃាបលង", "យាបលង")
  if (/[\u1780-\u17ff]/.test(cleanTranslated)) {
    if (/អញ់|អញ\b|អញប្រាប់|អញសម្លាប់|អញកាប់|អញវាយ|អញមិន|អញថា|ស្គាល់អញ|ខ្លាចអញ/.test(cleanTranslated)) {
      issues.push("Contains banned pronoun (អញ/អញ់ -> should be ខ្ញុំ or យើង)");
    }
    if (/(^|[\s,!?។៕(])នាង([\s,!?។៕)]|$)|(^|[\s,!?។៕(])នាង(បាន|មិន|នឹង|ថា|ទៅ|មក|នៅ|គឺ|ត្រូវ|ជា|ចង់|ដឹង|អាច|មាន)|(របស់|ពី|ឱ្យ|ឲ្យ|ជាមួយ|ប្រាប់|ជួយ|លើ|សម្លាប់|ស្រឡាញ់)នាង/.test(cleanTranslated)) {
      issues.push("Contains banned 3rd-person pronoun (នាង -> should be គាត់ or គេ)");
    }
    if (/ភាពលង|ឃាបលង|យាបលង/.test(cleanTranslated)) {
      issues.push("Contains invalid Lao/Thai calque (ភាពលង -> should be ឃើញរវើរវាយ / ភាន់ភ្នែក)");
    }
  }

  // 11. Check for ellipsis sign ("...", "…", "( ... )")
  if (/\.{2,}|…|·{2,}|\(\s*\.{2,}\s*\)/.test(cleanTranslated)) {
    issues.push("Contains ellipsis sign '...' (Click Auto-Repair to remove)");
  }

  // 12. Check for Kinship Mismatches (Husband 丈夫/老公/夫君 vs Brother-in-Law 姐夫/妹夫/大舅子/小叔子)
  if (cleanOriginal && cleanTranslated) {
    const hasHusbandSource = /(丈夫|老公|夫君|相公)/.test(cleanOriginal);
    const hasSisterHusbandElder = /姐夫/.test(cleanOriginal);
    const hasSisterHusbandYounger = /妹夫/.test(cleanOriginal);
    const hasBrotherInLawSource = hasSisterHusbandElder || hasSisterHusbandYounger || /(大舅子|大舅哥|小叔子|小叔|小舅子|小舅|大伯子|大伯哥)/.test(cleanOriginal);

    if (hasHusbandSource && !hasBrotherInLawSource) {
      if (/បងថ្លៃ|ប្អូនថ្លៃ/.test(cleanTranslated)) {
        issues.push("Kinship mismatch: 丈夫/老公 (husband) translated as brother-in-law (បងថ្លៃ/ប្អូនថ្លៃ) -> should be ប្ដី or ស្វាមី");
      }
    }

    if (hasBrotherInLawSource && !hasHusbandSource) {
      if (/ប្ដី|ប្តី|ស្វាមី/.test(cleanTranslated)) {
        const expected = (hasSisterHusbandYounger || /(小叔子|小叔|小舅子|小舅)/.test(cleanOriginal)) ? "ប្អូនថ្លៃ" : "បងថ្លៃ";
        issues.push(`Kinship mismatch: 姐夫/妹夫 (brother-in-law) translated as husband (ប្ដី/ស្វាមី) -> should be ${expected}`);
      }
    }

    // Check Crocodile false friend (ត្រីក្រពើ -> should be ក្រពេី)
    const hasCrocodileSource = /(鳄鱼|鱷魚)/.test(cleanOriginal) || /\b(crocodile|alligators?)\b/i.test(cleanOriginal);
    if (hasCrocodileSource) {
      if (/ត្រីក្រពើ|ត្រីក្រពេី/.test(cleanTranslated)) {
        issues.push("Vocabulary mismatch: 鳄鱼/Crocodile translated as fish (ត្រីក្រពើ) -> should be ក្រពេី");
      }
    }
  }

  // 13. Check for amount numbers that should be translated into Khmer words (e.g. 100000 -> មួយសែន, 1000000 -> មួយលាន, 100,000,000 -> មួយរយលាន)
  if (/(?<![a-zA-Z\d])(\d{1,3}(?:,\d{3})+|\d{4,})(?![a-zA-Z\d])/.test(cleanTranslated) || /(?<![\u1780-\u17ff\w])([\u17e0-\u17e9]{1,3}(?:,[\u17e0-\u17e9]{3})+|[\u17e0-\u17e9]{4,})(?![\u1780-\u17ff\w])/.test(cleanTranslated)) {
    issues.push("Contains numeric amount digits -> click Auto-Fix to convert to Khmer sentence words (មួយសែន, មួយលាន, ដប់លាន, មួយរយលាន, មួយពាន់លាន)");
  }

  return issues;
}

/**
 * Intelligent Kinship Alignment Helper
 * Enforces strict distinction between Husband (ស្វាមី/ប្ដី) and Brother-in-Law (បងថ្លៃ/ប្អូនថ្លៃ)
 * based on standard Chinese kinship terms.
 */
export function alignKinshipTerms(khmerText: string, sourceChinese: string): string {
  if (!khmerText || !sourceChinese) return khmerText;

  let result = khmerText;

  const hasHusbandTerm = /(丈夫|老公|夫君|相公)/.test(sourceChinese);
  const hasSisterHusbandElder = /姐夫/.test(sourceChinese);
  const hasSisterHusbandYounger = /妹夫/.test(sourceChinese);
  const hasWifeHusbandBrotherElder = /(大舅子|大舅哥|大伯子|大伯哥)/.test(sourceChinese);
  const hasWifeHusbandBrotherYounger = /(小叔子|小叔|小舅子|小舅)/.test(sourceChinese);
  const hasBrotherInLawTerm = hasSisterHusbandElder || hasSisterHusbandYounger || hasWifeHusbandBrotherElder || hasWifeHusbandBrotherYounger;

  // Case A: Source is purely HUSBAND (丈夫/老公/夫君/相公) and NOT brother-in-law
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

  // Case B: Source is purely BROTHER-IN-LAW (姐夫 / 妹夫 / 大舅子 / 小叔子 / 小舅子 / 大伯子) and NOT husband
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
  // Also clean stray Thai / Lao / Cyrillic if any
  result = result.replace(/[\u0e00-\u0e7f\u0e80-\u0eff\u0400-\u04ff\u0900-\u097f\u1000-\u109f]/g, "");

  return result;
}

/**
 * Robust detector for Gemini free tier daily quota exhaustion (429 RESOURCE_EXHAUSTED / limit 500 reached).
 */
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


