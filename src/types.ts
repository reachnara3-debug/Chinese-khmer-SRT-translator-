export interface SubtitleBlock {
  index: number;
  timecode: string; // e.g. "00:01:20,000 --> 00:01:23,000"
  text: string;      // Original Chinese text
  translatedText: string; // Translated Khmer text
  status: "pending" | "translating" | "done" | "failed";
  error?: string;
}

export type KhmerStyle = "colloquial" | "concise" | "voiceover" | "funny" | "formal" | "literal";

export interface CondenseResult {
  index: number;
  shortenedText: string;
  originalKhmer: string;
  originalLength: number;
  shortenedLength: number;
  reductionPercent: number;
}
export type EngineMode = "auto_hybrid" | "unlimited_free" | "gemini_only";

export interface TranslationConfig {
  khmerStyle: KhmerStyle;
  batchSize: number;
  delayMode?: "auto" | "fast" | "custom";
  customDelay?: number;
  model?: string;
  engineMode?: EngineMode;
}

export interface ExampleSubtitle {
  id: string;
  title: string;
  description: string;
  content: string;
}
