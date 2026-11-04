import * as React from "react";
import { useState, useRef, useEffect, useMemo } from "react";
import {
  Languages,
  FileUp,
  FileText,
  Play,
  Pause,
  RotateCcw,
  Download,
  Check,
  Loader2,
  Search,
  AlertCircle,
  Sparkles,
  Copy,
  Trash2,
  Settings,
  HelpCircle,
  Tv,
  ArrowRight,
  RefreshCw,
  Edit2,
  Eye,
  ArrowUpDown,
  Plus,
  ChevronLeft,
  ChevronRight,
  Shuffle,
  Dices,
  Film,
  Video,
  Layers,
  Clock,
  Globe,
  Filter,
  Scissors,
  Volume2,
  Mic,
  Zap,
  Code,
  Terminal,
  Key,
  X
} from "lucide-react";
import { SubtitleBlock, KhmerStyle, TranslationConfig, CondenseResult } from "./types";
import {
  parseSRT,
  parseSubtitleAuto,
  readSubtitleFileAsText,
  isSamiSubtitle,
  stringifySRT,
  stringifyVTT,
  shiftTimecodes,
  parseTimecodeToSeconds,
  detectTranslationIssues,
  detectSAMILanguageTracks,
  SubtitleLanguageTrack,
  filterBlocksByScript,
  cleanEllipses,
  alignKinshipTerms,
  cleanForeignAndAnomalousScripts,
  checkIsDailyQuotaExceeded
} from "./utils/srtParser";
import { EXAMPLE_SUBTITLES } from "./utils/exampleSubtitles";
import { VideoPlayerStudio } from "./components/VideoPlayerStudio";
import { isVideoFile, extractSubtitlesFromMKV, extractAudioFromVideoFile, ExtractedTrack } from "./utils/videoSubtitleExtractor";

export default function App() {
  // Client-side custom Gemini API Keys state (Multiple slots for round-robin rotation)
  const [apiKeys, setApiKeys] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem("GEMINI_API_KEYS");
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      }
      const oldKey = localStorage.getItem("GEMINI_API_KEY");
      return oldKey ? [oldKey] : [""];
    } catch {
      return [""];
    }
  });

  const [activeSlotIndex, setActiveSlotIndex] = useState<number | null>(null);

  // Tracks dynamic operational status of each key slot
  const [slotStatuses, setSlotStatuses] = useState<Record<number, {
    status: "ready" | "active" | "rate-limited" | "exhausted" | "error";
    message?: string;
  }>>({});

  const handleSaveApiKeys = (newKeys: string[]) => {
    setApiKeys(newKeys);
    try {
      localStorage.setItem("GEMINI_API_KEYS", JSON.stringify(newKeys));
    } catch (e) {
      console.warn("Could not save API keys to LocalStorage:", e);
    }
  };

  const handleUpdateKeyAtSlot = (index: number, val: string) => {
    const updated = [...apiKeys];
    updated[index] = val;
    handleSaveApiKeys(updated);
    setSlotStatuses((prev) => {
      const copy = { ...prev };
      if (val.trim() === "") {
        delete copy[index];
      } else {
        copy[index] = { status: "ready" };
      }
      return copy;
    });
  };

  const handleAddKeySlot = () => {
    if (apiKeys.length < 15) {
      handleSaveApiKeys([...apiKeys, ""]);
    }
  };

  const handleRemoveKeySlot = (index: number) => {
    if (apiKeys.length === 1) {
      handleSaveApiKeys([""]);
      setSlotStatuses({});
    } else {
      const updated = apiKeys.filter((_, i) => i !== index);
      handleSaveApiKeys(updated);
      setSlotStatuses((prev) => {
        const copy: typeof slotStatuses = {};
        Object.entries(prev).forEach(([key, val]) => {
          const idx = parseInt(key, 10);
          if (idx < index) {
            copy[idx] = val;
          } else if (idx > index) {
            copy[idx - 1] = val;
          }
        });
        return copy;
      });
    }
  };

  // Raw text input state (used when uploading or pasting subtitles)
  const [rawInput, setRawInput] = useState<string>("");
  // Raw unparsed source text preserved for multi-language track switching
  const [rawSubtitleSourceText, setRawSubtitleSourceText] = useState<string>("");
  // Multi-language tracks detected in SAMI / multi-track files
  const [samiLanguageTracks, setSamiLanguageTracks] = useState<SubtitleLanguageTrack[]>([]);
  const [selectedLanguageTrack, setSelectedLanguageTrack] = useState<string>("auto");
  
  // Track original uploaded subtitle or video file name to keep it upon export
  const [uploadedFileName, setUploadedFileName] = useState<string>("");
  
  // Video and subtitle track synchronization states
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [extractedTracks, setExtractedTracks] = useState<ExtractedTrack[]>([]);
  const [selectedBlockIndex, setSelectedBlockIndex] = useState<number | null>(null);
  const [isTranscribingVideo, setIsTranscribingVideo] = useState<boolean>(false);
  const [transcribeProgress, setTranscribeProgress] = useState<{ percent: number; message: string }>({ percent: 0, message: "" });
  const [videoNotice, setVideoNotice] = useState<{ type: "success" | "info" | "error"; message: string } | null>(null);

  // Parsed subtitle blocks state
  const [blocks, setBlocks] = useState<SubtitleBlock[]>([]);
  
  // Translation process states
  const [isTranslating, setIsTranslating] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [isKeyMissing, setIsKeyMissing] = useState<boolean>(false);

  // Smart Voiceover / Dubbing Shortener states
  const [isCondensing, setIsCondensing] = useState<boolean>(false);
  const [condensingIndex, setCondensingIndex] = useState<number | null>(null);
  const [condensingProgress, setCondensingProgress] = useState<{ current: number; total: number }>({ current: 0, total: 0 });
  const [showCondenseModal, setShowCondenseModal] = useState<boolean>(false);
  const [condenseScope, setCondenseScope] = useState<"overrun" | "all">("overrun");
  const [condenseBrevity, setCondenseBrevity] = useState<"natural" | "ultra">("natural");
  const [condenseStatsSummary, setCondenseStatsSummary] = useState<{ count: number; avgReduction: number; oldChars: number; newChars: number } | null>(null);
  
  // UI states
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [scriptFilter, setScriptFilter] = useState<"all" | "zh" | "ko" | "en" | "ja">("all");
  const [currentPage, setCurrentPage] = useState<number>(1);
  const itemsPerPage = 50;

  // Reset pagination when filter/search/blocks change to keep page indices aligned
  useEffect(() => {
    setCurrentPage(1);
  }, [statusFilter, scriptFilter, searchQuery, blocks.length]);

  const [config, setConfig] = useState<TranslationConfig>(() => {
    try {
      const stored = localStorage.getItem("TRANSLATION_CONFIG");
      if (stored) {
        const parsed = JSON.parse(stored);
        const resolvedModel = parsed.model || "gemini-3.1-flash-lite";
        return {
          khmerStyle: "colloquial",
          batchSize: 35,
          delayMode: "fast",
          customDelay: 200,
          engineMode: "auto_hybrid",
          ...parsed,
          model: resolvedModel
        };
      }
    } catch {}
    return {
      khmerStyle: "colloquial",
      batchSize: 35,
      delayMode: "fast",
      customDelay: 200,
      model: "gemini-3.1-flash-lite",
      engineMode: "auto_hybrid"
    };
  });

  useEffect(() => {
    try {
      localStorage.setItem("TRANSLATION_CONFIG", JSON.stringify(config));
    } catch (_) {}
  }, [config]);
  
  // Inline editing states
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingText, setEditingText] = useState<string>("");
  
  // Copy to clipboard indicator state
  const [copied, setCopied] = useState<boolean>(false);
  
  // Drag and drop state
  const [isDragging, setIsDragging] = useState<boolean>(false);

  // Notepad scratchpad states
  const [showNotepad, setShowNotepad] = useState<boolean>(false);
  const [notepadText, setNotepadText] = useState<string>("");
  const [notepadMode, setNotepadMode] = useState<"plain" | "srt" | "notices">("plain");
  const [notepadSaveSuccess, setNotepadSaveSuccess] = useState<boolean>(false);

  // Funny Slang Quick-Inject state and shuffle deck
  const [funnySlangList, setFunnySlangList] = useState([
    { phrase: "ចុយ!", meaning: "Surprise / Amazed 😲" },
    { phrase: "ចុយម៉ាយ!", meaning: "Shocked / WTF 🤯" },
    { phrase: "ចុយម៉ាយអើយ!", meaning: "Amazed / OMG 😱" },
    { phrase: "ចុមយក្ស!", meaning: "Holy Crap / Wow 😱" },
    { phrase: "យាយកញ្ចាស់", meaning: "Bad Old Woman / Old Hag 👵" },
    { phrase: "យាយកញ្ចាស់ចង្រៃ", meaning: "Cursed Old Hag 👵💥" },
    { phrase: "អាសណ្តានសៀម", meaning: "Curse Word 💥" },
    { phrase: "អាចោរសៀម", meaning: "Curse Word 💥" },
    { phrase: "អាសៀម", meaning: "Curse Word 💥" },
    { phrase: "អាគេបាញ់", meaning: "Curse Word 💥" },
    { phrase: "អារលាយ", meaning: "Curse Word 💥" },
    { phrase: "អាចង្រៃ", meaning: "Curse Word 💥" },
    { phrase: "អាឡប់", meaning: "Crazy / Wacko 🤪" },
    { phrase: "អាបែកកាវ", meaning: "Glue Sniffer / High 😵" },
    { phrase: "អាមហាចង្រៃ", meaning: "Super Jinx 💥" },
    { phrase: "អាភ្លើ", meaning: "Dumb / Foolish 🤦‍♂️" },
    { phrase: "អាឆ្កួត", meaning: "Madman / Crazy 🥴" },
    { phrase: "អាចោរម្សៀត", meaning: "Good-for-nothing 😈" },
    { phrase: "អាងាប់", meaning: "Curse Word 💀" },
    { phrase: "អារន្ទះបាញ់", meaning: "Lightning Strike ⚡" },
    { phrase: "ចុកឈាមហ្មង!", meaning: "Spitting Blood! 🩸" },
    { phrase: "ឡូយញាក់សាច់!", meaning: "Insanely Cool! 🔥" },
    { phrase: "ក្តៅស្លឹកត្រចៀក!", meaning: "Furious! 😡" },
    { phrase: "យីស៊យម៉េះ!", meaning: "Ridiculous! 🍀" },
    { phrase: "រលាយហ្មង!", meaning: "Wasted! 🫠" },
    { phrase: "ឡូយប្លែក!", meaning: "Weird Flex! ✨" },
    { phrase: "អីយ៉ា!", meaning: "Oh My / Surprise 😏" },
    { phrase: "ចុម!", meaning: "Oops / Surprise 😮" }
  ]);
  const lastInsertedSlangIndexRef = useRef<number>(-1);

  const handleShuffleSlang = () => {
    setFunnySlangList((prev) => [...prev].sort(() => Math.random() - 0.5));
  };

  const handleInsertRandomSlang = () => {
    if (funnySlangList.length === 0) return;
    // Pick an index different from last time to ensure we never repeat the same word consecutively
    let nextIdx = Math.floor(Math.random() * funnySlangList.length);
    if (funnySlangList.length > 1 && nextIdx === lastInsertedSlangIndexRef.current) {
      nextIdx = (nextIdx + 1) % funnySlangList.length;
    }
    lastInsertedSlangIndexRef.current = nextIdx;
    const picked = funnySlangList[nextIdx];

    setNotepadText((prev) => {
      if (!prev) return picked.phrase;
      if (prev.endsWith("\n") || prev.endsWith(" ")) return prev + picked.phrase;
      return prev + " " + picked.phrase;
    });
  };
  
  // Ref to handle cancellation of translating loop safely
  const isTranslatingRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // App Code Viewer and Export Functions Modal
  const [showCodeModal, setShowCodeModal] = useState(false);
  const [codeActiveTab, setCodeActiveTab] = useState<"download-zip" | "files" | "export-functions" | "export-guide">("download-zip");
  const [codeCopiedTab, setCodeCopiedTab] = useState<string | null>(null);
  const [selectedSourceFilePath, setSelectedSourceFilePath] = useState<string>("server.ts");
  const [sourceFileContent, setSourceFileContent] = useState<string>("");
  const [isLoadingSourceFile, setIsLoadingSourceFile] = useState<boolean>(false);

  // Load source file content when browsing files in the App Code modal
  useEffect(() => {
    if (showCodeModal && (codeActiveTab === "files" || codeActiveTab === "download-zip") && selectedSourceFilePath) {
      setIsLoadingSourceFile(true);
      fetch(`/api/source-file?path=${encodeURIComponent(selectedSourceFilePath)}`)
        .then((res) => {
          if (!res.ok) throw new Error("Failed to fetch source file");
          return res.json();
        })
        .then((data) => {
          if (data.content) {
            setSourceFileContent(data.content);
          }
        })
        .catch((err) => {
          console.error("Error loading source file:", err);
          setSourceFileContent(`// Could not load file: ${selectedSourceFilePath}\n// Error: ${err.message}`);
        })
        .finally(() => setIsLoadingSourceFile(false));
    }
  }, [showCodeModal, codeActiveTab, selectedSourceFilePath]);

  const [downloadingFormat, setDownloadingFormat] = useState<string | null>(null);

  // Safe client-side blob download that avoids iframe sandboxing / navigation blocks
  const handleSafeBlobDownload = async (endpoint: string, filename: string) => {
    try {
      setDownloadingFormat(filename);
      const res = await fetch(endpoint);
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", filename);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      setVideoNotice({
        type: "success",
        message: `✨ Successfully downloaded ${filename}! You can open it directly in any browser.`
      });
    } catch (err: any) {
      console.error("Download error:", err);
      window.open(endpoint, "_blank");
    } finally {
      setDownloadingFormat(null);
    }
  };

  // Sync state reference for the background translation loop
  useEffect(() => {
    isTranslatingRef.current = isTranslating;
  }, [isTranslating]);

  // Break translation on component unmount
  useEffect(() => {
    return () => {
      isTranslatingRef.current = false;
    };
  }, []);

  // Compute overall progress metrics
  const stats = useMemo(() => {
    const total = blocks.length;
    const done = blocks.filter((b) => b.status === "done").length;
    const translating = blocks.filter((b) => b.status === "translating").length;
    const failed = blocks.filter((b) => b.status === "failed").length;
    const pending = blocks.filter((b) => b.status === "pending").length;
    const percentage = total > 0 ? Math.round((done / total) * 100) : 0;
    
    return { total, done, translating, failed, pending, percentage };
  }, [blocks]);

  // Compute blocks that exceed normal speaking rate (CPS > 13) causing speech rushing or Balabolka overflow
  const overrunBlocks = useMemo(() => {
    return blocks.filter((b) => {
      if (!b.translatedText || b.status !== "done") return false;
      const duration = parseTimecodeToSeconds(b.timecode);
      if (duration <= 0) return false;
      const khmerChars = b.translatedText.replace(/\s+/g, "").length;
      const cps = khmerChars / duration;
      return cps > 13;
    });
  }, [blocks]);

  // Quick API key input state for the quota recovery banner
  const [bannerApiKeyInput, setBannerApiKeyInput] = useState<string>("");

  // Check if current error message indicates a rate limit or quota exceeded issue
  const isQuotaExceededError = useMemo(() => {
    if (!errorMessage) return false;
    return (
      checkIsDailyQuotaExceeded(errorMessage) ||
      errorMessage.toLowerCase().includes("quota") ||
      errorMessage.toLowerCase().includes("exhausted") ||
      errorMessage.toLowerCase().includes("exceeded") ||
      errorMessage.toLowerCase().includes("429")
    );
  }, [errorMessage]);

  // Handle parsing manual input
  const handleParse = (trackIdOverride?: string) => {
    // If trackIdOverride is provided or rawSubtitleSourceText contains multi-track SAMI,
    // we MUST use rawSubtitleSourceText so track switching works and is not blocked by converted SRT!
    let source = (rawInput && rawInput.trim()) ? rawInput : rawSubtitleSourceText;
    if (trackIdOverride && rawSubtitleSourceText && isSamiSubtitle(rawSubtitleSourceText)) {
      source = rawSubtitleSourceText;
    } else if (rawSubtitleSourceText && isSamiSubtitle(rawSubtitleSourceText) && !isSamiSubtitle(rawInput)) {
      source = rawSubtitleSourceText;
    }

    if (!source.trim()) {
      setErrorMessage("Please paste some subtitle content or upload a subtitle file first.");
      return;
    }
    try {
      // Check if SAMI / multi-track file
      const isSAMI = isSamiSubtitle(source);
      let detectedTracks: SubtitleLanguageTrack[] = [];
      let targetTrack = trackIdOverride || selectedLanguageTrack;

      if (isSAMI) {
        detectedTracks = detectSAMILanguageTracks(source);
        setSamiLanguageTracks(detectedTracks);

        if (targetTrack === "auto" || !targetTrack) {
          // If Chinese exists, pick Chinese by default
          const zh = detectedTracks.find((t) => t.code === "zh");
          if (zh) {
            targetTrack = zh.id;
          } else if (detectedTracks.length > 0) {
            targetTrack = detectedTracks[0].id;
          }
        }
        setSelectedLanguageTrack(targetTrack);
      }

      setRawSubtitleSourceText(source);
      const parsed = parseSubtitleAuto(source, targetTrack);
      if (parsed.length === 0) {
        setErrorMessage("Could not detect any subtitle blocks. Check if the subtitles or timestamps are formatted correctly.");
        return;
      }
      setBlocks(parsed);
      // Format clean SRT in the textarea
      setRawInput(stringifySRT(parsed, false));
      setErrorMessage("");
      setSearchQuery("");
      setStatusFilter("all");
      setScriptFilter("all");

      const trackInfo = detectedTracks.find((t) => t.id === targetTrack);
      const trackLabel = trackInfo ? ` (${trackInfo.label})` : "";
      setVideoNotice({
        type: "success",
        message: `Parsed ${parsed.length} subtitle cues${trackLabel}. Ready to translate.`
      });
    } catch (err: any) {
      setErrorMessage(`Parsing error: ${err.message}`);
    }
  };

  // Switch between SAMI language tracks
  const handleSelectSAMITrack = (trackId: string) => {
    setSelectedLanguageTrack(trackId);
    handleParse(trackId);
  };

  // Keep only lines matching a specific writing script (Chinese, Korean, English, Japanese)
  const handleKeepOnlyScript = (script: "zh" | "ko" | "en" | "ja") => {
    if (blocks.length === 0) return;
    const filtered = filterBlocksByScript(blocks, script);
    if (filtered.length === 0) {
      setErrorMessage(`No lines found matching script "${script}".`);
      return;
    }
    // Re-index remaining blocks sequentially
    const reindexed = filtered.map((b, i) => ({ ...b, index: i + 1 }));
    setBlocks(reindexed);
    setRawInput(stringifySRT(reindexed, false));
    setScriptFilter("all");
    setVideoNotice({
      type: "success",
      message: `Isolated ${reindexed.length} lines. Purged non-matching lines.`
    });
  };

  // Load a preset example subtitle template
  const handleLoadExample = (id: string) => {
    const example = EXAMPLE_SUBTITLES.find((e) => e.id === id);
    if (example) {
      setUploadedFileName(`${id}.srt`);
      setRawSubtitleSourceText(example.content);
      setScriptFilter("all");

      const isSAMI = isSamiSubtitle(example.content);
      let chosenTrack = "auto";
      if (isSAMI) {
        const tracks = detectSAMILanguageTracks(example.content);
        setSamiLanguageTracks(tracks);
        if (tracks.length > 0) {
          const zh = tracks.find((t) => t.code === "zh");
          chosenTrack = zh ? zh.id : tracks[0].id;
          setSelectedLanguageTrack(chosenTrack);
        }
      } else {
        setSamiLanguageTracks([]);
        setSelectedLanguageTrack("auto");
      }

      const parsed = parseSubtitleAuto(example.content, chosenTrack);
      setBlocks(parsed);
      if (isSAMI && parsed.length > 0) {
        setRawInput(stringifySRT(parsed, false));
      } else {
        setRawInput(example.content);
      }

      setErrorMessage("");
      setSearchQuery("");
      setStatusFilter("all");
      // Pre-set some style suggestions based on scenario
      if (id === "historical-action") {
        setConfig((prev) => ({ ...prev, khmerStyle: "formal" }));
      } else {
        setConfig((prev) => ({ ...prev, khmerStyle: "colloquial" }));
      }
    }
  };

  // Process video or subtitle file upload
  const handleFileUpload = async (file: File) => {
    if (!file) return;
    setUploadedFileName(file.name);
    setErrorMessage("");

    // Check if uploaded file is a video container (.mp4, .mkv, .webm, .mov, etc.)
    if (isVideoFile(file)) {
      setVideoFile(file);
      const url = URL.createObjectURL(file);
      setVideoUrl(url);
      setVideoNotice({
        type: "info",
        message: `Analyzing "${file.name}" for embedded subtitle tracks...`
      });

      try {
        const tracks = await extractSubtitlesFromMKV(file);
        if (tracks && tracks.length > 0) {
          setExtractedTracks(tracks);
          // Pick Chinese track or first track by default
          const bestTrack = tracks.find(
            (t) =>
              t.language?.toLowerCase().includes("chi") ||
              t.language?.toLowerCase().includes("zh") ||
              t.language?.toLowerCase().includes("cmn") ||
              t.title?.toLowerCase().includes("chi") ||
              t.title?.toLowerCase().includes("zh")
          ) || tracks[0];

          setBlocks(bestTrack.blocks);
          setRawInput(bestTrack.rawText);
          setRawSubtitleSourceText(bestTrack.rawText);
          setSearchQuery("");
          setStatusFilter("all");
          setScriptFilter("all");
          setVideoNotice({
            type: "success",
            message: `✅ Found ${tracks.length} embedded track(s)! Extracted "${bestTrack.language || bestTrack.title}" (${bestTrack.blocks.length} lines). Ready to translate to Khmer.`
          });
        } else {
          setExtractedTracks([]);
          setVideoNotice({
            type: "info",
            message: `📹 Video loaded. No embedded subtitle text tracks found in container. Click "AI Transcribe Video" to automatically generate timed Chinese subtitles from dialogue audio!`
          });
        }
      } catch (err: any) {
        console.warn("Video subtitle extraction:", err);
        setVideoNotice({
          type: "info",
          message: `📹 Video loaded. You can click "AI Transcribe Video" to generate subtitles directly from speech, or drop an SRT file to pair with it.`
        });
      }
      return;
    }

    // Otherwise, parse subtitle file (SAMI, SRT, WebVTT, ASS/SSA, TTML, LRC, Plain text)
    try {
      const text = await readSubtitleFileAsText(file);
      if (text) {
        setRawSubtitleSourceText(text);
        
        // Detect SAMI language tracks
        const isSAMI = isSamiSubtitle(text);

        let chosenTrack = "auto";
        let tracks: SubtitleLanguageTrack[] = [];
        
        if (isSAMI) {
          tracks = detectSAMILanguageTracks(text);
          setSamiLanguageTracks(tracks);
          if (tracks.length > 0) {
            const zhTrack = tracks.find((t) => t.code === "zh");
            chosenTrack = zhTrack ? zhTrack.id : tracks[0].id;
            setSelectedLanguageTrack(chosenTrack);
          }
        } else {
          setSamiLanguageTracks([]);
          setSelectedLanguageTrack("auto");
        }

        const parsed = parseSubtitleAuto(text, chosenTrack);
        if (parsed.length > 0) {
          setBlocks(parsed);
          // If it was SAMI or other markup format, format clean SRT in the textarea
          if (
            isSAMI ||
            text.includes("<SYNC") ||
            text.includes("<sami") ||
            text.includes("<SAMI") ||
            text.includes("WEBVTT") ||
            text.includes("Dialogue:")
          ) {
            setRawInput(stringifySRT(parsed, false));
          } else {
            setRawInput(text);
          }
          setErrorMessage("");
          setSearchQuery("");
          setStatusFilter("all");
          setScriptFilter("all");

          const trackObj = tracks.find((t) => t.id === chosenTrack);
          const trackMsg = trackObj ? ` [${trackObj.label}]` : "";
          setVideoNotice({
            type: "success",
            message: `📄 Loaded ${parsed.length} subtitle cues${trackMsg} from "${file.name}".`
          });
        } else {
          setRawInput(text);
          setErrorMessage(`Could not parse subtitles from "${file.name}". Please verify the file contains timed cues.`);
        }
      }
    } catch (err: any) {
      console.error("Subtitle file read error:", err);
      setErrorMessage(`Failed to read file "${file.name}": ${err.message || err.toString()}`);
    }
  };

  // Switch between embedded subtitle tracks extracted from video
  const handleSelectExtractedTrack = (track: ExtractedTrack) => {
    setBlocks(track.blocks);
    setRawInput(track.rawText);
    setSearchQuery("");
    setStatusFilter("all");
    setVideoNotice({
      type: "success",
      message: `Switched to embedded track: "${track.language || track.title}" (${track.blocks.length} lines).`
    });
  };

  // AI Speech Transcription from Video Audio
  const handleTranscribeVideo = async () => {
    if (!videoFile) {
      setErrorMessage("No video loaded to transcribe.");
      return;
    }

    setIsTranscribingVideo(true);
    setTranscribeProgress({ percent: 10, message: "Extracting audio stream from video..." });
    setErrorMessage("");

    try {
      const { base64Wav } = await extractAudioFromVideoFile(
        videoFile,
        300,
        (percent, message) => setTranscribeProgress({ percent, message })
      );

      setTranscribeProgress({ percent: 70, message: "Gemini AI is transcribing speech into timed SRT subtitles..." });

      const activeKey = apiKeys.find((k) => k.trim() !== "");
      const response = await fetch("/api/transcribe-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          base64Audio: base64Wav,
          mimeType: "audio/wav",
          apiKey: activeKey || undefined
        })
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || `Transcription failed with status ${response.status}`);
      }

      const data = await response.json();
      if (!data.srt || data.srt.trim().length === 0) {
        throw new Error("No speech dialogue detected or model returned empty transcript.");
      }

      setRawInput(data.srt);
      const parsed = parseSubtitleAuto(data.srt);
      setBlocks(parsed);
      setSearchQuery("");
      setStatusFilter("all");
      setVideoNotice({
        type: "success",
        message: `✅ AI Audio Transcription complete! Generated ${parsed.length} synchronized dialogue subtitle cues.`
      });
    } catch (err: any) {
      console.error("Transcribe video error:", err);
      setErrorMessage(`Video Transcription failed: ${err.message || err.toString()}`);
    } finally {
      setIsTranscribingVideo(false);
      setTranscribeProgress({ percent: 0, message: "" });
    }
  };

  // Close active video player
  const handleCloseVideo = () => {
    if (videoUrl) {
      URL.revokeObjectURL(videoUrl);
    }
    setVideoFile(null);
    setVideoUrl(null);
    setExtractedTracks([]);
    setVideoNotice(null);
  };

  // Drag-and-drop handlers
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      handleFileUpload(files[0]);
    }
  };

  // Core translate loop function
  const startTranslationLoop = async (overrideBlocks?: SubtitleBlock[]) => {
    let currentBlocks = (overrideBlocks && Array.isArray(overrideBlocks)) ? [...overrideBlocks] : [...blocks];
    
    // If no blocks are currently parsed, parse from raw input
    if (currentBlocks.length === 0) {
      if (!rawInput.trim()) {
        setErrorMessage("No subtitles loaded. Paste subtitles, upload a file, or load an example scenario.");
        return;
      }
      const parsed = parseSubtitleAuto(rawInput, selectedLanguageTrack);
      if (parsed.length === 0) {
        setErrorMessage("No valid subtitle blocks parsed. Make sure timestamps are present.");
        return;
      }
      currentBlocks = parsed;
      setBlocks(parsed);
    } else if (!overrideBlocks) {
      // Clean up any stuck "translating" blocks and reset them to "pending" to guarantee correct resume
      currentBlocks = currentBlocks.map((b) =>
        b.status === "translating" ? { ...b, status: "pending" as const } : b
      );
      setBlocks(currentBlocks);
    }

    setErrorMessage("");
    setIsKeyMissing(false);
    setIsTranslating(true);
    isTranslatingRef.current = true;

    const batchSize = config.batchSize;
    let batchCounter = 0;

    // Track exhausted slot indices locally during this run to avoid state updates delay
    const exhaustedSlotIndices = new Set<number>();

    // Prevent infinite loop on blocks that repeatedly fail or are missing from response during this active run
    const failedIndexesThisRun = new Set<number>();

    // Reset slot statuses when a new translation starts
    setSlotStatuses((prev) => {
      const nextStatuses: typeof slotStatuses = {};
      apiKeys.forEach((key, idx) => {
        if (key.trim() !== "") {
          nextStatuses[idx] = { status: "ready" };
        }
      });
      return nextStatuses;
    });

    let consecutiveBatchFailures = 0;

    while (isTranslatingRef.current) {
      // Find items that need translation (either pending or failed)
      const pendingBlocks = currentBlocks.filter(
        (b) => (b.status === "pending" || b.status === "failed") && !failedIndexesThisRun.has(b.index)
      );

      if (pendingBlocks.length === 0) {
        // Translation complete!
        setIsTranslating(false);
        setActiveSlotIndex(null);
        break;
      }

      // Slice the next batch
      const currentBatch = pendingBlocks.slice(0, batchSize);
      const batchIndexes = currentBatch.map((b) => b.index);

      // Mark current batch as 'translating' (and clear any previous batch-level errors)
      currentBlocks = currentBlocks.map((b) =>
        batchIndexes.includes(b.index) ? { ...b, status: "translating", error: undefined } : b
      );
      setBlocks(currentBlocks);

      // Map custom keys to their original index
      const activeKeysWithOriginalIndex = apiKeys
        .map((key, originalIndex) => ({ key: key.trim(), originalIndex }))
        .filter((item) => item.key !== "");

      let attempt = 0;
      // We allow multiple attempts to cover all valid key rotations
      const maxAttempts = Math.max(3, activeKeysWithOriginalIndex.length + 1);
      let success = false;
      let lastError = null;

      while (attempt < maxAttempts && !success && isTranslatingRef.current) {
        // Filter keys that have not been exhausted in this run
        const availableKeys = activeKeysWithOriginalIndex.filter(
          (item) => !exhaustedSlotIndices.has(item.originalIndex)
        );

        let keyItemToUse = null;
        let currentKeyToUse = undefined;
        let currentSlotIndex = null;

        if (availableKeys.length > 0) {
          keyItemToUse = availableKeys[(batchCounter + attempt) % availableKeys.length];
          currentKeyToUse = keyItemToUse.key;
          currentSlotIndex = keyItemToUse.originalIndex;
        }

        if (currentSlotIndex !== null) {
          setActiveSlotIndex(currentSlotIndex);
          setSlotStatuses((prev) => ({
            ...prev,
            [currentSlotIndex as number]: { status: "active" },
          }));
        } else {
          setActiveSlotIndex(null);
        }

        try {
          const response = await fetch("/api/translate-batch", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              blocks: currentBatch.map((b) => {
                const fullIdx = currentBlocks.findIndex((cb) => cb.index === b.index);
                const prevContext = fullIdx > 0 
                  ? currentBlocks.slice(Math.max(0, fullIdx - 2), fullIdx).map((cb) => cb.text).join(" / ") 
                  : "";
                const nextContext = fullIdx >= 0 && fullIdx < currentBlocks.length - 1 
                  ? currentBlocks.slice(fullIdx + 1, Math.min(currentBlocks.length, fullIdx + 3)).map((cb) => cb.text).join(" / ") 
                  : "";
                const issues = detectTranslationIssues(b.translatedText, b.text);
                return {
                  index: b.index,
                  text: b.text,
                  timecode: b.timecode,
                  prevContext,
                  nextContext,
                  currentTranslation: b.translatedText,
                  issues: issues
                };
              }),
              isRepair: currentBatch.some((b) => b.status === "failed" || (!!b.translatedText && detectTranslationIssues(b.translatedText, b.text).length > 0)),
              khmerStyle: config.khmerStyle,
              apiKey: currentKeyToUse,
              model: config.model,
              engineMode: config.engineMode || "auto_hybrid",
            }),
          });

          let data: any = {};
          const contentType = response.headers.get("content-type");
          if (contentType && contentType.includes("application/json")) {
            data = await response.json();
          } else {
            const text = await response.text();
            throw new Error(`Server returned non-JSON response (${response.status} ${response.statusText}): ${text.substring(0, 100)}`);
          }

          if (!response.ok) {
            // Client-side emergency failover to Free Unlimited Engine
            if (config.engineMode !== "gemini_only") {
              try {
                console.warn("[Client Auto-Failover] Primary translation returned error, falling back to /api/translate-unlimited-free...");
                const freeResp = await fetch("/api/translate-unlimited-free", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    blocks: currentBatch.map((b) => ({ index: b.index, text: b.text, timecode: b.timecode })),
                    khmerStyle: config.khmerStyle,
                  }),
                });
                if (freeResp.ok) {
                  const freeData = await freeResp.json();
                  if (Array.isArray(freeData.translations) && freeData.translations.length > 0) {
                    data = freeData;
                    data.usedFallbackEngine = true;
                    data.notice = "⚡ Translated seamlessly using the Free Unlimited Engine!";
                  }
                }
              } catch (_) {}
            }

            if (!data.translations) {
              if (data.isKeyMissing) {
                setIsKeyMissing(true);
              }
              const err = new Error(data.error || `Server failed to translate batch with status ${response.status}.`);
              (err as any).data = data;
              throw err;
            }
          }

          const translationsList = data.translations;
          const translationMap = new Map<number, string>();
          translationsList.forEach((t: { index: any; translatedText: string }) => {
            if (t && t.index !== undefined && t.index !== null) {
              translationMap.set(Number(t.index), t.translatedText || "");
            }
          });

          // Update blocks in reference array
          currentBlocks = currentBlocks.map((b) => {
            if (batchIndexes.includes(b.index)) {
              const mappedText = translationMap.get(b.index);
              if (mappedText !== undefined) {
                return { ...b, status: "done", translatedText: mappedText, error: undefined };
              } else {
                failedIndexesThisRun.add(b.index);
                return { ...b, status: "failed", error: "Translation missing in response." };
              }
            }
            return b;
          });

          setBlocks(currentBlocks);
          success = true;
          consecutiveBatchFailures = 0;
          setErrorMessage(""); // clear previous warning messages

          if (data.usedFallbackEngine || data.notice) {
            setVideoNotice({
              type: "info",
              message: data.notice || "⚡ Switched to Free Unlimited Engine so subtitles keep translating without interruption!"
            });
          }
          
          if (currentSlotIndex !== null) {
            setSlotStatuses((prev) => ({
              ...prev,
              [currentSlotIndex as number]: { status: "ready" },
            }));
          }

          batchCounter++;
        } catch (err: any) {
          lastError = err;
          attempt++;
          const errorMsg = err.message || "";
          const responseData = (err as any).data || {};

          // Determine if key is completely out of daily quota (e.g., daily limits or invalid key error)
          const isDailyQuota = Boolean(responseData.isQuotaExceeded) ||
                               Boolean(responseData.requiresUserKey) ||
                               checkIsDailyQuotaExceeded(errorMsg, responseData.code, responseData.status);

          const isQuotaExceeded = isDailyQuota;

          const isRateLimit = responseData.isRateLimit ||
                              errorMsg.includes("429") || 
                              errorMsg.toLowerCase().includes("rate limit") || 
                              errorMsg.toLowerCase().includes("requests per minute") ||
                              errorMsg.includes("RESOURCE_EXHAUSTED");

          const isUnavailable = responseData.isUnavailable ||
                                errorMsg.includes("503") ||
                                errorMsg.includes("UNAVAILABLE") ||
                                errorMsg.toLowerCase().includes("high demand") ||
                                errorMsg.toLowerCase().includes("unavailable");

          const isDeadline = responseData.isDeadline ||
                             errorMsg.includes("504") ||
                             errorMsg.includes("499") ||
                             errorMsg.includes("DEADLINE_EXCEEDED") ||
                             errorMsg.includes("CANCELLED") ||
                             errorMsg.toLowerCase().includes("deadline expired") ||
                             errorMsg.toLowerCase().includes("operation was cancelled");

          const isTransient = responseData.isTransient ||
                              isUnavailable ||
                              isDeadline ||
                              errorMsg.includes("502") ||
                              errorMsg.includes("500") ||
                              errorMsg.toLowerCase().includes("non-json response") ||
                              errorMsg.toLowerCase().includes("doctype") ||
                              errorMsg.toLowerCase().includes("failed to fetch") ||
                              errorMsg.toLowerCase().includes("networkerror") ||
                              errorMsg.toLowerCase().includes("fetch failed") ||
                              errorMsg.toLowerCase().includes("timeout") ||
                              errorMsg.toLowerCase().includes("unexpected token") ||
                              errorMsg.toLowerCase().includes("server failed to translate") ||
                              errorMsg.toLowerCase().includes("failed to translate batch");

          if (currentSlotIndex !== null) {
            if (isQuotaExceeded) {
              exhaustedSlotIndices.add(currentSlotIndex);
              setSlotStatuses((prev) => ({
                ...prev,
                [currentSlotIndex as number]: { status: "exhausted", message: "Quota Exhausted" },
              }));
            } else if (isRateLimit) {
              setSlotStatuses((prev) => ({
                ...prev,
                [currentSlotIndex as number]: { status: "rate-limited", message: "Rate Limited" },
              }));
            } else if (isUnavailable || isDeadline) {
              setSlotStatuses((prev) => ({
                ...prev,
                [currentSlotIndex as number]: { status: "busy", message: isUnavailable ? "High Demand" : "Timeout" },
              }));
            } else {
              setSlotStatuses((prev) => ({
                ...prev,
                [currentSlotIndex as number]: { status: "error", message: "Error" },
              }));
            }
          }

          const currentMaxAttempts = isTransient ? Math.max(5, maxAttempts) : maxAttempts;
          const shouldRetry = (isRateLimit || isTransient) && attempt < currentMaxAttempts && isTranslatingRef.current;

          if (shouldRetry) {
            // Find if there are other keys we can rotate to immediately
            const remainingReadyKeys = availableKeys.filter(
              (k) => !exhaustedSlotIndices.has(k.originalIndex) && k.originalIndex !== currentSlotIndex
            );

            if (remainingReadyKeys.length > 0) {
              setErrorMessage(`Slot #${currentSlotIndex !== null ? currentSlotIndex + 1 : "?"} busy/issue. Rotating to next slot immediately...`);
              await new Promise((resolve) => setTimeout(resolve, 400));
              continue;
            }

            // If it is a persistent daily quota exceeded error, auto-switch to Free Unlimited Engine
            if (isQuotaExceeded) {
              if (config.engineMode !== "gemini_only") {
                setConfig((prev) => ({ ...prev, engineMode: "unlimited_free" }));
                setVideoNotice({
                  type: "info",
                  message: "⚡ Gemini quota exhausted. Switched to Free Unlimited Engine to keep translating your subtitles without stopping!"
                });
                setErrorMessage("");
                await new Promise((resolve) => setTimeout(resolve, 300));
                continue;
              }
              setErrorMessage(
                currentSlotIndex !== null
                  ? `Slot #${currentSlotIndex + 1} daily quota is fully exhausted. Please switch to the Free Unlimited Engine or add another active Gemini API key.`
                  : "The server fallback Gemini API quota is fully exhausted. Please switch to the Free Unlimited Engine or add your own Gemini API key(s) in the settings."
              );
              setIsTranslating(false);
              isTranslatingRef.current = false;
              break;
            }

            // Quick countdown capped to 2-3 seconds to refresh the API quickly
            let delaySec = isTransient ? 2 : 2;
            const delayMatch = errorMsg.match(/retry in ([\d\.]+)s/i);
            if (delayMatch && delayMatch[1]) {
              const parsedSec = parseFloat(delayMatch[1]);
              if (!isNaN(parsedSec)) {
                delaySec = Math.min(3, Math.max(1, Math.round(parsedSec)));
              }
            }
            
            // Tailored countdown label so the user understands the exact state
            let reasonLabel = "Network error";
            if (isUnavailable) {
              reasonLabel = "Gemini server high demand (503)";
            } else if (isDeadline) {
              reasonLabel = "Gemini deadline exceeded / timeout (504/499)";
            } else if (isRateLimit) {
              reasonLabel = "Gemini rate limit (429)";
            }

            // Render a real-time countdown on the screen (fast refreshing in 2-3s)
            for (let sec = delaySec; sec > 0; sec--) {
              if (!isTranslatingRef.current) break;
              setErrorMessage(
                `${reasonLabel}. Refreshing API in ${sec}s... (Attempt ${attempt}/${currentMaxAttempts})`
              );
              await new Promise((resolve) => setTimeout(resolve, 1000));
            }
          } else {
            // Break the retry loop for persistent/non-rate-limit/non-transient errors
            break;
          }
        }
      }

      if (!success) {
        const errorMsg = lastError?.message || "";
        const isQuotaExceeded = checkIsDailyQuotaExceeded(errorMsg, (lastError as any)?.data?.code, (lastError as any)?.data?.status) ||
                                Boolean((lastError as any)?.data?.isQuotaExceeded) ||
                                Boolean((lastError as any)?.data?.requiresUserKey);

        if (isQuotaExceeded) {
          console.warn("[App] Translation paused: Gemini API daily quota limit reached.");
        } else {
          console.error("Batch translate error after retries:", lastError);
        }

        batchIndexes.forEach((idx) => failedIndexesThisRun.add(idx));

        // Mark current batch as failed in state
        currentBlocks = currentBlocks.map((b) =>
          batchIndexes.includes(b.index)
            ? { ...b, status: "failed", error: lastError?.message || "Batch translation failed after retries" }
            : b
        );
        setBlocks(currentBlocks);

        if (isQuotaExceeded) {
          setErrorMessage(lastError?.message || "Daily quota limit reached for this API key. Please add your own free Gemini API key to continue immediately.");
          setIsTranslating(false);
          isTranslatingRef.current = false;
          setActiveSlotIndex(null);
          break;
        }

        consecutiveBatchFailures++;
        if (consecutiveBatchFailures >= 3) {
          setErrorMessage(`Translation paused after consecutive errors: ${lastError?.message || "Unknown error"}. You can click "Retry Failed Blocks".`);
          setIsTranslating(false);
          isTranslatingRef.current = false;
          setActiveSlotIndex(null);
          break;
        } else {
          setErrorMessage(`Batch had an issue. Continuing with remaining blocks (you can retry failed lines anytime)...`);
          await new Promise((resolve) => setTimeout(resolve, 800));
        }
      }

      // Fast, lightweight throttling delay so translation proceeds rapidly
      let currentDelay = 200; // default turbo fast
      const activeKeysCount = apiKeys.filter((k) => k.trim() !== "").length;

      if (config.delayMode === "auto") {
        const effectiveKeys = activeKeysCount || 1;
        currentDelay = Math.max(200, Math.ceil(800 / effectiveKeys));
      } else if (config.delayMode === "custom") {
        currentDelay = config.customDelay !== undefined ? config.customDelay : 1000;
      } else {
        currentDelay = 200; // fast mode (200ms)
      }

      // Display dynamic delay in countdown/status only if it's substantial (>2s)
      if (currentDelay > 2000 && isTranslatingRef.current) {
        for (let msLeft = currentDelay; msLeft > 0; msLeft -= 500) {
          if (!isTranslatingRef.current) break;
          // Only show status of throttling if there is no primary error message
          setErrorMessage((prev) => {
            if (prev && !prev.startsWith("Rate limit wait")) return prev;
            return `Rate limit wait: refreshing in ${(msLeft / 1000).toFixed(1)}s...`;
          });
          await new Promise((resolve) => setTimeout(resolve, Math.min(500, msLeft)));
        }
        setErrorMessage((prev) => prev && prev.startsWith("Rate limit wait") ? "" : prev);
      } else {
        await new Promise((resolve) => setTimeout(resolve, currentDelay));
      }
    }
    setActiveSlotIndex(null);
  };

  // Pause translation loop
  const handlePauseTranslation = () => {
    setIsTranslating(false);
    isTranslatingRef.current = false;
    setActiveSlotIndex(null);
  };

  // Re-translate a single subtitle block
  const handleSingleTranslate = async (index: number, styleOverride?: KhmerStyle) => {
    const blockIndex = blocks.findIndex((b) => b.index === index);
    if (blockIndex === -1) return;

    // Update single status
    setBlocks((prev) =>
      prev.map((b) => (b.index === index ? { ...b, status: "translating" } : b))
    );

    const activeKeysWithOriginalIndex = apiKeys
      .map((key, originalIndex) => ({ key: key.trim(), originalIndex }))
      .filter((item) => item.key !== "");

    let attempt = 0;
    const maxAttempts = Math.max(2, activeKeysWithOriginalIndex.length);
    let success = false;
    let lastError = null;

    while (attempt < maxAttempts && !success) {
      const keyItemToUse = activeKeysWithOriginalIndex.length > 0
        ? activeKeysWithOriginalIndex[attempt % activeKeysWithOriginalIndex.length]
        : null;

      const currentKeyToUse = keyItemToUse ? keyItemToUse.key : undefined;

      try {
        const fullIdx = blockIndex;
        const prevContext = fullIdx > 0 
          ? blocks.slice(Math.max(0, fullIdx - 2), fullIdx).map((cb) => cb.text).join(" / ") 
          : "";
        const nextContext = fullIdx >= 0 && fullIdx < blocks.length - 1 
          ? blocks.slice(fullIdx + 1, Math.min(blocks.length, fullIdx + 3)).map((cb) => cb.text).join(" / ") 
          : "";
        const singleIssues = detectTranslationIssues(blocks[blockIndex].translatedText, blocks[blockIndex].text);
        
        const response = await fetch("/api/translate-batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            blocks: [{
              index,
              text: blocks[blockIndex].text,
              timecode: blocks[blockIndex].timecode,
              prevContext,
              nextContext,
              currentTranslation: blocks[blockIndex].translatedText,
              issues: singleIssues
            }],
            isRepair: true,
            khmerStyle: styleOverride || config.khmerStyle,
            apiKey: currentKeyToUse,
            model: config.model,
          }),
        });

        let data: any = {};
        const contentType = response.headers.get("content-type");
        if (contentType && contentType.includes("application/json")) {
          data = await response.json();
        } else {
          const text = await response.text();
          throw new Error(`Server returned non-JSON response (${response.status} ${response.statusText}): ${text.substring(0, 100)}`);
        }

        if (!response.ok) {
          const err = new Error(data.error || "Single translate failed.");
          (err as any).data = data;
          throw err;
        }

        const result = data.translations && data.translations.find((t: any) => Number(t.index) === index);
        if (result) {
          setBlocks((prev) =>
            prev.map((b) =>
              b.index === index
                ? { ...b, status: "done", translatedText: result.translatedText || "", error: undefined }
                : b
            )
          );
          success = true;
          setErrorMessage(""); // clear error
        } else {
          throw new Error("Translation missing in response.");
        }
      } catch (err: any) {
        lastError = err;
        attempt++;
        const errorMsg = err.message || "";
        const responseData = (err as any).data || {};
        const isQuotaExceeded = responseData.isQuotaExceeded ||
                                errorMsg.includes("GenerateRequestsPerDay") || 
                                errorMsg.includes("PerDayPerProject") ||
                                errorMsg.includes("billing details") ||
                                errorMsg.includes("API_KEY_INVALID") ||
                                errorMsg.toLowerCase().includes("invalid api key") ||
                                errorMsg.toLowerCase().includes("api key not valid") ||
                                errorMsg.includes("limit: 20");

        const isRateLimit = responseData.isRateLimit ||
                            errorMsg.includes("429") || 
                            errorMsg.toLowerCase().includes("rate limit") || 
                            errorMsg.toLowerCase().includes("requests per minute") ||
                            errorMsg.includes("RESOURCE_EXHAUSTED");

        const isUnavailable = responseData.isUnavailable ||
                              errorMsg.includes("503") ||
                              errorMsg.toLowerCase().includes("high demand") ||
                              errorMsg.toLowerCase().includes("unavailable");

        const isDeadline = responseData.isDeadline ||
                           errorMsg.includes("504") ||
                           errorMsg.includes("499") ||
                           errorMsg.toLowerCase().includes("deadline expired") ||
                           errorMsg.toLowerCase().includes("operation was cancelled");

        const isTransient = responseData.isTransient ||
                            isUnavailable ||
                            isDeadline ||
                            errorMsg.toLowerCase().includes("non-json response") ||
                            errorMsg.toLowerCase().includes("doctype") ||
                            errorMsg.toLowerCase().includes("failed to fetch") ||
                            errorMsg.toLowerCase().includes("networkerror") ||
                            errorMsg.toLowerCase().includes("timeout");

        if ((isRateLimit || isTransient) && attempt < maxAttempts) {
          if (activeKeysWithOriginalIndex.length > 1) {
            continue;
          }
          if (isQuotaExceeded) {
            break; // Immediately exit on quota exceeded
          }
          const label = isUnavailable ? "Server high demand" : isDeadline ? "Deadline timeout" : isRateLimit ? "Rate limit" : "Transient network error";
          setErrorMessage(`${label}. Refreshing line in 1.5s...`);
          await new Promise((resolve) => setTimeout(resolve, 1500));
        } else {
          break;
        }
      }
    }

    if (!success) {
      setBlocks((prev) =>
        prev.map((b) =>
          b.index === index ? { ...b, status: "failed", error: lastError?.message } : b
        )
      );
      setErrorMessage(`Single line translation failed: ${lastError?.message}`);
    }
  };

  // Smart-condense a single subtitle line for natural voiceover and dubbing timing
  const handleCondenseSingle = async (index: number, brevityOverride?: "ultra" | "natural") => {
    const blockIndex = blocks.findIndex((b) => b.index === index);
    if (blockIndex === -1) return;
    const targetBlock = blocks[blockIndex];
    const khmerText = targetBlock.translatedText || targetBlock.text;
    if (!khmerText || !khmerText.trim()) return;

    setCondensingIndex(index);
    const activeKeysWithOriginalIndex = apiKeys
      .map((key, originalIndex) => ({ key: key.trim(), originalIndex }))
      .filter((item) => item.key !== "");
    const currentKeyToUse = activeKeysWithOriginalIndex.length > 0 ? activeKeysWithOriginalIndex[0].key : undefined;

    try {
      const duration = parseTimecodeToSeconds(targetBlock.timecode);
      const response = await fetch("/api/condense-voice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [{
            index: targetBlock.index,
            source: targetBlock.text,
            khmer: khmerText,
            timecode: targetBlock.timecode,
            durationSeconds: duration > 0 ? duration : undefined
          }],
          brevityLevel: brevityOverride || condenseBrevity,
          model: config.model,
          apiKey: currentKeyToUse
        })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to shorten line for voice.");
      }

      const resItem = data.results && data.results[0];
      if (resItem && resItem.shortenedText) {
        setBlocks((prev) =>
          prev.map((b) =>
            b.index === index
              ? { ...b, translatedText: resItem.shortenedText, status: "done" as const, error: undefined }
              : b
          )
        );
        setVideoNotice({
          type: "success",
          message: `Line #${index} shortened by ${resItem.reductionPercent}% (${resItem.originalLength} → ${resItem.shortenedLength} chars) for voiceover pacing!`
        });
      }
    } catch (err: any) {
      setErrorMessage(`Could not shorten line #${index}: ${err.message}`);
    } finally {
      setCondensingIndex(null);
    }
  };

  // Smart-condense multiple subtitle lines in fast batches
  const handleBatchCondense = async (scope: "overrun" | "all" = condenseScope, brevity: "ultra" | "natural" = condenseBrevity) => {
    if (isTranslating || isCondensing) return;

    // Select target blocks based on scope
    const targetBlocks = blocks.filter((b) => {
      if (!b.translatedText || b.status !== "done") return false;
      if (scope === "overrun") {
        const duration = parseTimecodeToSeconds(b.timecode);
        if (duration <= 0) return false;
        const cps = b.translatedText.replace(/\s+/g, "").length / duration;
        return cps > 13; // Swift pace (>13) or Overrun hazard (>18)
      }
      return true;
    });

    if (targetBlocks.length === 0) {
      setVideoNotice({
        type: "info",
        message: scope === "overrun"
          ? "Great news! No lines currently exceed standard voiceover reading tempo (all are under 13 CPS)."
          : "No translated subtitle blocks found to shorten."
      });
      setShowCondenseModal(false);
      return;
    }

    setIsCondensing(true);
    setShowCondenseModal(false);
    setCondensingProgress({ current: 0, total: targetBlocks.length });

    let totalOldChars = 0;
    let totalNewChars = 0;
    let totalProcessed = 0;

    const activeKeysWithOriginalIndex = apiKeys
      .map((key, originalIndex) => ({ key: key.trim(), originalIndex }))
      .filter((item) => item.key !== "");
    const currentKeyToUse = activeKeysWithOriginalIndex.length > 0 ? activeKeysWithOriginalIndex[0].key : undefined;

    // Process in batches of 25 for quick turnaround (under 2.5s per batch)
    const batchChunkSize = 25;
    for (let i = 0; i < targetBlocks.length; i += batchChunkSize) {
      const chunk = targetBlocks.slice(i, i + batchChunkSize);
      try {
        const response = await fetch("/api/condense-voice", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            items: chunk.map((b) => ({
              index: b.index,
              source: b.text,
              khmer: b.translatedText,
              timecode: b.timecode,
              durationSeconds: parseTimecodeToSeconds(b.timecode)
            })),
            brevityLevel: brevity,
            model: config.model,
            apiKey: currentKeyToUse
          })
        });

        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || "Batch voice condense failed.");
        }

        if (Array.isArray(data.results)) {
          const resultMap = new Map<number, any>();
          data.results.forEach((r: any) => {
            resultMap.set(Number(r.index), r);
            totalOldChars += r.originalLength || 0;
            totalNewChars += r.shortenedLength || 0;
          });

          setBlocks((prev) =>
            prev.map((b) => {
              const res = resultMap.get(b.index);
              if (res && res.shortenedText) {
                return { ...b, translatedText: res.shortenedText, status: "done" as const, error: undefined };
              }
              return b;
            })
          );
        }

        totalProcessed += chunk.length;
        setCondensingProgress({ current: Math.min(totalProcessed, targetBlocks.length), total: targetBlocks.length });
      } catch (err: any) {
        console.error("Error condensing batch:", err);
        setErrorMessage(`Error while condensing subtitles for voice: ${err.message}`);
        break;
      }
    }

    setIsCondensing(false);
    const avgReduction = totalOldChars > 0 ? Math.round(((totalOldChars - totalNewChars) / totalOldChars) * 100) : 0;
    setCondenseStatsSummary({
      count: totalProcessed,
      avgReduction,
      oldChars: totalOldChars,
      newChars: totalNewChars
    });

    setVideoNotice({
      type: "success",
      message: `⚡ Voice Condense Complete! Shortened ${totalProcessed} lines by ${avgReduction}% average (${totalOldChars} → ${totalNewChars} chars). Perfect for smooth dubbing & TTS!`
    });
  };

  // Reset/Clear everything
  const handleReset = () => {
    setIsTranslating(false);
    isTranslatingRef.current = false;
    setRawInput("");
    setRawSubtitleSourceText("");
    setSamiLanguageTracks([]);
    setSelectedLanguageTrack("auto");
    setScriptFilter("all");
    setBlocks([]);
    setErrorMessage("");
    setIsKeyMissing(false);
    setSearchQuery("");
    setStatusFilter("all");
    setEditingIndex(null);
    setActiveSlotIndex(null);
    setUploadedFileName("");
  };

  // Download translated SRT file
  const handleDownloadSRT = (useKhmer = true) => {
    if (blocks.length === 0) return;
    const content = stringifySRT(blocks, useKhmer);
    const blob = new Blob([content], { type: "text/srt;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    const suffix = useKhmer ? "_khmer" : "_original";
    
    let baseName = "translated_subtitles";
    if (uploadedFileName) {
      const lastDotIndex = uploadedFileName.lastIndexOf(".");
      if (lastDotIndex !== -1) {
        baseName = uploadedFileName.substring(0, lastDotIndex);
      } else {
        baseName = uploadedFileName;
      }
    }
    
    link.setAttribute("download", `${baseName}${suffix}.srt`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Download translated WebVTT file
  const handleDownloadVTT = (useKhmer = true) => {
    if (blocks.length === 0) return;
    const content = stringifyVTT(blocks, useKhmer);
    const blob = new Blob([content], { type: "text/vtt;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    const suffix = useKhmer ? "_khmer" : "_original";
    
    let baseName = "translated_subtitles";
    if (uploadedFileName) {
      const lastDotIndex = uploadedFileName.lastIndexOf(".");
      if (lastDotIndex !== -1) {
        baseName = uploadedFileName.substring(0, lastDotIndex);
      } else {
        baseName = uploadedFileName;
      }
    }
    
    link.setAttribute("download", `${baseName}${suffix}.vtt`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Copy translated SRT to clipboard
  const handleCopyToClipboard = () => {
    if (blocks.length === 0) return;
    const content = stringifySRT(blocks, true);
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  // Start inline editing mode for a block
  const handleStartEdit = (index: number, text: string) => {
    setEditingIndex(index);
    setEditingText(text);
  };

  // Save manual translation edits
  const handleSaveEdit = (index: number) => {
    setBlocks((prev) =>
      prev.map((b) =>
        b.index === index ? { ...b, translatedText: cleanEllipses(editingText), status: "done" } : b
      )
    );
    setEditingIndex(null);
  };

  // One-click remove ellipsis sign from all translated sentences
  const handleRemoveAllEllipses = () => {
    let changedCount = 0;
    setBlocks((prev) =>
      prev.map((b) => {
        if (!b.translatedText) return b;
        const cleaned = cleanEllipses(b.translatedText);
        if (cleaned !== b.translatedText) {
          changedCount++;
          return { ...b, translatedText: cleaned };
        }
        return b;
      })
    );
    setVideoNotice({
      type: "success",
      message: `Removed ellipsis signs (...) from ${changedCount} sentences.`
    });
  };

  // One-click fix all kinship mismatches (Husband vs Brother-in-Law)
  const handleFixAllKinship = () => {
    let changedCount = 0;
    setBlocks((prev) =>
      prev.map((b) => {
        if (!b.translatedText || !b.text) return b;
        const aligned = alignKinshipTerms(b.translatedText, b.text);
        if (aligned !== b.translatedText) {
          changedCount++;
          return { ...b, translatedText: aligned };
        }
        return b;
      })
    );
    setVideoNotice({
      type: "success",
      message: `Aligned kinship terms (husband / brother-in-law) in ${changedCount} sentences.`
    });
  };

  // Fix single block kinship mismatch
  const handleFixSingleKinship = (index: number) => {
    setBlocks((prev) =>
      prev.map((b) => {
        if (b.index === index && b.translatedText && b.text) {
          return { ...b, translatedText: alignKinshipTerms(b.translatedText, b.text) };
        }
        return b;
      })
    );
  };

  // One-click purge of all Burmese, Arabic, Thai, Lao, and other foreign scripts across all blocks
  const handleCleanAllForeignScripts = () => {
    let changedCount = 0;
    setBlocks((prev) =>
      prev.map((b) => {
        if (!b.translatedText) return b;
        const cleaned = cleanForeignAndAnomalousScripts(b.translatedText, b.text);
        if (cleaned !== b.translatedText) {
          changedCount++;
          return { ...b, translatedText: cleaned, status: "done" as const };
        }
        return b;
      })
    );
    setVideoNotice({
      type: "success",
      message: `✨ Converted amount numbers to Khmer sentence words (មួយសែន, មួយលាន, មួយរយលាន), purged foreign scripts, and restored pure Khmer across ${changedCount} lines!`
    });
  };

  // One-click instant fix for all notice lines: converts amounts to Khmer words (មួយសែន, មួយលាន, មួយរយលាន), foreign scripts, Burmese, Arabic, ellipses, kinship mismatches, orphan vowels
  const handleInstantFixAllNotices = () => {
    let fixedCount = 0;
    setBlocks((prev) =>
      prev.map((b) => {
        if (!b.translatedText) return b;
        const issues = detectTranslationIssues(b.translatedText, b.text);
        if (issues.length === 0) return b;
        const cleaned = cleanForeignAndAnomalousScripts(b.translatedText, b.text);
        if (cleaned !== b.translatedText && cleaned.trim().length > 0) {
          fixedCount++;
          return { ...b, translatedText: cleaned, status: "done" as const };
        }
        return b;
      })
    );
    setVideoNotice({
      type: "success",
      message: `✨ Solved anomalies and converted amount numbers to Khmer sentence words across ${fixedCount} notice lines with instant repair!`
    });
  };

  // Load subtitles from blocks into notepad text representation
  const handleLoadToNotepad = (mode: "plain" | "srt" | "notices") => {
    if (blocks.length === 0) return;
    
    if (mode === "notices") {
      const noticeBlocks = blocks.filter((b) => {
        const issues = detectTranslationIssues(b.translatedText, b.text);
        const origHadLetters = /[a-zA-Z\u4e00-\u9fa5\d]/.test(b.text);
        const isMissing = origHadLetters && (!b.translatedText || b.translatedText.trim() === "");
        const isFailed = b.status === "failed";
        return issues.length > 0 || isMissing || isFailed;
      });

      if (noticeBlocks.length === 0) {
        setNotepadText("# 🎉 100% CLEAN: No translation notices, Chinese characters, or foreign language anomalies found in any line!");
      } else {
        const text = noticeBlocks.map((b) => {
          const issues = detectTranslationIssues(b.translatedText, b.text);
          const issueTag = issues.length > 0 ? ` [NOTICE: ${issues.join("; ")}]` : (b.status === "failed" ? " [FAILED]" : " [MISSING]");
          return `#${b.index}${issueTag}: ${b.translatedText || b.text}`;
        }).join("\n");
        setNotepadText(text);
      }
    } else if (mode === "srt") {
      setNotepadText(stringifySRT(blocks, true));
    } else {
      const text = blocks.map((b) => `#${b.index}: ${b.translatedText || b.text}`).join("\n");
      setNotepadText(text);
    }
    setNotepadMode(mode);
  };

  // Parse and save edited text from notepad back to subtitles blocks
  const handleSaveFromNotepad = () => {
    if (!notepadText.trim()) return;
    
    let updatedBlocks = [...blocks];
    
    if (notepadMode === "srt") {
      try {
        const parsed = parseSRT(notepadText);
        if (parsed.length > 0) {
          updatedBlocks = blocks.map((originalBlock) => {
            const parsedBlock = parsed.find((p) => p.index === originalBlock.index);
            if (parsedBlock) {
              return {
                ...originalBlock,
                translatedText: cleanEllipses(parsedBlock.translatedText || parsedBlock.text),
                status: "done" as const
              };
            }
            return originalBlock;
          });
          setBlocks(updatedBlocks);
          setNotepadSaveSuccess(true);
          setTimeout(() => setNotepadSaveSuccess(false), 3000);
        }
      } catch (err: any) {
        setErrorMessage(`Notepad Parse Error: ${err.message}`);
      }
    } else {
      const lines = notepadText.split("\n");
      const indexMap = new Map<number, string>();
      
      let sequentialIndex = 1;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("# 🎉") || trimmed.startsWith("//")) continue;
        
        // Match `#123 [NOTICE...]: text` or `#123: text` or `123: text` or `[123] text`
        const match = trimmed.match(/^(?:#|\[)?(\d+)(?:\]|:|\s*\[[^\]]*\]\s*:?|\s+\-\s+|\s*\.\s*)\s*(.*)$/);
        if (match) {
          const idx = parseInt(match[1], 10);
          const text = match[2];
          indexMap.set(idx, cleanEllipses(text));
        } else {
          indexMap.set(sequentialIndex, cleanEllipses(trimmed));
          sequentialIndex++;
        }
      }
      
      updatedBlocks = blocks.map((b) => {
        if (indexMap.has(b.index)) {
          return {
            ...b,
            translatedText: indexMap.get(b.index)!,
            status: "done" as const
          };
        }
        return b;
      });
      setBlocks(updatedBlocks);
      setNotepadSaveSuccess(true);
      setTimeout(() => setNotepadSaveSuccess(false), 3000);
    }
  };

  // Re-translate all blocks with warnings/notices, missing translations, or failed status
  const handleReTranslateWarnings = () => {
    if (isTranslating) return;
    const updated = blocks.map((b) => {
      const issues = detectTranslationIssues(b.translatedText, b.text);
      const origHadChinese = /[\u4e00-\u9fff]/.test(b.text);
      const isMissing = origHadChinese && (!b.translatedText || b.translatedText.trim() === "");
      const isFailed = b.status === "failed";
      if (issues.length > 0 || isMissing || isFailed) {
        return { ...b, status: "pending" as const, error: undefined };
      }
      return b;
    });
    setBlocks(updated);
    startTranslationLoop(updated);
  };

  // Filter & Search computation
  const warningsCount = useMemo(() => {
    return blocks.filter((b) => {
      const origHadChinese = /[\u4e00-\u9fff]/.test(b.text);
      const isMissing = origHadChinese && (!b.translatedText || b.translatedText.trim() === "");
      const isFailed = b.status === "failed";
      if (!b.translatedText) return isMissing || isFailed;
      const issues = detectTranslationIssues(b.translatedText, b.text);
      return issues.length > 0 || isMissing || isFailed;
    }).length;
  }, [blocks]);

  const ellipsisLinesCount = useMemo(() => {
    return blocks.filter((b) => b.translatedText && (/\.{2,}|…|·{2,}|\(\s*\.{2,}\s*\)/.test(b.translatedText))).length;
  }, [blocks]);

  const kinshipMismatchCount = useMemo(() => {
    return blocks.filter((b) => {
      if (!b.translatedText || !b.text) return false;
      return detectTranslationIssues(b.translatedText, b.text).some((i) => i.includes("Kinship mismatch"));
    }).length;
  }, [blocks]);

  const foreignScriptMismatchCount = useMemo(() => {
    return blocks.filter((b) => {
      if (!b.translatedText) return false;
      return (
        /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff\u0e00-\u0e7f\u0e80-\u0eff\u0400-\u04ff\u0900-\u097f\u1000-\u109f\ua9e0-\ua9fe]/.test(b.translatedText) ||
        b.translatedText.includes("ခរុ") ||
        b.translatedText.includes("ត្រីក្រពើ") ||
        b.translatedText.includes("ត្រីក្រពេី") ||
        /(?:^|\s)[្\u17b6-\u17d1]/.test(b.translatedText)
      );
    }).length;
  }, [blocks]);

  const quickFixableNoticesCount = useMemo(() => {
    return blocks.filter((b) => {
      if (!b.translatedText) return false;
      const issues = detectTranslationIssues(b.translatedText, b.text);
      if (issues.length === 0) return false;
      const cleaned = cleanForeignAndAnomalousScripts(b.translatedText, b.text);
      return cleaned !== b.translatedText && cleaned.trim().length > 0;
    }).length;
  }, [blocks]);

  const filteredBlocks = useMemo(() => {
    return blocks.filter((block) => {
      // Filter by language script (Chinese, Korean, English, Japanese)
      if (scriptFilter !== "all") {
        const text = block.text.trim();
        if (scriptFilter === "zh" && !/[\u4e00-\u9fa5]/.test(text)) return false;
        if (scriptFilter === "ko" && !/[\uac00-\ud7af\u1100-\u11ff]/.test(text)) return false;
        if (scriptFilter === "ja" && !/[\u3040-\u30ff]/.test(text)) return false;
        if (scriptFilter === "en" && (!/[a-zA-Z]/.test(text) || /[\u4e00-\u9fa5\uac00-\ud7af\u3040-\u30ff]/.test(text))) return false;
      }
      // Filter by status dropdown or warnings check
      if (statusFilter === "warnings") {
        const issues = detectTranslationIssues(block.translatedText, block.text);
        const origHadChinese = /[\u4e00-\u9fff]/.test(block.text);
        const isMissing = origHadChinese && (!block.translatedText || block.translatedText.trim() === "");
        const isFailed = block.status === "failed";
        if (issues.length === 0 && !isMissing && !isFailed) return false;
      } else if (statusFilter !== "all" && block.status !== statusFilter) {
        return false;
      }
      // Filter by search text
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        const matchesIndex = block.index.toString() === query;
        const matchesOriginal = block.text.toLowerCase().includes(query);
        const matchesTranslation = block.translatedText.toLowerCase().includes(query);
        return matchesIndex || matchesOriginal || matchesTranslation;
      }
      return true;
    });
  }, [blocks, statusFilter, scriptFilter, searchQuery]);

  const totalPages = useMemo(() => {
    return Math.ceil(filteredBlocks.length / itemsPerPage);
  }, [filteredBlocks.length, itemsPerPage]);

  const displayedBlocks = useMemo(() => {
    const startIndex = (currentPage - 1) * itemsPerPage;
    return filteredBlocks.slice(startIndex, startIndex + itemsPerPage);
  }, [filteredBlocks, currentPage, itemsPerPage]);

  return (
    <div className="bg-[#0D0D0D] text-[#EBEBEB] min-h-screen font-sans flex flex-col antialiased selection:bg-[#FF9F0A]/20 selection:text-white">
      {/* Top Navigation Bar */}
      <nav className="flex items-center justify-between px-6 py-4 border-b border-[#1F1F1F] bg-[#0D0D0D] sticky top-0 z-40">
        <div className="flex items-center space-x-4">
          <div className="w-8 h-8 rounded bg-[#FF9F0A] flex items-center justify-center font-bold text-black shrink-0">Σ</div>
          <div>
            <h1 className="text-lg font-medium tracking-tight">CHHUN KPC <span className="text-[#888]">v2.4</span></h1>
            <p className="text-[10px] text-[#555] tracking-wide mt-0.5">Chinese-Khmer SRT Translator</p>
          </div>
        </div>

        {/* Selected style mode pill tracker */}
        <div className="hidden md:flex items-center bg-[#1A1A1A] rounded-full px-4 py-1.5 border border-[#2A2A2A] space-x-3">
          <span className="text-xs font-semibold text-[#888] uppercase tracking-widest">Chinese (Simplified)</span>
          <ArrowRight className="w-4 h-4 text-[#444]" />
          <span className="text-xs font-semibold text-[#FF9F0A] uppercase tracking-widest flex items-center gap-1">
            {config.khmerStyle === "concise" ? "✨ Concise Khmer (ខ្លីខ្លឹម)" : `${config.khmerStyle} Khmer`}
          </span>
        </div>

        <div className="flex items-center space-x-2.5">
          <button
            onClick={() => handleDownloadSRT(true)}
            disabled={blocks.length === 0}
            className="px-4 py-2 text-xs font-medium bg-[#FF9F0A] text-black hover:bg-[#e68e09] rounded-md transition-colors disabled:opacity-30 disabled:pointer-events-none flex items-center gap-1.5 font-semibold"
            title="Export as SubRip format (.srt)"
          >
            <Download className="h-3.5 w-3.5" />
            <span>Export .SRT</span>
          </button>

          <button
            onClick={() => setShowCodeModal(true)}
            className="px-3.5 py-2 text-xs font-medium bg-[#1A1A1A] border border-[#2A2A2A] text-[#EBEBEB] hover:bg-[#222] rounded-md transition-all flex items-center gap-1.5 hover:border-sky-500/50"
            title="View app code, export functions, and codebase instructions"
          >
            <Code className="h-3.5 w-3.5 text-sky-400" />
            <span>App Code</span>
          </button>

          <button
            onClick={() => handleSafeBlobDownload("/api/download-app-html", "chinese-khmer-translator-app.html")}
            disabled={downloadingFormat !== null}
            className="px-3.5 py-2 text-xs font-semibold bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20 rounded-md transition-all flex items-center gap-1.5 shadow-sm disabled:opacity-50"
            title="Download complete standalone HTML web app that runs in ANY browser with double-click (no server/install required)"
          >
            {downloadingFormat === "chinese-khmer-translator-app.html" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-400" />
            ) : (
              <Download className="h-3.5 w-3.5 text-emerald-400" />
            )}
            <span>Download HTML App (.html)</span>
          </button>

          <button
            onClick={() => handleSafeBlobDownload("/api/download-all-code-html", "chinese-khmer-translator-all-code.html")}
            disabled={downloadingFormat !== null}
            className="px-3.5 py-2 text-xs font-semibold bg-sky-500/10 border border-sky-500/30 text-sky-400 hover:bg-sky-500/20 rounded-md transition-all flex items-center gap-1.5 shadow-sm disabled:opacity-50"
            title="Download all repository code files combined in a single interactive HTML file"
          >
            {downloadingFormat === "chinese-khmer-translator-all-code.html" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-400" />
            ) : (
              <FileText className="h-3.5 w-3.5 text-sky-400" />
            )}
            <span>All Code in 1 File (.html)</span>
          </button>

          <button
            onClick={handleCopyToClipboard}
            disabled={blocks.length === 0}
            className="px-4 py-2 text-xs font-medium bg-transparent border border-[#2A2A2A] text-[#EBEBEB] hover:bg-[#1A1A1A] rounded-md transition-colors disabled:opacity-30 disabled:pointer-events-none flex items-center gap-1.5"
          >
            {copied ? (
              <>
                <Check className="h-3.5 w-3.5 text-emerald-400" />
                <span>Copied</span>
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" />
                <span>Copy SRT</span>
              </>
            )}
          </button>
          
          {videoUrl ? (
            <button
              onClick={handleCloseVideo}
              className="px-3 py-2 text-xs font-medium bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20 rounded-md transition-colors flex items-center gap-1.5"
              title="Close active video"
            >
              <Film className="h-3.5 w-3.5" />
              <span>Close Video</span>
            </button>
          ) : (
            <button
              onClick={() => fileInputRef.current?.click()}
              className="px-3 py-2 text-xs font-medium bg-[#1A1A1A] border border-[#2A2A2A] text-[#EBEBEB] hover:bg-[#222] rounded-md transition-colors flex items-center gap-1.5"
              title="Upload video or subtitle file"
            >
              <Film className="h-3.5 w-3.5 text-[#FF9F0A]" />
              <span>Load Video / Subs</span>
            </button>
          )}

          <button
            onClick={() => handleDownloadVTT(true)}
            disabled={blocks.length === 0}
            className="px-3 py-2 text-xs font-medium bg-[#1A1A1A] border border-[#2A2A2A] text-[#EBEBEB] hover:bg-[#222] rounded-md transition-colors disabled:opacity-30 disabled:pointer-events-none flex items-center gap-1.5"
            title="Export as WebVTT format (.vtt)"
          >
            <Download className="h-3.5 w-3.5 text-blue-400" />
            <span>.VTT</span>
          </button>

          <button
            onClick={() => {
              if (!showNotepad) {
                if (!notepadText.trim() && blocks.length > 0) {
                  const text = notepadMode === "srt"
                    ? stringifySRT(blocks, true)
                    : blocks.map((b) => `#${b.index}: ${b.translatedText || b.text}`).join("\n");
                  setNotepadText(text);
                }
              }
              setShowNotepad(!showNotepad);
            }}
            className={`px-4 py-2 text-xs font-medium border rounded-md transition-all flex items-center gap-1.5 ${
              showNotepad
                ? "bg-amber-500/10 border-amber-500 text-amber-400 font-semibold"
                : "bg-transparent border-[#2A2A2A] text-[#EBEBEB] hover:bg-[#1A1A1A]"
            }`}
            title="Open Notepad / Scratchpad"
          >
            <FileText className="h-3.5 w-3.5" />
            <span>Notepad / Scratchpad</span>
          </button>
        </div>
      </nav>

      {/* Main Interface Layout */}
      <main className="flex-1 flex flex-col lg:flex-row overflow-hidden">
        
        {/* Left Side: Controls & Input Panel (Sidebar) */}
        <aside className="w-full lg:w-80 border-b lg:border-b-0 lg:border-r border-[#1F1F1F] p-5 space-y-6 flex flex-col overflow-y-auto bg-[#0D0D0D] shrink-0">
          
          {/* Subtitle Example Presets */}
          <div>
            <label className="block text-[10px] uppercase tracking-widest text-[#888] mb-3">Subtitle Preset Context</label>
            <div className="flex flex-col gap-2">
              {EXAMPLE_SUBTITLES.map((ex) => (
                <button
                  key={ex.id}
                  onClick={() => handleLoadExample(ex.id)}
                  disabled={isTranslating}
                  className="text-left w-full p-3 text-xs rounded-lg bg-[#131313] border border-[#222] hover:bg-[#1A1A1A] hover:border-[#333] disabled:opacity-50 transition-all flex flex-col gap-1 group"
                >
                  <div className="flex items-center justify-between w-full">
                    <span className="font-medium text-[#EBEBEB] group-hover:text-[#FF9F0A] transition-colors">
                      {ex.title}
                    </span>
                    <ArrowRight className="h-3 w-3 text-[#555] group-hover:translate-x-1 group-hover:text-[#FF9F0A] transition-all" />
                  </div>
                  <span className="text-[#555] text-[10px] leading-relaxed">
                    {ex.description}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Subtitle & Video Source Inputs */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <label className="block text-[10px] uppercase tracking-widest text-[#888]">Source Subtitles / Video</label>
              
              <div className="flex items-center gap-2">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isTranslating}
                  className="text-[10px] text-[#FF9F0A] hover:underline flex items-center gap-1 font-mono uppercase tracking-wider bg-transparent border-0"
                  title="Upload .SRT, .VTT, .ASS, or Video files (.MKV, .MP4, .WEBM)"
                >
                  <FileUp className="h-3 w-3" />
                  Upload File
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".srt,.smi,.sami,.vtt,.ass,.ssa,.xml,.ttml,.dfxp,.sub,.sbv,.lrc,.txt,.mp4,.mkv,.webm,.mov,.avi,.m4v,.ts"
                  onChange={(e) => {
                    if (e.target.files?.[0]) handleFileUpload(e.target.files[0]);
                  }}
                  className="hidden"
                />
              </div>
            </div>

            {/* Paste box or drag overlay */}
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              className={`relative rounded-lg border transition-all ${
                isDragging
                  ? "border-[#FF9F0A] bg-[#FF9F0A]/5"
                  : "border-[#222] bg-[#131313]"
              }`}
            >
              <textarea
                value={rawInput}
                onChange={(e) => {
                  setRawInput(e.target.value);
                  setRawSubtitleSourceText(e.target.value);
                }}
                disabled={isTranslating}
                placeholder="Paste SRT / SAMI (.smi) / VTT / ASS / Subtitles, or drop a video file (.MKV, .MP4)..."
                className="w-full h-36 p-3 bg-transparent text-xs text-[#AAA] font-mono focus:outline-none resize-none leading-relaxed"
              />
              {isDragging && (
                <div className="absolute inset-0 bg-[#0D0D0D]/95 flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-[#FF9F0A]">
                  <FileUp className="h-6 w-6 text-[#FF9F0A] animate-bounce" />
                  <span className="text-xs font-semibold text-[#FF9F0A]">Drop subtitle (.srt, .smi, .vtt, .ass) or video (.mkv, .mp4)</span>
                </div>
              )}
            </div>

            <div className="flex gap-2 mt-2">
              <button
                onClick={() => handleParse()}
                disabled={isTranslating || !rawInput.trim()}
                className="flex-1 py-1.5 px-3 text-[11px] font-medium bg-[#1A1A1A] text-[#EBEBEB] border border-[#2A2A2A] hover:bg-[#222] rounded-md transition-colors disabled:opacity-40 flex items-center justify-center gap-1"
              >
                <Eye className="h-3.5 w-3.5 text-[#FF9F0A]" />
                Parse & Preview
              </button>
              <button
                onClick={handleReset}
                className="px-2 bg-transparent border border-[#222] text-[#555] hover:text-red-400 hover:border-red-950/40 rounded-md transition-colors"
                title="Clear Everything"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>

            {/* Detected SAMI Multi-Language Tracks Selector */}
            {samiLanguageTracks.length > 0 && (
              <div className="mt-3 p-3 bg-[#111] rounded-lg border border-[#FF9F0A]/30 space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-semibold text-[#FF9F0A] uppercase tracking-wider flex items-center gap-1.5">
                    <Globe className="h-3.5 w-3.5 text-[#FF9F0A]" />
                    Language Tracks ({samiLanguageTracks.length})
                  </span>
                  <span className="text-[9px] text-[#777] font-mono">Choose 1 track</span>
                </div>
                <div className="flex flex-col gap-1.5">
                  {samiLanguageTracks.map((track) => (
                    <button
                      key={track.id}
                      onClick={() => handleSelectSAMITrack(track.id)}
                      disabled={isTranslating}
                      className={`flex items-center justify-between px-2.5 py-1.5 text-xs rounded-md border transition-all text-left disabled:opacity-50 ${
                        selectedLanguageTrack === track.id
                          ? "bg-[#FF9F0A]/15 border-[#FF9F0A] text-[#FF9F0A] font-semibold shadow-sm"
                          : "bg-[#161616] border-[#222] text-[#AAA] hover:text-[#FFF] hover:border-[#333] hover:bg-[#1A1A1A]"
                      }`}
                    >
                      <span className="truncate pr-1">{track.label}</span>
                      {track.cueCount !== undefined && (
                        <span className="text-[9px] font-mono text-[#777] bg-[#000]/50 px-1.5 py-0.5 rounded shrink-0">
                          {track.cueCount.toLocaleString()} cues
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Gemini API Key Configuration Section (Optional Multi-Slot Rotation) */}
          <div className="space-y-3 pt-4 border-t border-[#1F1F1F]">
            <div className="flex items-center justify-between">
              <div className="flex flex-col">
                <div className="flex items-center gap-1.5">
                  <label className="block text-[10px] uppercase tracking-widest text-[#888]">Gemini API Key</label>
                  <span className="text-[9px] text-emerald-400 font-mono bg-emerald-950/30 border border-emerald-500/20 px-1 py-0.2 rounded text-[8px]">OPTIONAL</span>
                </div>
                <span className="text-[9px] text-[#666] font-mono mt-0.5">
                  Built-in server key active • {apiKeys.filter(k => k.trim() !== "").length > 0 ? `${apiKeys.filter(k => k.trim() !== "").length} custom key(s)` : "No key needed"}
                </span>
              </div>
              <button
                type="button"
                onClick={handleAddKeySlot}
                disabled={apiKeys.length >= 10}
                className="text-[9px] text-[#FF9F0A] hover:text-[#e68e09] flex items-center gap-1 font-mono uppercase tracking-widest disabled:opacity-30 bg-transparent border-0"
              >
                <Plus className="h-3 w-3" />
                Add Slot
              </button>
            </div>

            {config.engineMode !== "unlimited_free" && (
              <button
                type="button"
                onClick={() => setConfig((prev) => ({ ...prev, engineMode: "unlimited_free" }))}
                className="w-full text-left p-2 bg-[#141414] hover:bg-[#1a1a1a] rounded-lg border border-[#262626] flex items-center justify-between text-[9px] text-[#AAA] hover:text-white transition-colors cursor-pointer"
              >
                <span className="flex items-center gap-1.5 text-amber-300 font-medium">
                  <Sparkles className="w-3 h-3 text-[#FF9F0A]" />
                  <span>No API Key? Use Free Unlimited Engine</span>
                </span>
                <span className="text-[8px] font-mono text-[#FF9F0A] bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/20">
                  0 Quota Limits
                </span>
              </button>
            )}

            <div className="space-y-2 max-h-[180px] overflow-y-auto pr-1">
              {apiKeys.map((key, idx) => {
                const isActive = activeSlotIndex === idx;
                const isEmpty = key.trim() === "";
                const slotInfo = slotStatuses[idx];
                const status = slotInfo?.status;

                let cardBorderClass = "border-[#222] bg-[#131313] focus-within:border-[#444]";
                if (isActive) {
                  cardBorderClass = "border-[#FF9F0A] bg-[#FF9F0A]/5 shadow-[0_0_8px_rgba(255,159,10,0.15)]";
                } else if (status === "exhausted") {
                  cardBorderClass = "border-red-900 bg-red-950/5 focus-within:border-red-800";
                } else if (status === "rate-limited") {
                  cardBorderClass = "border-amber-800 bg-amber-950/5 focus-within:border-amber-700";
                }

                return (
                  <div 
                    key={idx}
                    className={`relative flex items-center border rounded-lg px-2.5 py-1.5 transition-all ${cardBorderClass}`}
                  >
                    <div className="flex-1 flex flex-col gap-0.5 min-w-0 pr-8">
                      <span className="text-[8px] font-mono uppercase tracking-wider text-[#555] flex items-center gap-1.5 flex-wrap">
                        <span>Slot #{idx + 1}</span>
                        {isActive && (
                          <span className="text-[#FF9F0A] font-bold flex items-center gap-1">
                            <span className="w-1 h-1 rounded-full bg-[#FF9F0A] animate-ping" />
                            ACTIVE
                          </span>
                        )}
                        {!isActive && status === "exhausted" && (
                          <span className="text-red-500 font-bold flex items-center gap-1" title="Daily Quota Exceeded">
                            <span className="w-1 h-1 rounded-full bg-red-500 animate-pulse" />
                            QUOTA EXHAUSTED
                          </span>
                        )}
                        {!isActive && status === "rate-limited" && (
                          <span className="text-amber-500 font-bold flex items-center gap-1" title="Temporary rate limit">
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                            RATE-LIMITED
                          </span>
                        )}
                        {!isActive && status === "error" && (
                          <span className="text-red-400 font-semibold flex items-center gap-1">
                            ERROR
                          </span>
                        )}
                        {!isEmpty && !isActive && (!status || status === "ready") && (
                          <span className="text-emerald-400 font-semibold">READY</span>
                        )}
                        {isEmpty && (
                          <span className="text-[#444] font-normal">EMPTY</span>
                        )}
                      </span>
                      <input
                        type="password"
                        placeholder="Paste Gemini API Key..."
                        value={key}
                        onChange={(e) => handleUpdateKeyAtSlot(idx, e.target.value)}
                        className="w-full bg-transparent text-xs text-[#EBEBEB] focus:outline-none placeholder-[#333] font-mono"
                      />
                    </div>
                    
                    <button
                      type="button"
                      onClick={() => handleRemoveKeySlot(idx)}
                      className="absolute right-2 text-[9px] text-[#555] hover:text-red-400/90 font-mono tracking-wide uppercase px-1 py-1 rounded hover:bg-red-950/20 transition-all"
                      title="Clear or remove slot"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
            <p className="text-[9px] text-[#666] leading-relaxed">
              CHHUN KPC uses the built-in server Gemini engine by default — no API key is required. Adding your own keys is 100% optional for power users translating thousands of lines without waiting.
            </p>
          </div>

          {/* Colloquial Level & Translation Style Settings */}
          <div className="space-y-4 pt-2 border-t border-[#1F1F1F]">
            
            {/* Tone preset selector */}
            <div>
              <div className="flex justify-between items-center mb-2.5">
                <label className="block text-[10px] uppercase tracking-widest text-[#888]">Translation Style Preset</label>
                {config.khmerStyle === "concise" && (
                  <span className="text-[9px] font-mono text-amber-400 bg-amber-950/40 px-1.5 py-0.5 rounded border border-amber-800/40 flex items-center gap-1">
                    <Sparkles className="w-2.5 h-2.5" /> Concise & Clear (ខ្លីខ្លឹម)
                  </span>
                )}
                {config.khmerStyle === "voiceover" && (
                  <span className="text-[9px] font-mono text-emerald-400 bg-emerald-950/40 px-1.5 py-0.5 rounded border border-emerald-800/40 flex items-center gap-1">
                    <Mic className="w-2.5 h-2.5" /> TTS-Ready
                  </span>
                )}
              </div>
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-1 bg-[#131313] p-1 rounded-lg border border-[#222]">
                {(["colloquial", "concise", "voiceover", "funny", "formal", "literal"] as KhmerStyle[]).map((style) => (
                  <button
                    key={style}
                    onClick={() => setConfig((prev) => ({ ...prev, khmerStyle: style }))}
                    disabled={isTranslating}
                    className={`py-1.5 px-1 text-[9px] font-medium capitalize rounded transition-all flex items-center justify-center gap-0.5 ${
                      config.khmerStyle === style
                        ? style === "concise"
                          ? "bg-amber-400 text-black shadow-sm font-bold"
                          : style === "voiceover"
                          ? "bg-emerald-500 text-black shadow-sm font-bold"
                          : "bg-[#FF9F0A] text-black shadow-sm font-bold"
                        : "text-[#888] hover:text-[#EBEBEB]"
                    }`}
                  >
                    {style === "concise"
                      ? "✨ Concise"
                      : style === "voiceover"
                      ? "🎙️ Voice"
                      : style === "colloquial"
                      ? "🗣️ Natural"
                      : style === "funny"
                      ? "🎭 Comic"
                      : style === "formal"
                      ? "📚 Formal"
                      : "🔍 Literal"}
                  </button>
                ))}
              </div>
              {config.khmerStyle === "concise" && (
                <p className="mt-1.5 text-[10px] text-amber-300/90 bg-amber-950/20 px-2 py-1 rounded border border-amber-500/20">
                  ⚡ <strong>Concise Mode (បង្រួមខ្លីខ្លឹម):</strong> Translates without wordy bloat or grammatical filler particles while preserving 100% of the original meaning, character emotion, and clarity.
                </p>
              )}
            </div>

            {/* Style slider for visual feedback as specified in design mockup */}
            <div>
              <div className="flex justify-between items-center text-[10px] uppercase tracking-widest text-[#888] mb-2">
                <span>Pacing & Idiom Profile</span>
                <span className="text-[#FF9F0A] font-mono">
                  {config.khmerStyle === "concise"
                    ? "✨ Concise & Clear (ខ្លីខ្លឹម)"
                    : config.khmerStyle === "voiceover"
                    ? "⚡ Compact Voice 🎙️"
                    : config.khmerStyle === "colloquial"
                    ? "85% Street 🗣️"
                    : config.khmerStyle === "funny"
                    ? "100% Comic Slang 🎭"
                    : config.khmerStyle === "formal"
                    ? "10% Polite 📚"
                    : "40% Faithful 🔍"}
                </span>
              </div>
              <input
                type="range"
                className="w-full accent-[#FF9F0A] bg-[#222] h-1 rounded-lg appearance-none cursor-pointer"
                min="0"
                max="100"
                value={
                  config.khmerStyle === "formal"
                    ? "10"
                    : config.khmerStyle === "literal"
                    ? "28"
                    : config.khmerStyle === "colloquial"
                    ? "48"
                    : config.khmerStyle === "concise"
                    ? "68"
                    : config.khmerStyle === "voiceover"
                    ? "85"
                    : "100"
                }
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10);
                  if (val < 18) {
                    setConfig(prev => ({ ...prev, khmerStyle: "formal" }));
                  } else if (val < 38) {
                    setConfig(prev => ({ ...prev, khmerStyle: "literal" }));
                  } else if (val < 58) {
                    setConfig(prev => ({ ...prev, khmerStyle: "colloquial" }));
                  } else if (val < 76) {
                    setConfig(prev => ({ ...prev, khmerStyle: "concise" }));
                  } else if (val < 92) {
                    setConfig(prev => ({ ...prev, khmerStyle: "voiceover" }));
                  } else {
                    setConfig(prev => ({ ...prev, khmerStyle: "funny" }));
                  }
                }}
                disabled={isTranslating}
              />
              <div className="flex justify-between mt-1 text-[9px] font-mono text-[#555]">
                <span>FORMAL</span>
                <span>CONCISE</span>
                <span>VOICE</span>
                <span>COMIC</span>
              </div>
            </div>

            {/* Batch translation slider */}
            <div>
              <div className="flex justify-between items-center text-[10px] uppercase tracking-widest text-[#888] mb-2">
                <span>Batch Segment size</span>
                <span className="text-[#FF9F0A] font-mono">{config.batchSize} blocks</span>
              </div>
              <input
                type="range"
                min="5"
                max="60"
                step="5"
                value={config.batchSize}
                onChange={(e) =>
                  setConfig((prev) => ({ ...prev, batchSize: parseInt(e.target.value, 10) }))
                }
                disabled={isTranslating}
                className="w-full accent-[#FF9F0A] bg-[#222] h-1 rounded-lg appearance-none cursor-pointer"
              />
            </div>

            {/* Chinese Abbreviation, Name Transliteration & Complete Word Coverage Engine Status */}
            <div className="p-3 bg-[#131313] border border-[#222] rounded-lg space-y-1.5">
              <div className="flex items-center space-x-2 text-[#FF9F0A] font-medium text-[11px]">
                <Sparkles className="w-3.5 h-3.5 text-[#FF9F0A] shrink-0" />
                <span>Name & Omission Protection: ACTIVE</span>
              </div>
              <p className="text-[10px] text-[#888] leading-relaxed">
                • Proper names (humans, animals/pets like 大黄/旺财, objects, places, weapons) are phoneticized into Khmer script sound — never literally translated.
              </p>
              <p className="text-[10px] text-[#888] leading-relaxed">
                • Full-sentence zero omission: preserves all sub-clauses, exclamations, adverbs, and split dialogue blocks.
              </p>
            </div>

            {/* Chinese Kinship Term Accuracy Reference */}
            <div className="p-3 bg-[#131313] border border-[#222] rounded-lg space-y-2">
              <div className="flex items-center justify-between text-[#38BDF8] font-medium text-[11px]">
                <div className="flex items-center space-x-2">
                  <Sparkles className="w-3.5 h-3.5 text-[#38BDF8] shrink-0" />
                  <span>Kinship Accuracy: Husband vs In-Laws</span>
                </div>
                <span className="text-emerald-400 font-mono text-[9px] font-semibold">STRICT</span>
              </div>
              <p className="text-[10px] text-[#888] leading-relaxed">
                Clear separation between a woman's own husband and in-law relations:
              </p>
              <div className="grid grid-cols-2 gap-1.5 text-[10px]">
                <div className="p-2 bg-[#181818] rounded border border-[#282828] space-y-1">
                  <div className="font-semibold text-emerald-300 text-[10px]">Husband (ស្វាមី / ប្ដី)</div>
                  <div className="text-[#AAA] text-[9px]">• 丈夫 (Formal) → ស្វាមី / ប្ដី</div>
                  <div className="text-[#AAA] text-[9px]">• 老公 (Casual) → ប្ដី / ប្ដីសម្លាញ់</div>
                  <div className="text-[#AAA] text-[9px]">• 哥哥 (Romantic) → បង / បងសម្លាញ់</div>
                </div>
                <div className="p-2 bg-[#181818] rounded border border-[#282828] space-y-1">
                  <div className="font-semibold text-amber-300 text-[10px]">In-Laws (បងថ្លៃ / ប្អូនថ្លៃ)</div>
                  <div className="text-[#AAA] text-[9px]">• 姐夫 (Sister's Husb.) → បងថ្លៃ</div>
                  <div className="text-[#AAA] text-[9px]">• 妹夫 (Sister's Husb.) → ប្អូនថ្លៃ</div>
                  <div className="text-[#AAA] text-[9px]">• 大舅子/小叔子 → បងថ្លៃ/ប្អូនថ្លៃ</div>
                </div>
              </div>
            </div>

            {/* Special Terminology & Fauna Accuracy Reference */}
            <div className="p-3 bg-[#131313] border border-[#222] rounded-lg space-y-1.5">
              <div className="flex items-center justify-between text-[#A78BFA] font-medium text-[11px]">
                <div className="flex items-center space-x-2">
                  <Sparkles className="w-3.5 h-3.5 text-[#A78BFA] shrink-0" />
                  <span>Fauna Terminology: Crocodile (鳄鱼 / 鱷魚)</span>
                </div>
                <span className="text-emerald-400 font-mono text-[9px] font-semibold">ក្រពេី</span>
              </div>
              <p className="text-[10px] text-[#888] leading-relaxed">
                • <strong>Crocodile / 鳄鱼 / 鱷魚</strong> strictly translates to <strong>ក្រពេី</strong> (e.g., 鳄鱼皮 → ស្បែកក្រពេី, 鳄鱼潭 → បឹងក្រពេី). Prevents literal fish calques (ត្រីក្រពើ) and foreign leaks.
              </p>
            </div>

            {/* Translation Engine & Unlimited Quota Mode */}
            <div className="space-y-2 pt-2">
              <div className="flex justify-between items-center text-[10px] uppercase tracking-widest text-[#888]">
                <span>Engine & Quota Mode</span>
                <span className={`font-mono text-[9px] font-semibold ${
                  config.engineMode === "unlimited_free"
                    ? "text-[#FF9F0A]"
                    : "text-emerald-400"
                }`}>
                  {config.engineMode === "unlimited_free" ? "Unlimited ♾️" : "Active ⚡"}
                </span>
              </div>

              {/* Mode Switch Tabs */}
              <div className="grid grid-cols-3 gap-1 bg-[#131313] p-1 rounded-lg border border-[#222]">
                {[
                  { mode: "auto_hybrid", label: "Auto-Hybrid ⚡", tooltip: "Gemini AI + Free Unlimited Failover" },
                  { mode: "unlimited_free", label: "Free Unlimited 🌐", tooltip: "100% Free, Zero Quota Limit" },
                  { mode: "gemini_only", label: "Gemini Only 🧠", tooltip: "Pure Gemini AI Model" },
                ].map((item) => (
                  <button
                    key={item.mode}
                    type="button"
                    onClick={() => setConfig((prev) => ({ ...prev, engineMode: item.mode as any }))}
                    disabled={isTranslating}
                    title={item.tooltip}
                    className={`py-1 text-[9px] font-medium rounded transition-all text-center ${
                      (config.engineMode || "auto_hybrid") === item.mode
                        ? item.mode === "unlimited_free"
                          ? "bg-[#FF9F0A] text-black font-bold shadow-sm"
                          : "bg-[#2A2A2A] text-emerald-300 font-semibold shadow-sm"
                        : "text-[#777] hover:text-[#CCC]"
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              {config.engineMode === "unlimited_free" ? (
                <div className="p-2.5 bg-amber-500/10 border border-amber-500/25 rounded-lg space-y-1">
                  <div className="flex items-center gap-1.5 text-[#FF9F0A] font-bold text-[10px]">
                    <Sparkles className="w-3 h-3" />
                    <span>Free Unlimited Engine Active</span>
                  </div>
                  <p className="text-[9px] text-amber-200/80 leading-relaxed">
                    Zero quota restrictions, no daily 500-request limits, and no API keys required. Translates unlimited subtitles continuously with full Khmer dubbing rules applied.
                  </p>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <select
                    value={config.model || "gemini-3.1-flash-lite"}
                    onChange={(e) => setConfig((prev) => ({ ...prev, model: e.target.value }))}
                    disabled={isTranslating}
                    className="w-full bg-[#131313] border border-[#222] rounded-lg px-2.5 py-1.5 text-xs text-[#EBEBEB] focus:border-[#FF9F0A] focus:outline-none transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <option value="gemini-3.1-flash-lite">Gemini 3.1 Flash Lite (⚡ High Quota / Recommended)</option>
                    <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
                    <option value="gemini-3.8-flash">Gemini 3.8 Flash</option>
                    <option value="gemini-flash-latest">Gemini Flash Latest</option>
                  </select>
                  <p className="text-[8px] text-[#555] font-mono leading-normal">
                    {config.engineMode === "gemini_only"
                      ? "💡 Strict Gemini AI mode with multi-key pool rotation."
                      : "💡 Auto-Failover: Translates with Gemini AI; if quota or rate limit hits, seamlessly finishes batch with Free Unlimited Engine."}
                  </p>
                </div>
              )}
            </div>

            {/* Translation Speed / Rate-Limit Prevention Controls */}
            <div className="space-y-2.5 pt-4 border-t border-[#1F1F1F]">
              <div className="flex justify-between items-center">
                <label className="block text-[10px] uppercase tracking-widest text-[#888]">Speed & Refresh Controls</label>
                <span className="text-[9px] text-[#FF9F0A] font-mono font-semibold">
                  {config.delayMode === "fast" ? "Turbo Fast (200ms)" : config.delayMode === "auto" ? "Quick Auto (~0.8s)" : "Custom"}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-1 bg-[#131313] p-1 rounded-lg border border-[#222]">
                {[
                  { mode: "fast", label: "Fast (200ms) ⚡" },
                  { mode: "auto", label: "Auto (~0.8s)" },
                  { mode: "custom", label: "Custom" },
                ].map((item) => (
                  <button
                    key={item.mode}
                    type="button"
                    onClick={() => setConfig((prev) => ({ ...prev, delayMode: item.mode as any }))}
                    className={`py-1 text-[9px] font-medium rounded transition-all ${
                      config.delayMode === item.mode
                        ? "bg-[#FF9F0A] text-black shadow-sm font-semibold"
                        : "text-[#888] hover:text-[#EBEBEB]"
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              {config.delayMode === "auto" && (
                <div className="text-[9px] text-[#666] leading-normal font-mono bg-[#111] p-2 rounded border border-[#1a1a1a] space-y-1">
                  <div>
                    Calculated Delay:{" "}
                    <strong className="text-emerald-400">
                      {Math.max(0.4, Math.ceil(1500 / (apiKeys.filter((k) => k.trim() !== "").length || 1)) / 1000).toFixed(1)}s
                    </strong>
                  </div>
                  <div className="text-[8px] text-[#444] leading-relaxed">
                    Fast intelligent refreshing between batches with instant failover across active model and key pools.
                  </div>
                </div>
              )}

              {config.delayMode === "custom" && (
                <div className="space-y-2 bg-[#111] p-2 rounded border border-[#1a1a1a]">
                  <div className="flex justify-between text-[9px] text-[#888] font-mono">
                    <span>Wait delay:</span>
                    <span className="text-[#FF9F0A] font-semibold">{(config.customDelay || 1500) / 1000}s</span>
                  </div>
                  <input
                    type="range"
                    min="300"
                    max="5000"
                    step="200"
                    value={config.customDelay || 1500}
                    onChange={(e) =>
                      setConfig((prev) => ({ ...prev, customDelay: parseInt(e.target.value, 10) }))
                    }
                    className="w-full accent-[#FF9F0A] bg-[#222] h-1 rounded-lg appearance-none cursor-pointer"
                  />
                  <span className="block text-[8px] text-[#444] font-mono leading-tight">
                    Custom pause time between subtitle batches.
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Translation Loop Trigger button */}
          <div className="pt-4 border-t border-[#1F1F1F] mt-auto">
            {isTranslating ? (
              <button
                onClick={handlePauseTranslation}
                className="w-full py-3 bg-amber-500/10 hover:bg-amber-500/20 text-[#FF9F0A] border border-[#FF9F0A]/20 font-semibold rounded-lg text-xs transition-all flex items-center justify-center gap-2 animate-pulse"
              >
                <Pause className="h-4 w-4" />
                Pause Subtitle Translation
              </button>
            ) : (
              <button
                onClick={() => startTranslationLoop()}
                className="w-full py-3 bg-[#FF9F0A] text-black font-semibold rounded-lg text-xs hover:bg-[#e68e09] transition-all flex items-center justify-center gap-2"
              >
                <Play className="h-4 w-4 fill-black" />
                {stats.done > 0 || stats.failed > 0
                  ? `Resume Subtitles (${stats.percentage}%)`
                  : "Translate Subtitles Now"}
              </button>
            )}
          </div>
        </aside>

        {/* Right Side: Elegant translation feed workspace */}
        <section className="flex-1 flex flex-col bg-[#080808] overflow-hidden min-h-[450px]">
          
          {/* Active Video Player Studio Banner / Preview */}
          {videoUrl && (
            <div className="p-4 pb-0 bg-[#0D0D0D] border-b border-[#1F1F1F]">
              <VideoPlayerStudio
                videoFile={videoFile}
                videoUrl={videoUrl}
                blocks={blocks}
                onBlocksChange={(updated) => setBlocks(updated)}
                extractedTracks={extractedTracks}
                onSelectTrack={handleSelectExtractedTrack}
                onTranscribeVideo={handleTranscribeVideo}
                isTranscribing={isTranscribingVideo}
                transcribeProgress={transcribeProgress}
                onCloseVideo={handleCloseVideo}
                selectedBlockIndex={selectedBlockIndex}
                onSelectBlock={(idx) => setSelectedBlockIndex(idx)}
              />
            </div>
          )}

          {/* Video Notice Banner */}
          {videoNotice && (
            <div
              className={`px-4 py-2.5 text-xs flex items-center justify-between gap-3 border-b ${
                videoNotice.type === "success"
                  ? "bg-emerald-950/20 text-emerald-300 border-emerald-900/30"
                  : videoNotice.type === "error"
                  ? "bg-red-950/20 text-red-300 border-red-900/30"
                  : "bg-[#1A1A1A] text-[#FF9F0A] border-[#2A2A2A]"
              }`}
            >
              <div className="flex items-center gap-2">
                <Film className="h-4 w-4 shrink-0 text-[#FF9F0A]" />
                <span>{videoNotice.message}</span>
              </div>
              <button
                onClick={() => setVideoNotice(null)}
                className="text-[#71717A] hover:text-[#EBEBEB] p-1 rounded"
              >
                ✕
              </button>
            </div>
          )}

          {/* Welcome view when empty (and no video loaded) */}
          {blocks.length === 0 && !videoUrl ? (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center gap-6">
              <div className="w-12 h-12 rounded bg-[#131313] border border-[#222] flex items-center justify-center text-[#FF9F0A]">
                <Tv className="h-6 w-6" />
              </div>
              <div className="max-w-md flex flex-col gap-2">
                <h3 className="text-sm font-semibold tracking-wider text-[#EBEBEB] uppercase">No Subtitles Loaded</h3>
                <p className="text-xs text-[#555] leading-relaxed">
                  Upload a video file (.MKV, .MP4, .WEBM) with embedded subtitles, drop a subtitle file (.SRT, .VTT, .ASS), or select a preset scenario.
                </p>
              </div>
              <div className="flex flex-wrap gap-2 justify-center">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="px-4 py-2 text-xs font-semibold bg-[#FF9F0A] text-black hover:bg-[#e68e09] transition-colors rounded-md flex items-center gap-1.5"
                >
                  <FileUp className="h-3.5 w-3.5" />
                  Upload Subtitle / Video
                </button>
                <button
                  onClick={() => handleLoadExample("colloquial-drama")}
                  className="px-4 py-2 text-xs font-semibold bg-[#131313] border border-[#222] text-[#FF9F0A] hover:bg-[#1A1A1A] transition-colors rounded-md"
                >
                  Load Sample Scenario
                </button>
              </div>
            </div>
          ) : (
            // Subtitles display console
            <div className="flex-1 flex flex-col overflow-hidden">
              
              {/* SAMI Multi-Language Track Switcher Banner */}
              {samiLanguageTracks.length > 1 && (
                <div className="bg-[#111] border-b border-[#2A2A2A] px-4 py-2.5 flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2">
                    <Globe className="h-4 w-4 text-[#FF9F0A]" />
                    <span className="text-xs font-semibold text-[#EBEBEB]">
                      Multi-Language Subtitle Tracks:
                    </span>
                    <span className="text-[10px] text-[#777] font-mono hidden sm:inline">
                      (Choose 1 language track to isolate only those cues)
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {samiLanguageTracks.map((track) => (
                      <button
                        key={track.id}
                        onClick={() => handleSelectSAMITrack(track.id)}
                        disabled={isTranslating}
                        className={`px-2.5 py-1 text-xs rounded-md font-medium border transition-all flex items-center gap-1.5 disabled:opacity-50 ${
                          selectedLanguageTrack === track.id
                            ? "bg-[#FF9F0A] text-black border-[#FF9F0A] font-semibold shadow-sm"
                            : "bg-[#181818] text-[#CCC] border-[#2E2E2E] hover:text-[#FFF] hover:border-[#444] hover:bg-[#202020]"
                        }`}
                      >
                        <span>{track.label}</span>
                        {track.cueCount !== undefined && (
                          <span
                            className={`text-[9px] font-mono px-1.5 py-0.2 rounded ${
                              selectedLanguageTrack === track.id ? "bg-black/25 text-black font-bold" : "bg-[#000]/50 text-[#888]"
                            }`}
                          >
                            {track.cueCount.toLocaleString()}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Progress and status header bar */}
              <div className="p-4 border-b border-[#1F1F1F] bg-[#0D0D0D] flex flex-col xl:flex-row xl:items-center justify-between gap-3 shrink-0">
                
                {/* Search query input & Script filter */}
                <div className="flex items-center gap-2 flex-wrap flex-1">
                  <div className="relative w-full sm:w-56">
                    <span className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-[#555]">
                      <Search className="h-3.5 w-3.5" />
                    </span>
                    <input
                      type="text"
                      placeholder="Search dialogue words..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-full pl-9 pr-3 py-1.5 bg-[#131313] text-xs rounded-md border border-[#222] focus:outline-none focus:border-[#444] text-[#EBEBEB] placeholder-[#555] transition-colors"
                    />
                  </div>

                  {/* Language Script filter buttons */}
                  <div className="flex items-center gap-1 bg-[#131313] p-1 rounded-md border border-[#222]">
                    {[
                      { id: "all", label: "All Scripts" },
                      { id: "zh", label: "🇨🇳 Chinese" },
                      { id: "ko", label: "🇰🇷 Korean" },
                      { id: "en", label: "🇺🇸 English" },
                      { id: "ja", label: "🇯🇵 Japanese" }
                    ].map((tab) => (
                      <button
                        key={tab.id}
                        onClick={() => setScriptFilter(tab.id as any)}
                        className={`px-2 py-1 text-[10px] font-medium rounded transition-all ${
                          scriptFilter === tab.id
                            ? "bg-[#2A2A2A] text-[#FF9F0A] font-semibold"
                            : "text-[#666] hover:text-[#EBEBEB]"
                        }`}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>

                  {/* Action to isolate and keep only current filtered script */}
                  {scriptFilter !== "all" && !isTranslating && (
                    <button
                      onClick={() => handleKeepOnlyScript(scriptFilter as any)}
                      className="px-2.5 py-1 text-[10px] font-semibold bg-emerald-950/40 text-emerald-300 border border-emerald-800/50 hover:bg-emerald-900/50 rounded-md transition-colors flex items-center gap-1"
                      title="Purge all other language lines and keep only this script as the clean translation dataset"
                    >
                      <Filter className="h-3 w-3 text-emerald-400" />
                      Keep Only {scriptFilter.toUpperCase()} ({filteredBlocks.length})
                    </button>
                  )}
                </div>

                {/* Left/Right Filter tabs */}
                <div className="flex items-center gap-2.5">
                  <div className="flex items-center gap-1 bg-[#131313] p-1 rounded-md border border-[#222]">
                    {[
                      { id: "all", label: "All" },
                      { id: "pending", label: "Pending" },
                      { id: "translating", label: "Translating" },
                      { id: "done", label: "Done" },
                      { id: "failed", label: "Failed" },
                      { id: "warnings", label: `⚠️ Notes (${warningsCount})` }
                    ].map((tab) => (
                      <button
                        key={tab.id}
                        onClick={() => setStatusFilter(tab.id)}
                        className={`px-2.5 py-1 text-[10px] font-medium rounded transition-all ${
                          statusFilter === tab.id
                            ? "bg-[#222] text-[#FF9F0A]"
                            : "text-[#555] hover:text-[#EBEBEB]"
                        }`}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Progress Bar Loader (Aesthetic Line) */}
              {isTranslating && (
                <div className="w-full bg-[#131313] h-[2px] overflow-hidden relative">
                  <div className="bg-[#FF9F0A] h-full absolute top-0 left-0 animate-[shimmer_1.5s_infinite] w-2/5" style={{
                    backgroundImage: "linear-gradient(90deg, transparent, rgba(255,159,10,0.5), transparent)"
                  }}></div>
                </div>
              )}

              {/* Translation Progress statistics bar */}
              <div className="bg-[#0D0D0D]/60 border-b border-[#1F1F1F] px-6 py-2.5 flex justify-between items-center text-[10px] font-mono text-[#555] shrink-0">
                <div className="flex items-center gap-4 flex-wrap">
                  <span className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#FF9F0A]"></span>
                    TOTAL: {stats.total} LINES
                  </span>
                  <span>PROGRESS: {stats.done} / {stats.total} ({stats.percentage}%)</span>
                  
                  {quickFixableNoticesCount > 0 && !isTranslating && (
                    <button
                      id="quick-fix-all-notices-btn"
                      onClick={handleInstantFixAllNotices}
                      className="ml-2 flex items-center gap-1.5 px-2.5 py-1 text-[9px] font-sans font-bold rounded-md border bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 border-emerald-500/30 transition-all cursor-pointer animate-pulse shadow-sm"
                      title="Instantly fix and convert detected foreign scripts (Myanmar, Arabic), orphan marks, typos, and kinship mismatches across all lines without re-translating"
                    >
                      <Sparkles className="h-2.5 w-2.5 text-emerald-400" />
                      <span>Instant Solve {quickFixableNoticesCount} Notes</span>
                    </button>
                  )}

                  {warningsCount > 0 && !isTranslating && (
                    <button
                      onClick={handleReTranslateWarnings}
                      className="ml-2 flex items-center gap-1.5 px-2.5 py-1 text-[9px] font-sans font-semibold bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 border border-amber-500/25 rounded-md transition-colors animate-pulse"
                      title="Automatically clear and re-translate lines containing untranslated Chinese or invalid scripts using optimized prompt rules."
                    >
                      <RefreshCw className="h-2.5 w-2.5 animate-spin" style={{ animationDuration: '3s' }} />
                      Auto-Repair {warningsCount} Lines with Notices
                    </button>
                  )}

                  {stats.done > 0 && !isTranslating && (
                    <button
                      onClick={() => setShowCondenseModal(true)}
                      disabled={isCondensing}
                      className={`ml-2 flex items-center gap-1.5 px-2.5 py-1 text-[9px] font-sans font-semibold rounded-md border transition-all ${
                        overrunBlocks.length > 0
                          ? "bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 border-amber-500/30 animate-pulse"
                          : "bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 border-emerald-500/25"
                      }`}
                      title="Smart-shorten long Khmer sentences so they fit voiceover/TTS timing without losing meaning"
                    >
                      {isCondensing ? (
                        <Loader2 className="h-2.5 w-2.5 animate-spin text-amber-400" />
                      ) : (
                        <Scissors className="h-2.5 w-2.5" />
                      )}
                      <span>
                        {isCondensing 
                          ? `Shortening (${condensingProgress.current}/${condensingProgress.total})...`
                          : overrunBlocks.length > 0 
                          ? `Auto-Shorten for Voice (${overrunBlocks.length} Overruns)`
                          : `Auto-Shorten for Voice`}
                      </span>
                    </button>
                  )}

                  {ellipsisLinesCount > 0 && !isTranslating && (
                    <button
                      id="remove-all-ellipses-btn"
                      onClick={handleRemoveAllEllipses}
                      className="ml-2 flex items-center gap-1.5 px-2.5 py-1 text-[9px] font-sans font-semibold rounded-md border bg-red-500/10 text-red-400 hover:bg-red-500/20 border-red-500/25 transition-all cursor-pointer"
                      title="Remove '...' (ellipsis sign) from all translated sentences in one click"
                    >
                      <Scissors className="h-2.5 w-2.5" />
                      <span>Remove (...) Ellipsis ({ellipsisLinesCount})</span>
                    </button>
                  )}

                  {kinshipMismatchCount > 0 && !isTranslating && (
                    <button
                      id="fix-all-kinship-btn"
                      onClick={handleFixAllKinship}
                      className="ml-2 flex items-center gap-1.5 px-2.5 py-1 text-[9px] font-sans font-semibold rounded-md border bg-sky-500/10 text-sky-400 hover:bg-sky-500/20 border-sky-500/25 transition-all cursor-pointer"
                      title="Fix husband vs brother-in-law kinship mismatches across all lines in one click"
                    >
                      <Sparkles className="h-2.5 w-2.5" />
                      <span>Fix Kinship ({kinshipMismatchCount})</span>
                    </button>
                  )}

                  {foreignScriptMismatchCount > 0 && !isTranslating && (
                    <button
                      id="clean-all-foreign-btn"
                      onClick={handleCleanAllForeignScripts}
                      className="ml-2 flex items-center gap-1.5 px-2.5 py-1 text-[9px] font-sans font-semibold rounded-md border bg-purple-500/15 text-purple-300 hover:bg-purple-500/25 border-purple-500/30 transition-all cursor-pointer animate-pulse"
                      title="Purge all Myanmar (ခរុ), Arabic (ـینگ), Thai, Lao, and foreign characters and restore clean Khmer words in one click"
                    >
                      <Sparkles className="h-2.5 w-2.5" />
                      <span>Purge Foreign & Myanmar Scripts ({foreignScriptMismatchCount})</span>
                    </button>
                  )}
                </div>
                <div className="text-[10px] text-[#555] tracking-wider uppercase flex items-center gap-1.5 truncate max-w-[200px] md:max-w-xs" title={uploadedFileName}>
                  {uploadedFileName ? (
                    <>
                      <FileUp className="h-3 w-3 text-emerald-400" />
                      <span className="text-[#888] font-semibold truncate">{uploadedFileName}</span>
                    </>
                  ) : (
                    "AUTO-PARITY ACTIVE"
                  )}
                </div>
              </div>

              {/* Errors container if any */}
              {errorMessage && (
                isQuotaExceededError ? (
                  <div className="p-5 bg-gradient-to-r from-amber-950/30 to-[#1A1508] border-b border-amber-500/30 text-xs text-amber-200 flex items-start gap-3.5">
                    <div className="p-2 bg-[#FF9F0A]/15 rounded-xl text-[#FF9F0A] shrink-0 mt-0.5 border border-[#FF9F0A]/20">
                      <Sparkles className="h-5 w-5 animate-pulse text-[#FF9F0A]" />
                    </div>
                    <div className="flex-1 space-y-3">
                      <div className="flex items-center justify-between flex-wrap gap-2">
                        <div>
                          <p className="font-bold text-amber-100 text-sm tracking-wide flex items-center gap-2">
                            <span>Gemini Free-Tier Daily Quota Limit Reached (500 Requests)</span>
                          </p>
                          <p className="text-[11px] text-amber-300/80 mt-0.5">
                            Google AI Studio's shared free quota limit resets every 24 hours at 00:00 UTC. To resume translating immediately with 0 waiting, you can paste your free Gemini API key below:
                          </p>
                        </div>
                        <span className="text-[10px] font-mono text-amber-400 bg-amber-950/60 border border-amber-500/30 px-2.5 py-0.5 rounded-full">
                          Daily 500 Limit Reached
                        </span>
                      </div>

                      {/* Direct Inline Key Input for Instant 1-Click Recovery */}
                      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 p-2 bg-[#0D0D0D]/90 rounded-xl border border-amber-500/25">
                        <div className="flex-1 flex items-center gap-2 px-2.5 py-1.5 bg-[#141414] rounded-lg border border-[#262626]">
                          <Key className="w-3.5 h-3.5 text-[#FF9F0A] shrink-0" />
                          <input
                            type="password"
                            placeholder="Paste your Gemini API Key (starts with AIzaSy...)"
                            value={bannerApiKeyInput}
                            onChange={(e) => setBannerApiKeyInput(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && bannerApiKeyInput.trim()) {
                                handleUpdateKeyAtSlot(0, bannerApiKeyInput.trim());
                                setErrorMessage("");
                                setVideoNotice({
                                  type: "success",
                                  message: "✨ API Key saved! Resuming subtitle translation..."
                                });
                                setTimeout(() => startTranslationLoop(), 150);
                              }
                            }}
                            className="flex-1 bg-transparent text-xs text-white placeholder-[#555] font-mono focus:outline-none"
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            if (bannerApiKeyInput.trim()) {
                              handleUpdateKeyAtSlot(0, bannerApiKeyInput.trim());
                              setErrorMessage("");
                              setVideoNotice({
                                type: "success",
                                message: "✨ API Key saved! Resuming subtitle translation..."
                              });
                              setTimeout(() => startTranslationLoop(), 150);
                            } else {
                              setVideoNotice({
                                type: "error",
                                message: "Please enter or paste your Gemini API key first."
                              });
                            }
                          }}
                          className="px-4 py-2 bg-emerald-500 hover:bg-emerald-400 text-black font-bold text-xs rounded-lg transition-all shadow-md active:scale-95 cursor-pointer flex items-center justify-center gap-1.5 shrink-0"
                        >
                          <Check className="w-3.5 h-3.5 stroke-[3]" />
                          <span>Save Key & Resume</span>
                        </button>
                      </div>
                      
                      <div className="flex flex-wrap gap-2.5 items-center pt-0.5">
                        {/* Primary Instant 1-Click Action: Switch to Free Unlimited Engine */}
                        <button
                          type="button"
                          onClick={() => {
                            setConfig((prev) => ({ ...prev, engineMode: "unlimited_free" }));
                            setErrorMessage("");
                            setSlotStatuses({});
                            setVideoNotice({
                              type: "success",
                              message: "🚀 Switched to Free Unlimited Engine! Resuming subtitle translation with 0 quota limits..."
                            });
                            setTimeout(() => {
                              startTranslationLoop();
                            }, 100);
                          }}
                          className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-[#FF9F0A] hover:bg-[#e68e09] text-black font-bold text-xs rounded-lg transition-all shadow-md active:scale-95 cursor-pointer"
                        >
                          <Sparkles className="h-3.5 w-3.5 fill-black" />
                          <span>Switch to Free Unlimited Engine (Translate Now Without Limits)</span>
                        </button>

                        <a
                          href="https://aistudio.google.com/app/apikey"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#1C1C1C] hover:bg-[#252525] text-amber-300 font-medium text-[11px] rounded-lg transition-all border border-amber-500/20"
                        >
                          <span>Get Free Gemini Key (Instant & 100% Free)</span>
                          <ArrowRight className="h-3 w-3" />
                        </a>

                        <button
                          type="button"
                          onClick={() => {
                            setErrorMessage("");
                            setSlotStatuses({});
                            setVideoNotice({
                              type: "info",
                              message: "Retrying translation with the built-in server engine..."
                            });
                            setTimeout(() => {
                              startTranslationLoop();
                            }, 100);
                          }}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#181818] hover:bg-[#222] text-[#AAA] hover:text-white font-medium text-[11px] rounded-lg transition-all border border-[#2E2E2E] cursor-pointer"
                        >
                          <Play className="h-3 w-3 fill-[#AAA]" />
                          Retry Built-in Key
                        </button>

                        <button
                          type="button"
                          onClick={() => setErrorMessage("")}
                          className="text-[11px] text-[#666] hover:text-[#999] px-2 py-1 transition-colors ml-auto cursor-pointer"
                        >
                          Dismiss
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="p-4 bg-red-950/10 border-b border-red-900/20 text-xs text-red-400 flex items-start gap-2.5">
                    <AlertCircle className="h-4.5 w-4.5 text-red-500 shrink-0 mt-0.5" />
                    <div className="flex-1">
                      <p className="font-semibold text-red-200">
                        {isKeyMissing ? "GEMINI_API_KEY Missing" : "Translation Interrupted"}
                      </p>
                      <p className="text-[11px] text-red-400/90 leading-relaxed">{errorMessage}</p>
                      {isKeyMissing ? (
                        <p className="text-[10px] text-slate-500 mt-2 leading-normal">
                          To resolve this, you can paste your <strong className="text-[#FF9F0A]">GEMINI_API_KEY</strong> directly into the <strong className="text-slate-300">Gemini API Key input field in the left sidebar</strong>, or configure it globally in the top-right <strong className="text-slate-300">Settings &gt; Secrets</strong> panel of Google AI Studio.
                        </p>
                      ) : (
                        <div className="mt-2.5 flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setErrorMessage("");
                              startTranslationLoop();
                            }}
                            className="inline-flex items-center gap-1.5 px-3 py-1 bg-[#FF9F0A] hover:bg-[#e68e09] text-black font-semibold text-[11px] rounded-md transition-all shadow active:scale-95 cursor-pointer"
                          >
                            <Play className="h-3 w-3 fill-black" />
                            Resume Subtitles
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )
              )}

              {/* Grid Column Headers */}
              <div className="grid grid-cols-1 md:grid-cols-2 border-b border-[#1F1F1F] bg-[#0D0D0D] shrink-0">
                <div className="p-4 text-[10px] uppercase tracking-widest text-[#555] font-semibold md:border-r border-[#1F1F1F]">Source Chinese (Simplified)</div>
                <div className="p-4 text-[10px] uppercase tracking-widest text-[#FF9F0A] font-semibold">Khmer Target Subtitle</div>
              </div>

              {/* Dynamic Feed list */}
              <div className="flex-1 overflow-y-auto divide-y divide-[#1F1F1F]">
                {displayedBlocks.length === 0 ? (
                  <div className="p-12 text-center text-xs text-[#555]">
                    No subtitle segments found matching search criteria.
                  </div>
                ) : (
                  displayedBlocks.map((block) => {
                    const isEditing = editingIndex === block.index;
                    
                    return (
                      <div
                        key={block.index}
                        onClick={() => setSelectedBlockIndex(block.index)}
                        className={`grid grid-cols-1 md:grid-cols-2 min-h-[140px] transition-all duration-200 cursor-pointer ${
                          selectedBlockIndex === block.index
                            ? "bg-[#FF9F0A]/10 ring-1 ring-[#FF9F0A]/40"
                            : block.status === "translating"
                            ? "bg-[#1A1A1A]/20"
                            : block.status === "failed"
                            ? "bg-red-950/5"
                            : "bg-[#0D0D0D] hover:bg-[#121214]"
                        }`}
                      >
                        {/* Chinese Original Column */}
                        <div className="p-6 md:border-r border-[#1F1F1F] flex flex-col justify-between space-y-3 opacity-80 hover:opacity-100 transition-opacity">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-[11px] text-[#FF9F0A] font-bold">
                              #{block.index}
                            </span>
                            <span className="font-mono text-[11px] text-[#888]">
                              {block.timecode}
                            </span>
                            <span className="px-1.5 py-0.5 rounded bg-[#1A1A1A] text-[9px] text-[#AAA] font-mono" title="Time slot duration">
                              {(parseTimecodeToSeconds(block.timecode)).toFixed(1)}s
                            </span>
                            {videoUrl && (
                              <span
                                className="px-1.5 py-0.5 rounded bg-[#FF9F0A]/10 hover:bg-[#FF9F0A]/20 text-[#FF9F0A] text-[9px] font-medium flex items-center gap-0.5 transition"
                                title="Click to jump video to this cue"
                              >
                                <Play className="h-2 w-2 fill-current" />
                                Jump Video
                              </span>
                            )}
                          </div>
                          <p className="text-xl font-light leading-relaxed text-[#EBEBEB]">
                            {block.text}
                          </p>
                          <div className="text-[9px] uppercase tracking-widest text-[#555] font-semibold">
                            ORIGINAL CHINESE
                          </div>
                        </div>

                        {/* Khmer Translation Column */}
                        <div className={`p-6 flex flex-col justify-between space-y-3 relative transition-all ${
                          block.status === "translating"
                            ? "border-l-2 border-[#FF9F0A] bg-[#111]"
                            : block.status === "done"
                            ? "border-l-2 border-[#FF9F0A] bg-[#111]"
                            : "border-l-2 border-transparent"
                        }`}>
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-mono text-[11px] text-[#FF9F0A]">
                                {block.timecode}
                              </span>
                              {(() => {
                                const blockDuration = parseTimecodeToSeconds(block.timecode);
                                const khmerCharCount = block.translatedText ? block.translatedText.replace(/\s+/g, "").length : 0;
                                const cps = blockDuration > 0 ? khmerCharCount / blockDuration : 0;
                                
                                if (!block.translatedText || blockDuration <= 0) return null;
                                
                                if (cps > 18) {
                                  return (
                                    <div className="flex items-center gap-1.5 flex-wrap">
                                      <span className="px-1.5 py-0.5 rounded bg-red-950/40 text-red-400 text-[9px] font-mono border border-red-900/50 flex items-center gap-1" title="Khmer text is too long! Balabolka might overflow or speak too fast.">
                                        <AlertCircle className="w-2.5 h-2.5 text-red-400 animate-pulse" />
                                        <span>Overrun Hazard ({cps.toFixed(1)} cps)</span>
                                      </span>
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleCondenseSingle(block.index);
                                        }}
                                        disabled={isTranslating || isCondensing || condensingIndex === block.index}
                                        className="px-1.5 py-0.5 bg-[#FF9F0A] hover:bg-amber-400 disabled:opacity-40 text-black rounded text-[9px] font-bold flex items-center gap-1 transition-all cursor-pointer active:scale-95 shadow-sm"
                                        title="Auto-shorten this sentence to fit audio duration without losing meaning"
                                      >
                                        {condensingIndex === block.index ? (
                                          <Loader2 className="w-2.5 h-2.5 animate-spin" />
                                        ) : (
                                          <Scissors className="w-2.5 h-2.5" />
                                        )}
                                        <span>Auto-Shorten</span>
                                      </button>
                                    </div>
                                  );
                                } else if (cps > 13) {
                                  return (
                                    <div className="flex items-center gap-1.5 flex-wrap">
                                      <span className="px-1.5 py-0.5 rounded bg-amber-950/40 text-amber-400 text-[9px] font-mono border border-amber-900/50" title="Swift reading pace. Balabolka TTS will speak at a quick tempo.">
                                        Swift Pace ({cps.toFixed(1)} cps)
                                      </span>
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleCondenseSingle(block.index);
                                        }}
                                        disabled={isTranslating || isCondensing || condensingIndex === block.index}
                                        className="px-1.5 py-0.5 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 disabled:opacity-40 rounded text-[9px] font-medium flex items-center gap-1 transition-all cursor-pointer active:scale-95"
                                        title="Shorten sentence for more relaxed reading tempo"
                                      >
                                        {condensingIndex === block.index ? (
                                          <Loader2 className="w-2.5 h-2.5 animate-spin" />
                                        ) : (
                                          <Scissors className="w-2.5 h-2.5" />
                                        )}
                                        <span>Shorten</span>
                                      </button>
                                    </div>
                                  );
                                } else {
                                  return (
                                    <span className="px-1.5 py-0.5 rounded bg-emerald-950/40 text-emerald-400 text-[9px] font-mono border border-emerald-900/50" title="Perfect speed fit for Balabolka TTS audio synthesis!">
                                      Optimal Pace ({cps.toFixed(1)} cps)
                                    </span>
                                  );
                                }
                              })()}
                            </div>
                            
                            <div className="flex items-center gap-2">
                              {/* Individual single translator status badge */}
                              {block.status === "translating" && (
                                <Loader2 className="h-3 w-3 text-[#FF9F0A] animate-spin" />
                              )}
                              {block.status === "failed" && (
                                <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-ping" />
                              )}
                              
                              {!isEditing && (
                                <div className="flex items-center gap-1">
                                  <button
                                    onClick={() => handleCondenseSingle(block.index)}
                                    disabled={isTranslating || isCondensing || condensingIndex === block.index}
                                    title="🎙️ Smart Shorten for Voiceover (បង្រួមពាក្យខ្លីសមស្របសំឡេង)"
                                    className={`p-1 rounded transition-all disabled:opacity-30 ${
                                      condensingIndex === block.index ? "text-emerald-400 bg-[#1A1A1A]" : "text-[#555] hover:text-emerald-400 hover:bg-[#1A1A1A]"
                                    }`}
                                  >
                                    {condensingIndex === block.index ? (
                                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    ) : (
                                      <Scissors className="h-3.5 w-3.5" />
                                    )}
                                  </button>
                                  <button
                                    onClick={() => handleSingleTranslate(block.index)}
                                    disabled={isTranslating}
                                    title="Translate only this line"
                                    className="p-1 text-[#555] hover:text-[#FF9F0A] hover:bg-[#1A1A1A] rounded transition-all disabled:opacity-30"
                                  >
                                    <RefreshCw className="h-3.5 w-3.5" />
                                  </button>
                                  <button
                                    onClick={() => handleSingleTranslate(block.index, "funny")}
                                    disabled={isTranslating}
                                    title="Slangify / Make Funny! 🤪 (Translates line using comedic Khmer slang)"
                                    className="p-1 text-[#555] hover:text-pink-400 hover:bg-[#1A1A1A] rounded transition-all disabled:opacity-30 flex items-center justify-center"
                                  >
                                    <span className="text-xs select-none">🤪</span>
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>

                          {isEditing ? (
                            <div className="flex flex-col gap-2">
                              <textarea
                                value={editingText}
                                onChange={(e) => setEditingText(e.target.value)}
                                className="w-full p-3 bg-[#131313] text-sm text-[#EBEBEB] border border-[#222] focus:outline-none focus:border-[#444] rounded-lg font-sans resize-none h-20 leading-relaxed"
                                autoFocus
                                placeholder="Override Khmer translation..."
                              />
                              <div className="flex gap-2 justify-end">
                                <button
                                  onClick={() => setEditingIndex(null)}
                                  className="py-1 px-3 text-[10px] font-medium bg-[#131313] border border-[#222] hover:bg-[#1A1A1A] text-[#888] rounded"
                                >
                                  Cancel
                                </button>
                                <button
                                  onClick={() => handleSaveEdit(block.index)}
                                  className="py-1 px-3 text-[10px] font-medium bg-[#FF9F0A] text-black hover:bg-[#e68e09] rounded font-semibold"
                                >
                                  Save Draft
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div
                              onClick={() => handleStartEdit(block.index, block.translatedText)}
                              className="group/item cursor-pointer p-4 rounded bg-[#131313]/40 hover:bg-[#131313] border border-transparent hover:border-[#222] transition-all min-h-[50px] flex flex-col justify-center relative"
                            >
                              {block.translatedText ? (
                                <p className={`text-2xl font-serif leading-snug tracking-wide text-[#EBEBEB] font-medium break-words pr-6 ${block.status === "translating" ? "opacity-40 animate-pulse" : ""}`}>
                                  {block.translatedText}
                                </p>
                              ) : (
                                <span className="text-xs text-[#555] italic">
                                  {block.status === "translating"
                                    ? "Translating segment..."
                                    : "Click to write manual Khmer override..."}
                                </span>
                              )}
                              
                              {/* Edit hover sign */}
                              <span className="absolute right-3 top-3 opacity-0 group-hover/item:opacity-100 text-[9px] text-[#FF9F0A] font-medium transition-all flex items-center gap-1 bg-[#0D0D0D] px-2 py-0.5 rounded border border-[#1F1F1F]">
                                <Edit2 className="h-2 w-2" />
                                Edit Line
                              </span>
                            </div>
                          )}

                          {/* Block level single failures */}
                          {block.status === "failed" && block.error && (
                            <p className="text-[10px] text-red-400 bg-red-950/10 p-2 rounded border border-red-900/30">
                              {block.error}
                            </p>
                          )}

                          {/* Block-level translation issue notes */}
                          {(() => {
                            const issues = detectTranslationIssues(block.translatedText, block.text);
                            if (issues.length === 0) return null;
                            const suggestedFix = cleanForeignAndAnomalousScripts(block.translatedText, block.text);
                            const hasAutoFix = suggestedFix !== block.translatedText && suggestedFix.trim().length > 0;

                            return (
                              <div className="text-[10px] text-amber-300 bg-amber-950/20 p-2.5 rounded-lg border border-amber-500/30 flex flex-col gap-2 shadow-sm">
                                <div className="font-semibold flex items-center justify-between text-amber-200 flex-wrap gap-1.5">
                                  <div className="flex items-center gap-1.5">
                                    <AlertCircle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                                    <span className="font-bold text-amber-300">Translation Notice ({issues.length}):</span>
                                  </div>
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    {hasAutoFix && (
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setBlocks((prev) =>
                                            prev.map((b) =>
                                              b.index === block.index ? { ...b, translatedText: suggestedFix, status: "done" as const } : b
                                            )
                                          );
                                          setVideoNotice({
                                            type: "success",
                                            message: `✨ Solved line #${block.index} -> Pure Khmer: "${suggestedFix}"`
                                          });
                                        }}
                                        className="px-2.5 py-0.5 bg-emerald-500 hover:bg-emerald-400 text-black rounded text-[9px] font-bold flex items-center gap-1 transition-all cursor-pointer shadow-sm active:scale-95"
                                        title="Instantly solve this sentence: converts Myanmar/Arabic/foreign words, trims ellipses, fixes typos into pure Khmer"
                                      >
                                        <Sparkles className="h-2.5 w-2.5" />
                                        <span>Instant Solve</span>
                                      </button>
                                    )}
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleSingleTranslate(block.index);
                                      }}
                                      disabled={isTranslating || block.status === "translating"}
                                      className="px-2 py-0.5 bg-[#FF9F0A] hover:bg-amber-400 disabled:opacity-40 text-black rounded text-[9px] font-bold flex items-center gap-1 transition-all cursor-pointer active:scale-95 shadow-sm"
                                      title="Click to automatically re-translate and repair this single line using AI prompt rules."
                                    >
                                      <RefreshCw className="h-2.5 w-2.5 animate-spin" style={{ animationDuration: '4s' }} />
                                      <span>AI Solve</span>
                                    </button>
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleStartEdit(block.index, block.translatedText);
                                      }}
                                      className="px-2 py-0.5 bg-[#1F1F1F] hover:bg-[#2A2A2A] text-[#EBEBEB] hover:text-[#FF9F0A] border border-[#333] rounded text-[9px] font-semibold flex items-center gap-1 transition-all cursor-pointer"
                                      title="Open inline editor to tweak this sentence directly"
                                    >
                                      <Edit2 className="h-2.5 w-2.5 text-[#FF9F0A]" />
                                      <span>Edit</span>
                                    </button>
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setShowNotepad(true);
                                        handleLoadToNotepad("notices");
                                      }}
                                      className="px-1.5 py-0.5 bg-[#1F1F1F] hover:bg-[#2A2A2A] text-[#888] hover:text-[#EBEBEB] border border-[#333] rounded text-[9px] font-medium flex items-center gap-1 transition-all cursor-pointer"
                                      title="Open notice lines in Notepad scratchpad"
                                    >
                                      <FileText className="h-2.5 w-2.5" />
                                      <span>Notes</span>
                                    </button>
                                  </div>
                                </div>

                                {/* Instant Solution preview banner */}
                                {hasAutoFix && (
                                  <div className="bg-emerald-950/40 border border-emerald-500/30 rounded-md p-2 flex items-center justify-between gap-2.5">
                                    <div className="flex flex-col min-w-0 flex-1">
                                      <span className="text-[9px] font-bold uppercase tracking-wider text-emerald-400">Suggested Solution:</span>
                                      <span className="text-[12px] text-emerald-100 font-medium font-sans leading-relaxed truncate">{suggestedFix}</span>
                                    </div>
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setBlocks((prev) =>
                                          prev.map((b) =>
                                            b.index === block.index ? { ...b, translatedText: suggestedFix, status: "done" as const } : b
                                          )
                                        );
                                        setVideoNotice({
                                          type: "success",
                                          message: `✨ Solved line #${block.index}: "${suggestedFix}"`
                                        });
                                      }}
                                      className="shrink-0 px-2.5 py-1 bg-emerald-500 hover:bg-emerald-400 text-black text-[10px] font-bold rounded flex items-center gap-1 transition-all shadow-sm active:scale-95 cursor-pointer"
                                      title="Apply this exact suggestion directly to the subtitle"
                                    >
                                      <Check className="h-3 w-3 text-black" />
                                      <span>Apply Fix</span>
                                    </button>
                                  </div>
                                )}

                                <ul className="list-disc pl-4 space-y-0.5 text-amber-300/90 leading-tight">
                                  {issues.map((issue, idx) => (
                                    <li key={idx}>{issue}</li>
                                  ))}
                                </ul>
                              </div>
                            );
                          })()}

                          {/* Bottom Action bar for Khmer Target with prominent One-Click Shorten */}
                          <div className="flex items-center justify-between pt-1 border-t border-[#1C1C1C] flex-wrap gap-2">
                            <div className="flex items-center gap-2">
                              <span className="text-[9px] uppercase tracking-widest text-[#555] font-semibold">
                                KHMER TARGET
                              </span>
                              {block.translatedText && (
                                <span className="text-[9px] font-mono text-[#555]">
                                  {block.translatedText.replace(/\s+/g, "").length} chars
                                </span>
                              )}
                            </div>

                            {/* One-Click Action Buttons */}
                            {block.translatedText && !isEditing && (
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <button
                                  id={`shorten-line-${block.index}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleCondenseSingle(block.index);
                                  }}
                                  disabled={isTranslating || isCondensing || condensingIndex === block.index}
                                  className={`px-2 py-1 rounded text-[10px] font-semibold flex items-center gap-1.5 transition-all cursor-pointer shadow-sm active:scale-95 disabled:opacity-40 ${
                                    condensingIndex === block.index
                                      ? "bg-emerald-500 text-black font-bold"
                                      : "bg-emerald-950/40 hover:bg-emerald-500 hover:text-black text-emerald-300 border border-emerald-700/50"
                                  }`}
                                  title="One-Click Smart Shorten: Shortens this sentence to fit voiceover & TTS timing without losing core meaning (បង្រួមពាក្យខ្លីសមស្របសំឡេង)"
                                >
                                  {condensingIndex === block.index ? (
                                    <>
                                      <Loader2 className="w-3 h-3 animate-spin text-black" />
                                      <span>Shortening...</span>
                                    </>
                                  ) : (
                                    <>
                                      <Scissors className="w-3 h-3" />
                                      <span>Shorten for Voice</span>
                                    </>
                                  )}
                                </button>

                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleSingleTranslate(block.index);
                                  }}
                                  disabled={isTranslating || block.status === "translating"}
                                  className="px-2 py-1 rounded text-[10px] text-[#888] hover:text-[#FF9F0A] bg-[#141414] hover:bg-[#1F1F1F] border border-[#262626] flex items-center gap-1 transition-all cursor-pointer"
                                  title="Re-translate only this line"
                                >
                                  <RefreshCw className="w-2.5 h-2.5" />
                                  <span>Re-translate</span>
                                </button>

                                {/\.{2,}|…|·{2,}|\(\s*\.{2,}\s*\)/.test(block.translatedText) && (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setBlocks((prev) =>
                                        prev.map((b) =>
                                          b.index === block.index
                                            ? { ...b, translatedText: cleanEllipses(b.translatedText) }
                                            : b
                                        )
                                      );
                                    }}
                                    className="px-2 py-1 rounded text-[10px] text-red-300 hover:text-white bg-red-950/40 hover:bg-red-800 border border-red-800/50 flex items-center gap-1 transition-all cursor-pointer"
                                    title="Strip '...' ellipsis from this line"
                                  >
                                    <Scissors className="w-2.5 h-2.5" />
                                    <span>Strip (...)</span>
                                  </button>
                                )}

                                {detectTranslationIssues(block.translatedText, block.text).some(i => i.includes("Kinship mismatch")) && (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleFixSingleKinship(block.index);
                                    }}
                                    className="px-2 py-1 rounded text-[10px] text-sky-300 hover:text-white bg-sky-950/40 hover:bg-sky-800 border border-sky-800/50 flex items-center gap-1 transition-all cursor-pointer"
                                    title="Fix husband vs brother-in-law relationship mismatch for this line"
                                  >
                                    <Sparkles className="w-2.5 h-2.5" />
                                    <span>Fix Kinship</span>
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              {/* Memory-efficient Pagination Bar controls */}
              {totalPages > 1 && (
                <div className="p-4 border-t border-[#1F1F1F] bg-[#0A0A0A] flex flex-col sm:flex-row items-center justify-between gap-4 shrink-0 text-xs text-[#888]">
                  <div className="flex items-center gap-2">
                    <span>
                      Showing <strong className="text-[#FF9F0A]">{Math.min(filteredBlocks.length, (currentPage - 1) * itemsPerPage + 1)}-{Math.min(filteredBlocks.length, currentPage * itemsPerPage)}</strong> of <strong className="text-[#EBEBEB]">{filteredBlocks.length}</strong> blocks
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <button
                      onClick={() => setCurrentPage(1)}
                      disabled={currentPage === 1}
                      className="px-2.5 py-1.5 rounded bg-[#131313] border border-[#222] text-[#888] hover:text-[#EBEBEB] hover:bg-[#1C1C1C] disabled:opacity-30 disabled:hover:bg-[#131313] disabled:hover:text-[#888] transition-all text-[11px]"
                      title="First Page"
                    >
                      First
                    </button>
                    <button
                      onClick={() => setCurrentPage((prev) => Math.max(1, prev - 1))}
                      disabled={currentPage === 1}
                      className="px-2.5 py-1.5 rounded bg-[#131313] border border-[#222] text-[#888] hover:text-[#EBEBEB] hover:bg-[#1C1C1C] disabled:opacity-30 disabled:hover:bg-[#131313] disabled:hover:text-[#888] transition-all flex items-center gap-1 text-[11px]"
                    >
                      <ChevronLeft className="h-3 w-3" /> Prev
                    </button>
                    <span className="px-3 py-1.5 text-xs font-mono text-[#EBEBEB] bg-[#161616] border border-[#2A2A2A] rounded">
                      Page {currentPage} of {totalPages}
                    </span>
                    <button
                      onClick={() => setCurrentPage((prev) => Math.min(totalPages, prev + 1))}
                      disabled={currentPage === totalPages}
                      className="px-2.5 py-1.5 rounded bg-[#131313] border border-[#222] text-[#888] hover:text-[#EBEBEB] hover:bg-[#1C1C1C] disabled:opacity-30 disabled:hover:bg-[#131313] disabled:hover:text-[#888] transition-all flex items-center gap-1 text-[11px]"
                    >
                      Next <ChevronRight className="h-3 w-3" />
                    </button>
                    <button
                      onClick={() => setCurrentPage(totalPages)}
                      disabled={currentPage === totalPages}
                      className="px-2.5 py-1.5 rounded bg-[#131313] border border-[#222] text-[#888] hover:text-[#EBEBEB] hover:bg-[#1C1C1C] disabled:opacity-30 disabled:hover:bg-[#131313] disabled:hover:text-[#888] transition-all text-[11px]"
                      title="Last Page"
                    >
                      Last
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        {/* Collapsible Subtitle Notepad & Draft Scratchpad Panel */}
        {showNotepad && (
          <aside className="w-full lg:w-[420px] border-t lg:border-t-0 lg:border-l border-[#1F1F1F] bg-[#090909] flex flex-col overflow-hidden shrink-0 transition-all duration-300">
            {/* Notepad Header */}
            <div className="p-4 border-b border-[#1F1F1F] bg-[#0D0D0D] flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-[#FF9F0A]" />
                <span className="text-xs font-semibold uppercase tracking-widest text-[#EBEBEB]">
                  Notepad Scratchpad
                </span>
              </div>
              <button
                onClick={() => setShowNotepad(false)}
                className="text-xs text-[#888] hover:text-[#FF9F0A] px-2 py-1 rounded bg-[#131313] hover:bg-[#1C1C1C] border border-[#222] transition-colors font-semibold"
              >
                Close ✕
              </button>
            </div>

            {/* Mode Selector Tab */}
            <div className="p-3.5 border-b border-[#1F1F1F] bg-[#0B0B0B] flex flex-col gap-2 shrink-0">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-[#888] font-mono tracking-wider uppercase">NOTEPAD VIEW MODE:</span>
                {warningsCount > 0 ? (
                  <span className="text-[9px] bg-amber-950/40 text-amber-300 border border-amber-800/40 px-2 py-0.5 rounded-full font-mono font-bold flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-ping"></span>
                    {warningsCount} Lines with Notices
                  </span>
                ) : (
                  <span className="text-[9px] bg-emerald-950/40 text-emerald-300 border border-emerald-800/40 px-2 py-0.5 rounded-full font-mono">
                    ✓ 100% Clean
                  </span>
                )}
              </div>

              <div className="grid grid-cols-3 gap-1 bg-[#131313] p-1 rounded-lg border border-[#222]">
                <button
                  onClick={() => handleLoadToNotepad("plain")}
                  className={`py-1 text-[9px] font-medium rounded uppercase transition-all text-center ${
                    notepadMode === "plain"
                      ? "bg-[#222] text-[#FF9F0A] font-semibold shadow-sm"
                      : "text-[#666] hover:text-[#EBEBEB]"
                  }`}
                  title="Each line formatted as #Index: Text. Perfect for clean transliterations and overrides."
                >
                  Plain (#Index)
                </button>
                <button
                  onClick={() => handleLoadToNotepad("srt")}
                  className={`py-1 text-[9px] font-medium rounded uppercase transition-all text-center ${
                    notepadMode === "srt"
                      ? "bg-[#222] text-[#FF9F0A] font-semibold shadow-sm"
                      : "text-[#666] hover:text-[#EBEBEB]"
                  }`}
                  title="Full standard SRT file text structure."
                >
                  Full SRT
                </button>
                <button
                  onClick={() => handleLoadToNotepad("notices")}
                  className={`py-1 text-[9px] font-medium rounded uppercase transition-all text-center flex items-center justify-center gap-1 ${
                    notepadMode === "notices"
                      ? "bg-amber-950/60 text-amber-300 border border-amber-700/50 font-bold shadow-sm"
                      : "text-amber-500/80 hover:text-amber-300"
                  }`}
                  title="Filter and pull only lines containing Chinese characters, foreign script, or missing translations"
                >
                  <span>⚠️ Notices</span>
                  {warningsCount > 0 && (
                    <span className="text-[8px] bg-amber-500 text-black px-1 rounded-full font-bold">
                      {warningsCount}
                    </span>
                  )}
                </button>
              </div>
            </div>

            {/* Actions Panel */}
            <div className="p-3.5 bg-[#0D0D0D]/60 border-b border-[#1F1F1F] space-y-2 shrink-0">
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => handleLoadToNotepad(notepadMode)}
                  disabled={blocks.length === 0}
                  className="py-2 px-3 text-[10px] uppercase font-mono tracking-wide bg-[#131313] hover:bg-[#1A1A1A] border border-[#222] text-[#EBEBEB] hover:text-[#FF9F0A] rounded-lg transition-all flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Populate Notepad with current subtitle translations."
                >
                  <RefreshCw className="h-3 w-3 animate-spin" style={{ animationDuration: '4s' }} />
                  <span>Pull {notepadMode === "notices" ? "Notices" : "Subtitles"}</span>
                </button>
                <button
                  onClick={handleSaveFromNotepad}
                  disabled={!notepadText.trim()}
                  className={`py-2 px-3 text-[10px] uppercase tracking-wide rounded-lg transition-all flex items-center justify-center gap-1.5 font-bold ${
                    notepadSaveSuccess
                      ? "bg-emerald-600 text-white shadow-lg"
                      : "bg-[#FF9F0A] hover:bg-[#e68e09] text-black"
                  }`}
                  title="Save changes back to the loaded subtitles blocks."
                >
                  {notepadSaveSuccess ? (
                    <>
                      <Check className="h-3 w-3 animate-bounce" />
                      <span>Saved Drafts!</span>
                    </>
                  ) : (
                    <>
                      <Download className="h-3 w-3" />
                      <span>Save to Blocks</span>
                    </>
                  )}
                </button>
              </div>

              {warningsCount > 0 && !isTranslating && (
                <button
                  onClick={handleReTranslateWarnings}
                  className="w-full py-1.5 px-3 bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/30 rounded-lg text-[9.5px] font-semibold flex items-center justify-center gap-1.5 transition-all cursor-pointer"
                  title="Trigger AI Auto-Repair for all lines currently flagged with translation notices"
                >
                  <RefreshCw className="h-3 w-3 animate-spin" style={{ animationDuration: '3s' }} />
                  <span>AI Auto-Repair All {warningsCount} Lines with Notices</span>
                </button>
              )}

              {stats.done > 0 && !isTranslating && (
                <button
                  onClick={() => setShowCondenseModal(true)}
                  disabled={isCondensing}
                  className="w-full py-2 px-3 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 rounded-lg text-[10px] font-semibold flex items-center justify-center gap-2 transition-all cursor-pointer shadow-sm mt-1"
                  title="Smart-shorten long Khmer translations to fit voiceover and Balabolka TTS timing"
                >
                  {isCondensing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-400" />
                  ) : (
                    <Scissors className="h-3.5 w-3.5 text-emerald-400" />
                  )}
                  <span>
                    {isCondensing
                      ? `Shortening for Voice (${condensingProgress.current}/${condensingProgress.total})...`
                      : overrunBlocks.length > 0
                      ? `⚡ Auto-Shorten for Voice (${overrunBlocks.length} Overruns)`
                      : `🎙️ Smart Voice Condense (Auto-Shorten)`}
                  </span>
                </button>
              )}
            </div>

            {/* Help guidelines banner */}
            <div className="p-3.5 bg-[#121212] border-b border-[#1F1F1F] text-[9.5px] text-[#888] leading-relaxed font-mono space-y-1">
              <div className="text-[#FF9F0A] font-bold">💡 Fallbacks & Romanization Support</div>
              <div>
                If names or words can't be translated to Khmer, edit them into clean English/Pinyin fallback text (e.g., <span className="text-amber-400">"Gu Lanying"</span>, <span className="text-amber-400">"Yòu shì"</span>) in this notepad.
              </div>
              <div className="text-[#666]">
                * In Plain mode, keep the <span className="text-amber-400">#Index:</span> prefix intact to parse and map edits back to the loaded timeline.
              </div>
            </div>

            {/* 🤪 Funny Khmer Slang Soundboard/Injector */}
            <div className="p-3 bg-[#090909] border-b border-[#1F1F1F]">
              <div className="flex items-center justify-between mb-2 px-1">
                <span className="text-[10px] text-pink-400 font-bold uppercase tracking-wider flex items-center gap-1.5">
                  <span>🤪 Quick-Inject Funny Slang</span>
                  <span className="text-[8px] bg-pink-950/40 text-pink-300 border border-pink-900/40 px-1.5 py-0.5 rounded font-mono">
                    {funnySlangList.length} WORDS
                  </span>
                </span>
                
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={handleShuffleSlang}
                    className="px-2 py-1 bg-[#161616] hover:bg-[#222] text-[#AAA] hover:text-[#FFF] border border-[#2A2A2A] rounded text-[9px] font-mono flex items-center gap-1 transition-all active:scale-95 cursor-pointer"
                    title="Randomly shuffle and re-order the funny slang words"
                  >
                    <Shuffle className="w-3 h-3 text-pink-400" />
                    <span>Shuffle</span>
                  </button>

                  <button
                    onClick={handleInsertRandomSlang}
                    className="px-2 py-1 bg-pink-950/30 hover:bg-pink-900/50 text-pink-300 border border-pink-800/40 rounded text-[9px] font-mono font-bold flex items-center gap-1 transition-all active:scale-95 cursor-pointer"
                    title="Pick a random non-repeating funny slang word and insert it into the scratchpad"
                  >
                    <Dices className="w-3 h-3 text-pink-400" />
                    <span>Random Pick</span>
                  </button>
                </div>
              </div>

              <div className="flex gap-1.5 overflow-x-auto pb-1.5 scrollbar-thin scrollbar-thumb-neutral-800 scrollbar-track-transparent">
                {funnySlangList.map((item, idx) => (
                  <button
                    key={idx}
                    onClick={() => {
                      setNotepadText((prev) => {
                        if (!prev) return item.phrase;
                        if (prev.endsWith("\n") || prev.endsWith(" ")) return prev + item.phrase;
                        return prev + " " + item.phrase;
                      });
                    }}
                    className="shrink-0 px-2.5 py-1.5 bg-[#131313] hover:bg-pink-950/20 hover:text-pink-400 border border-[#222] hover:border-pink-900/40 rounded-lg text-[10px] text-[#EBEBEB] transition-all flex flex-col items-center gap-0.5 active:scale-95 cursor-pointer"
                    title={`Click to append "${item.phrase}" (${item.meaning})`}
                  >
                    <span className="font-semibold text-[11px] font-sans text-pink-400/90">{item.phrase}</span>
                    <span className="text-[8px] text-[#555] font-mono uppercase">{item.meaning}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Notepad Editor Area */}
            <div className="flex-1 relative p-4 bg-[#090909] flex flex-col">
              <textarea
                value={notepadText}
                onChange={(e) => setNotepadText(e.target.value)}
                placeholder={
                  notepadMode === "plain"
                    ? "#1: Khmer subtitle or English/Pinyin...\n#2: Second line override..."
                    : "1\n00:00:01,000 --> 00:00:04,000\nKhmer translation text..."
                }
                className="flex-1 w-full bg-[#111] text-xs text-[#EBEBEB] p-4 rounded-xl border border-[#222] focus:outline-none focus:border-amber-500/50 font-mono resize-none leading-relaxed h-full shadow-inner"
              />
            </div>
          </aside>
        )}
      </main>

      {/* Bottom Status / Ticker Bar */}
      <footer className="h-10 border-t border-[#1F1F1F] bg-[#0D0D0D] flex items-center justify-between px-6 shrink-0 z-30">
        <div className="flex items-center space-x-6 text-[10px] text-[#555] font-mono">
          <div className="flex items-center">
            <div className={`w-1.5 h-1.5 rounded-full mr-2 ${isTranslating ? "bg-[#FF9F0A] animate-pulse" : "bg-emerald-500"}`}></div>
            {isTranslating ? "AI TRANSLATING..." : "AI CONNECTED"}
          </div>
          <div>BLOCKS: {stats.total}</div>
          <div>DONE: {stats.done} / {stats.total}</div>
        </div>
        <div className="text-[10px] text-[#555] tracking-widest hidden sm:block">
          AUTO-SAVE ACTIVE • PROJECT_ID: CN_KH_009
        </div>
      </footer>

      {/* Smart Voice Condenser Modal */}
      {showCondenseModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#111] border border-[#262626] rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            {/* Modal Header */}
            <div className="p-5 border-b border-[#222] flex items-center justify-between bg-gradient-to-r from-[#141414] to-[#181818]">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
                  <Scissors className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-[#EBEBEB] flex items-center gap-2">
                    <span>Smart Voice Shortener</span>
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-950/60 text-emerald-400 border border-emerald-800/50">
                      បង្រួមពាក្យខ្លីសមស្របសំឡេង
                    </span>
                  </h3>
                  <p className="text-[11px] text-[#888] mt-0.5">
                    Condense Khmer translations to match audio timing & TTS pacing without losing meaning
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowCondenseModal(false)}
                disabled={isCondensing}
                className="text-[#666] hover:text-[#EBEBEB] p-1.5 rounded-lg hover:bg-[#222] transition-all cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Content */}
            <div className="p-5 space-y-4 text-xs">
              {/* Diagnosis Box */}
              <div className="grid grid-cols-2 gap-2 bg-[#090909] p-3 rounded-xl border border-[#1F1F1F]">
                <div className="space-y-1">
                  <div className="text-[10px] uppercase font-mono text-[#666]">Overrun Hazard Lines</div>
                  <div className="text-lg font-bold font-mono text-amber-400 flex items-center gap-1.5">
                    <span>{overrunBlocks.length}</span>
                    <span className="text-[10px] font-normal text-[#888]">
                      ({overrunBlocks.length > 0 ? "CPS > 13: speaks too fast" : "None detected"})
                    </span>
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="text-[10px] uppercase font-mono text-[#666]">Translated Lines</div>
                  <div className="text-lg font-bold font-mono text-[#EBEBEB]">
                    <span>{stats.done}</span>
                    <span className="text-[10px] font-normal text-[#888]"> ready</span>
                  </div>
                </div>
              </div>

              {/* Scope Selection */}
              <div className="space-y-1.5">
                <label className="text-[11px] font-semibold text-[#AAA] uppercase tracking-wider block">
                  Target Scope
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setCondenseScope("overrun")}
                    disabled={isCondensing}
                    className={`p-3 rounded-xl border text-left transition-all cursor-pointer ${
                      condenseScope === "overrun"
                        ? "bg-amber-500/10 border-amber-500/40 text-amber-200 shadow-sm"
                        : "bg-[#141414] border-[#222] text-[#888] hover:text-[#CCC] hover:border-[#333]"
                    }`}
                  >
                    <div className="font-semibold text-xs flex items-center justify-between">
                      <span>Overrun Lines Only</span>
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-950/60 text-amber-400">
                        {overrunBlocks.length}
                      </span>
                    </div>
                    <div className="text-[10px] text-[#666] mt-1 leading-snug">
                      Only shorten sentences that exceed normal speaking tempo (CPS &gt; 13).
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setCondenseScope("all")}
                    disabled={isCondensing}
                    className={`p-3 rounded-xl border text-left transition-all cursor-pointer ${
                      condenseScope === "all"
                        ? "bg-emerald-500/10 border-emerald-500/40 text-emerald-200 shadow-sm"
                        : "bg-[#141414] border-[#222] text-[#888] hover:text-[#CCC] hover:border-[#333]"
                    }`}
                  >
                    <div className="font-semibold text-xs flex items-center justify-between">
                      <span>All Translated Lines</span>
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-950/60 text-emerald-400">
                        {stats.done}
                      </span>
                    </div>
                    <div className="text-[10px] text-[#666] mt-1 leading-snug">
                      Make entire dialogue concise and swift for high-energy dubbing.
                    </div>
                  </button>
                </div>
              </div>

              {/* Brevity Level */}
              <div className="space-y-1.5">
                <label className="text-[11px] font-semibold text-[#AAA] uppercase tracking-wider block">
                  Shortening Profile
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setCondenseBrevity("natural")}
                    disabled={isCondensing}
                    className={`p-2.5 rounded-xl border text-left transition-all cursor-pointer ${
                      condenseBrevity === "natural"
                        ? "bg-[#1F1F1F] border-[#FF9F0A]/50 text-[#EBEBEB]"
                        : "bg-[#141414] border-[#222] text-[#888] hover:text-[#CCC]"
                    }`}
                  >
                    <div className="font-medium text-xs flex items-center gap-1.5 text-emerald-400">
                      <span>🎙️ Natural Spoken (ខ្លីល្មម)</span>
                    </div>
                    <div className="text-[10px] text-[#666] mt-0.5 leading-snug">
                      Drops wordy fillers while preserving natural spoken rhythm.
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setCondenseBrevity("ultra")}
                    disabled={isCondensing}
                    className={`p-2.5 rounded-xl border text-left transition-all cursor-pointer ${
                      condenseBrevity === "ultra"
                        ? "bg-[#1F1F1F] border-[#FF9F0A]/50 text-[#EBEBEB]"
                        : "bg-[#141414] border-[#222] text-[#888] hover:text-[#CCC]"
                    }`}
                  >
                    <div className="font-medium text-xs flex items-center gap-1.5 text-amber-400">
                      <span>⚡ Ultra-Compact (ខ្លីខ្លឹម)</span>
                    </div>
                    <div className="text-[10px] text-[#666] mt-0.5 leading-snug">
                      Maximum brevity for fast cuts, rapid anime, or tight timecodes.
                    </div>
                  </button>
                </div>
              </div>

              {/* If condensing is in progress, display live progress */}
              {isCondensing && (
                <div className="p-3 bg-amber-950/20 border border-amber-500/30 rounded-xl space-y-2">
                  <div className="flex items-center justify-between text-xs text-amber-300 font-medium">
                    <span className="flex items-center gap-2">
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-400" />
                      Shortening with Gemini AI...
                    </span>
                    <span className="font-mono">
                      {condensingProgress.current} / {condensingProgress.total} lines
                    </span>
                  </div>
                  <div className="w-full bg-[#222] h-1.5 rounded-full overflow-hidden">
                    <div
                      className="bg-amber-400 h-full transition-all duration-300 rounded-full"
                      style={{
                        width: `${
                          condensingProgress.total > 0
                            ? Math.round((condensingProgress.current / condensingProgress.total) * 100)
                            : 0
                        }%`
                      }}
                    />
                  </div>
                </div>
              )}

              {/* Previous Condense Summary if present */}
              {condenseStatsSummary && !isCondensing && (
                <div className="p-2.5 bg-emerald-950/20 border border-emerald-500/30 rounded-xl flex items-center justify-between text-[11px] text-emerald-300">
                  <span className="flex items-center gap-1.5 font-medium">
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                    Last run: {condenseStatsSummary.count} lines shortened by {condenseStatsSummary.avgReduction}% avg
                  </span>
                  <span className="font-mono text-[10px] text-emerald-400/80">
                    {condenseStatsSummary.oldChars} → {condenseStatsSummary.newChars} chars
                  </span>
                </div>
              )}
            </div>

            {/* Modal Footer Actions */}
            <div className="p-4 border-t border-[#222] bg-[#0D0D0D] flex items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setShowCondenseModal(false)}
                disabled={isCondensing}
                className="px-4 py-2 rounded-xl text-xs text-[#888] hover:text-[#EBEBEB] hover:bg-[#1A1A1A] transition-all disabled:opacity-40 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => handleBatchCondense(condenseScope, condenseBrevity)}
                disabled={isCondensing || (condenseScope === "overrun" ? overrunBlocks.length === 0 : stats.done === 0)}
                className="px-5 py-2 rounded-xl text-xs font-bold bg-emerald-500 hover:bg-emerald-400 text-black flex items-center gap-2 transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed shadow-lg shadow-emerald-950/40 cursor-pointer"
              >
                {isCondensing ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Processing...</span>
                  </>
                ) : (
                  <>
                    <Scissors className="w-3.5 h-3.5" />
                    <span>
                      Shorten {condenseScope === "overrun" ? `${overrunBlocks.length} Overruns` : `All ${stats.done} Lines`}
                    </span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Application Code & Export Functions Modal */}
      {showCodeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-[#141414] border border-[#262626] rounded-2xl w-full max-w-4xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden">
            {/* Modal Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#262626] bg-[#161616]">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-xl bg-sky-500/10 border border-sky-500/20 text-sky-400">
                  <Code className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-white">Application Code & Export Functions</h3>
                  <p className="text-xs text-[#888]">Inspect export logic, amount-to-Khmer words translation, or export the full codebase.</p>
                </div>
              </div>
              <button
                onClick={() => setShowCodeModal(false)}
                className="p-2 text-[#777] hover:text-white rounded-lg hover:bg-[#222] transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Navigation Tabs */}
            <div className="flex items-center gap-2 px-6 pt-3 border-b border-[#222] bg-[#121212] overflow-x-auto">
              <button
                onClick={() => setCodeActiveTab("download-zip")}
                className={`px-4 py-2 text-xs font-medium border-b-2 transition-all flex items-center gap-2 whitespace-nowrap ${
                  codeActiveTab === "download-zip"
                    ? "border-emerald-400 text-emerald-400 font-bold"
                    : "border-transparent text-[#888] hover:text-[#DDD]"
                }`}
              >
                <Download className="w-3.5 h-3.5 text-emerald-400" />
                <span>Download Full Source (.ZIP)</span>
              </button>
              <button
                onClick={() => setCodeActiveTab("files")}
                className={`px-4 py-2 text-xs font-medium border-b-2 transition-all flex items-center gap-2 whitespace-nowrap ${
                  codeActiveTab === "files"
                    ? "border-sky-400 text-sky-400 font-semibold"
                    : "border-transparent text-[#888] hover:text-[#DDD]"
                }`}
              >
                <FileText className="w-3.5 h-3.5 text-sky-400" />
                <span>Browse All Source Files</span>
              </button>
              <button
                onClick={() => setCodeActiveTab("export-functions")}
                className={`px-4 py-2 text-xs font-medium border-b-2 transition-all flex items-center gap-2 whitespace-nowrap ${
                  codeActiveTab === "export-functions"
                    ? "border-sky-400 text-sky-400 font-semibold"
                    : "border-transparent text-[#888] hover:text-[#DDD]"
                }`}
              >
                <Zap className="w-3.5 h-3.5 text-amber-400" />
                <span>Export & Number Functions</span>
              </button>
              <button
                onClick={() => setCodeActiveTab("export-guide")}
                className={`px-4 py-2 text-xs font-medium border-b-2 transition-all flex items-center gap-2 whitespace-nowrap ${
                  codeActiveTab === "export-guide"
                    ? "border-sky-400 text-sky-400 font-semibold"
                    : "border-transparent text-[#888] hover:text-[#DDD]"
                }`}
              >
                <Globe className="w-3.5 h-3.5 text-indigo-400" />
                <span>Studio Export & Deploy Guide</span>
              </button>
            </div>

            {/* Modal Content Body */}
            <div className="p-6 overflow-y-auto flex-1 text-xs text-[#CCC] space-y-6">
              {/* Tab 1: Download Complete Source ZIP */}
              {codeActiveTab === "download-zip" && (
                <div className="space-y-6">
                  {/* Hero Download Card */}
                  <div className="bg-gradient-to-br from-emerald-950/40 via-[#161616] to-[#121212] border border-emerald-500/30 rounded-2xl p-6 shadow-xl">
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-5">
                      <div>
                        <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-[11px] font-semibold mb-2">
                          <Check className="w-3 h-3" /> Ready for Download & Local Setup
                        </div>
                        <h4 className="text-lg font-bold text-white mb-1">Download Complete App Source Code</h4>
                        <p className="text-xs text-[#999] max-w-xl leading-relaxed">
                          Export the entire project in your preferred format: single runnable HTML file (double-click to open), all source code combined into 1 HTML file, or full ZIP repository.
                        </p>
                      </div>
                      <div className="flex flex-col sm:flex-row gap-2 shrink-0">
                        <button
                          onClick={() => handleSafeBlobDownload("/api/download-app-html", "chinese-khmer-translator-app.html")}
                          disabled={downloadingFormat !== null}
                          className="px-4 py-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-black font-bold text-xs flex items-center justify-center gap-2 shadow-lg shadow-emerald-950/50 hover:shadow-emerald-900/60 transition-all active:scale-95 disabled:opacity-50"
                        >
                          <Download className="w-4 h-4 text-black" />
                          <span>Standalone HTML App (.html)</span>
                        </button>
                        <button
                          onClick={() => handleSafeBlobDownload("/api/download-all-code-html", "chinese-khmer-translator-all-code.html")}
                          disabled={downloadingFormat !== null}
                          className="px-4 py-3 rounded-xl bg-sky-500 hover:bg-sky-400 text-black font-bold text-xs flex items-center justify-center gap-2 shadow-lg shadow-sky-950/50 hover:shadow-sky-900/60 transition-all active:scale-95 disabled:opacity-50"
                        >
                          <FileText className="w-4 h-4 text-black" />
                          <span>All Code in 1 HTML (.html)</span>
                        </button>
                        <button
                          onClick={() => handleSafeBlobDownload("/api/download-source-zip", "chinese-khmer-translator-source.zip")}
                          disabled={downloadingFormat !== null}
                          className="px-4 py-3 rounded-xl bg-[#222] hover:bg-[#2A2A2A] border border-[#333] text-white font-bold text-xs flex items-center justify-center gap-2 transition-all active:scale-95 disabled:opacity-50"
                        >
                          <Download className="w-4 h-4 text-emerald-400" />
                          <span>Source (.ZIP)</span>
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-6 pt-5 border-t border-[#262626]">
                      <div className="bg-[#121212] border border-[#222] rounded-lg p-2.5">
                        <div className="text-[10px] text-[#777] uppercase tracking-wider font-semibold">Backend</div>
                        <div className="text-xs font-bold text-white mt-0.5">Express + Node.js</div>
                      </div>
                      <div className="bg-[#121212] border border-[#222] rounded-lg p-2.5">
                        <div className="text-[10px] text-[#777] uppercase tracking-wider font-semibold">Frontend</div>
                        <div className="text-xs font-bold text-white mt-0.5">React 19 + Vite</div>
                      </div>
                      <div className="bg-[#121212] border border-[#222] rounded-lg p-2.5">
                        <div className="text-[10px] text-[#777] uppercase tracking-wider font-semibold">AI SDK</div>
                        <div className="text-xs font-bold text-white mt-0.5">@google/genai</div>
                      </div>
                      <div className="bg-[#121212] border border-[#222] rounded-lg p-2.5">
                        <div className="text-[10px] text-[#777] uppercase tracking-wider font-semibold">Styling</div>
                        <div className="text-xs font-bold text-white mt-0.5">Tailwind CSS v4</div>
                      </div>
                    </div>
                  </div>

                  {/* Quick Local Setup Card */}
                  <div className="bg-[#181818] border border-[#262626] rounded-xl p-5">
                    <h5 className="text-xs font-bold text-white mb-2 flex items-center gap-2">
                      <Terminal className="w-4 h-4 text-amber-400" />
                      How to Run on Your Local Computer
                    </h5>
                    <div className="space-y-3 text-[11px] text-[#AAA]">
                      <p>After downloading and extracting <code className="text-emerald-400 font-mono">chinese-khmer-translator-source.zip</code>, run these 3 commands in your terminal:</p>
                      <pre className="bg-[#0D0D0D] p-3 rounded-lg overflow-x-auto text-[11px] font-mono text-emerald-400 border border-[#222] leading-relaxed">
{`# 1. Install all dependencies
npm install

# 2. Add your Gemini API key (create a .env file)
echo "GEMINI_API_KEY=your_gemini_api_key_here" > .env

# 3. Start development server
npm run dev`}
                      </pre>
                      <p className="text-[11px] text-[#777]">
                        The development server will immediately open on <strong className="text-white">http://localhost:3000</strong>.
                      </p>
                    </div>
                  </div>

                  {/* Complete File Manifest */}
                  <div className="bg-[#161616] border border-[#262626] rounded-xl p-4">
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-xs font-bold text-white">Files Included in the ZIP Archive</span>
                      <span className="text-[10px] text-[#777]">15 Files • Production Ready</span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] font-mono">
                      {[
                        { name: "server.ts", desc: "Express backend & Gemini translation API" },
                        { name: "src/App.tsx", desc: "Main React translation studio UI" },
                        { name: "src/utils/srtParser.ts", desc: "SRT/VTT parser & Khmer number word logic" },
                        { name: "src/components/VideoPlayerStudio.tsx", desc: "Video player with karaoke subtitles" },
                        { name: "src/types.ts", desc: "TypeScript interface definitions" },
                        { name: "src/main.tsx", desc: "React entry point bootstrap" },
                        { name: "package.json", desc: "Dependencies and build scripts" },
                        { name: "README.md", desc: "Full documentation & setup instructions" },
                        { name: "vite.config.ts", desc: "Vite build & Tailwind configuration" },
                        { name: "tsconfig.json", desc: "TypeScript compiler settings" },
                        { name: "index.html", desc: "HTML entry with fonts & meta" },
                        { name: ".env.example", desc: "Environment template with GEMINI_API_KEY" }
                      ].map((f) => (
                        <div key={f.name} className="flex items-center justify-between bg-[#111] p-2 rounded border border-[#222]">
                          <span className="text-sky-400 font-semibold">{f.name}</span>
                          <span className="text-[10px] text-[#777] truncate max-w-[180px]">{f.desc}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Tab 2: Browse All Source Files */}
              {codeActiveTab === "files" && (
                <div className="space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-[#181818] p-3 rounded-xl border border-[#262626]">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-white">Select File to View:</span>
                      <select
                        value={selectedSourceFilePath}
                        onChange={(e) => setSelectedSourceFilePath(e.target.value)}
                        className="bg-[#111] border border-[#333] text-sky-400 font-mono text-xs rounded-lg px-3 py-1.5 focus:outline-none focus:border-sky-500 cursor-pointer"
                      >
                        <option value="server.ts">server.ts (Backend & AI API)</option>
                        <option value="src/App.tsx">src/App.tsx (Frontend UI & State)</option>
                        <option value="src/utils/srtParser.ts">src/utils/srtParser.ts (Parser & Numbers)</option>
                        <option value="src/components/VideoPlayerStudio.tsx">src/components/VideoPlayerStudio.tsx (Video Studio)</option>
                        <option value="src/types.ts">src/types.ts (Types & Interfaces)</option>
                        <option value="package.json">package.json (Dependencies & Scripts)</option>
                        <option value="README.md">README.md (Documentation & Setup)</option>
                        <option value="vite.config.ts">vite.config.ts (Build Config)</option>
                        <option value="tsconfig.json">tsconfig.json (TypeScript Config)</option>
                        <option value="index.html">index.html (HTML Shell)</option>
                        <option value=".env.example">.env.example (Environment Template)</option>
                      </select>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => {
                          if (sourceFileContent) {
                            navigator.clipboard.writeText(sourceFileContent);
                            setCodeCopiedTab("file-copy");
                            setTimeout(() => setCodeCopiedTab(null), 2000);
                          }
                        }}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#222] hover:bg-[#2A2A2A] text-white text-xs transition-colors"
                      >
                        {codeCopiedTab === "file-copy" ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5 text-sky-400" />}
                        <span>{codeCopiedTab === "file-copy" ? "Copied File" : "Copy Entire File"}</span>
                      </button>

                      <button
                        onClick={() => {
                          if (sourceFileContent) {
                            const blob = new Blob([sourceFileContent], { type: "text/plain;charset=utf-8;" });
                            const url = URL.createObjectURL(blob);
                            const link = document.createElement("a");
                            link.href = url;
                            link.setAttribute("download", selectedSourceFilePath.split("/").pop() || "source.txt");
                            document.body.appendChild(link);
                            link.click();
                            document.body.removeChild(link);
                            URL.revokeObjectURL(url);
                          }
                        }}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#222] hover:bg-[#2A2A2A] text-white text-xs transition-colors"
                      >
                        <Download className="w-3.5 h-3.5 text-emerald-400" />
                        <span>Download This File</span>
                      </button>
                    </div>
                  </div>

                  <div className="relative bg-[#0D0D0D] border border-[#222] rounded-xl overflow-hidden">
                    <div className="flex items-center justify-between px-4 py-2 border-b border-[#222] bg-[#141414] text-[11px] text-[#777]">
                      <span className="font-mono text-sky-400 font-semibold">{selectedSourceFilePath}</span>
                      <span>{sourceFileContent.split("\n").length} Lines • UTF-8</span>
                    </div>

                    {isLoadingSourceFile ? (
                      <div className="flex items-center justify-center p-12 text-[#777] gap-2">
                        <Loader2 className="w-4 h-4 animate-spin text-sky-400" />
                        <span>Loading {selectedSourceFilePath}...</span>
                      </div>
                    ) : (
                      <pre className="p-4 overflow-x-auto text-[11px] font-mono text-[#DDD] leading-relaxed max-h-[500px] overflow-y-auto">
                        {sourceFileContent}
                      </pre>
                    )}
                  </div>
                </div>
              )}

              {/* Tab 3: Export & Number Functions */}
              {codeActiveTab === "export-functions" && (
                <div className="space-y-6">
                  {/* Function 1: handleDownloadSRT */}
                  <div className="bg-[#1A1A1A] border border-[#2A2A2A] rounded-xl p-4">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-amber-400">1. Subtitle SRT Export Function</span>
                        <span className="text-[10px] bg-black/40 text-[#888] px-2 py-0.5 rounded border border-[#333]">src/App.tsx</span>
                      </div>
                      <button
                        onClick={() => {
                          const code = `const handleDownloadSRT = (useKhmer = true) => {
  if (blocks.length === 0) return;
  const content = stringifySRT(blocks, useKhmer);
  const blob = new Blob([content], { type: "text/srt;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  const suffix = useKhmer ? "_khmer" : "_original";
  const baseName = uploadedFileName ? uploadedFileName.replace(/\\.[^/.]+$/, "") : "translated_subtitles";
  link.setAttribute("download", \`\${baseName}\${suffix}.srt\`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};`;
                          navigator.clipboard.writeText(code);
                          setCodeCopiedTab("srt");
                          setTimeout(() => setCodeCopiedTab(null), 2000);
                        }}
                        className="flex items-center gap-1 text-[11px] text-sky-400 hover:text-sky-300 px-2 py-1 rounded bg-[#222] hover:bg-[#282828] transition-colors"
                      >
                        {codeCopiedTab === "srt" ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                        <span>{codeCopiedTab === "srt" ? "Copied" : "Copy Function"}</span>
                      </button>
                    </div>
                    <pre className="bg-[#0D0D0D] p-3 rounded-lg overflow-x-auto text-[11px] font-mono text-[#DDD] border border-[#222] leading-relaxed">
{`// Download translated SRT file directly in the browser
const handleDownloadSRT = (useKhmer = true) => {
  if (blocks.length === 0) return;
  const content = stringifySRT(blocks, useKhmer);
  const blob = new Blob([content], { type: "text/srt;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  const suffix = useKhmer ? "_khmer" : "_original";
  
  let baseName = "translated_subtitles";
  if (uploadedFileName) {
    baseName = uploadedFileName.replace(/\\.[^/.]+$/, "");
  }
  
  link.setAttribute("download", \`\${baseName}\${suffix}.srt\`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};`}
                    </pre>
                  </div>

                  {/* Function 2: stringifySRT */}
                  <div className="bg-[#1A1A1A] border border-[#2A2A2A] rounded-xl p-4">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-sky-400">2. SRT Stringifier & Number Converter</span>
                        <span className="text-[10px] bg-black/40 text-[#888] px-2 py-0.5 rounded border border-[#333]">src/utils/srtParser.ts</span>
                      </div>
                      <button
                        onClick={() => {
                          const code = `export function stringifySRT(blocks: SubtitleBlock[], useKhmer = true): string {
  return blocks
    .map(block => {
      let rawText = useKhmer 
        ? (block.translatedText.trim() || block.text.trim()) 
        : block.text.trim();
      // Cleans dot trailers and ensures amount numbers are in Khmer words (100000 -> មួយសែន, 100000000 -> មួយរយលាន)
      const textToExport = useKhmer ? convertSentenceAmountsToKhmerWords(cleanEllipses(rawText)) : rawText;
      return \`\${block.index}\\n\${block.timecode}\\n\${textToExport}\`;
    })
    .join("\\n\\n");
}`;
                          navigator.clipboard.writeText(code);
                          setCodeCopiedTab("stringify");
                          setTimeout(() => setCodeCopiedTab(null), 2000);
                        }}
                        className="flex items-center gap-1 text-[11px] text-sky-400 hover:text-sky-300 px-2 py-1 rounded bg-[#222] hover:bg-[#282828] transition-colors"
                      >
                        {codeCopiedTab === "stringify" ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                        <span>{codeCopiedTab === "stringify" ? "Copied" : "Copy Function"}</span>
                      </button>
                    </div>
                    <pre className="bg-[#0D0D0D] p-3 rounded-lg overflow-x-auto text-[11px] font-mono text-[#DDD] border border-[#222] leading-relaxed">
{`export function stringifySRT(blocks: SubtitleBlock[], useKhmer = true): string {
  return blocks
    .map(block => {
      let rawText = useKhmer 
        ? (block.translatedText.trim() || block.text.trim()) 
        : block.text.trim();
      // Applies ellipsis cleanup and auto-converts amount numbers to Khmer words
      const textToExport = useKhmer ? convertSentenceAmountsToKhmerWords(cleanEllipses(rawText)) : rawText;
      return \`\${block.index}\\n\${block.timecode}\\n\${textToExport}\`;
    })
    .join("\\n\\n");
}`}
                    </pre>
                  </div>

                  {/* Function 3: numberToKhmerWords */}
                  <div className="bg-[#1A1A1A] border border-[#2A2A2A] rounded-xl p-4">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-emerald-400">3. Amount Numbers to Khmer Words Converter</span>
                        <span className="text-[10px] bg-black/40 text-[#888] px-2 py-0.5 rounded border border-[#333]">src/utils/srtParser.ts & server.ts</span>
                      </div>
                      <button
                        onClick={() => {
                          const code = `export function numberToKhmerWords(numStr: string): string {
  const khmerDigitsMap = { "០": "0", "១": "1", "២": "2", "៣": "3", "៤": "4", "៥": "5", "៦": "6", "៧": "7", "៨": "8", "៩": "9" };
  let clean = numStr.replace(/[\\u17e0-\\u17e9]/g, (ch) => khmerDigitsMap[ch] || ch);
  clean = clean.replace(/[,.]/g, "").trim();
  if (!clean || !/^\\d+$/.test(clean)) return numStr;
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
      if (remThousands > 0n) millionPart += convertIntegerToKhmerWords(remThousands);
      millionPart += "លាន";
    } else {
      millionPart = convertIntegerToKhmerWords(millions) + "លាន";
    }
    if (remainder > 0n) return millionPart + " " + convertIntegerToKhmerWords(remainder);
    return millionPart;
  }
  return convertIntegerToKhmerWords(num);
}`;
                          navigator.clipboard.writeText(code);
                          setCodeCopiedTab("converter");
                          setTimeout(() => setCodeCopiedTab(null), 2000);
                        }}
                        className="flex items-center gap-1 text-[11px] text-sky-400 hover:text-sky-300 px-2 py-1 rounded bg-[#222] hover:bg-[#282828] transition-colors"
                      >
                        {codeCopiedTab === "converter" ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                        <span>{codeCopiedTab === "converter" ? "Copied" : "Copy Function"}</span>
                      </button>
                    </div>
                    <pre className="bg-[#0D0D0D] p-3 rounded-lg overflow-x-auto text-[11px] font-mono text-[#DDD] border border-[#222] leading-relaxed">
{`// Converts amounts into natural Khmer words:
// 100000 -> មួយសែន, 1000000 -> មួយលាន, 10000000 -> ដប់លាន, 100000000 -> មួយរយលាន
export function convertSentenceAmountsToKhmerWords(text: string): string {
  if (!text) return "";
  let res = text;
  // Match numbers (with commas or plain digits)
  res = res.replace(/(?<![a-zA-Z\\d])(\\d{1,3}(?:,\\d{3})+|\\d{4,})(?![a-zA-Z\\d])/g, (match) => {
    return numberToKhmerWords(match);
  });
  // Also match Khmer numerals (១០០០០០ -> មួយសែន)
  res = res.replace(/(?<![\\u1780-\\u17ff\\w])([\\u17e0-\\u17e9]{1,3}(?:,[\\u17e0-\\u17e9]{3})+|[\\u17e0-\\u17e9]{4,})(?![\\u1780-\\u17ff\\w])/g, (match) => {
    return numberToKhmerWords(match);
  });
  return res;
}`}
                    </pre>
                  </div>
                </div>
              )}

              {/* Tab 4: Studio Export & Deploy Guide */}
              {codeActiveTab === "export-guide" && (
                <div className="space-y-4">
                  <div className="bg-gradient-to-r from-sky-950/40 to-blue-950/20 border border-sky-800/40 rounded-xl p-5">
                    <h4 className="text-sm font-bold text-white mb-2 flex items-center gap-2">
                      <Globe className="w-4 h-4 text-sky-400" />
                      Two Ways to Export the Entire Project
                    </h4>
                    <p className="text-xs text-[#AAA] leading-relaxed mb-4">
                      You can download all source files directly using the in-app ZIP downloader or through Google AI Studio:
                    </p>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
                      <div className="bg-[#161616] border border-[#2B2B2B] rounded-lg p-3.5">
                        <div className="text-xs font-bold text-emerald-400 mb-1">Method 1: Direct In-App ZIP (Instant)</div>
                        <p className="text-[11px] text-[#CCC] mb-2">Click the green &quot;Download Source (.ZIP)&quot; button in the top navigation bar or the Download tab above to get all source files instantly.</p>
                        <a
                          href="/api/download-source-zip"
                          download="chinese-khmer-translator-source.zip"
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/20 border border-emerald-500/40 text-emerald-400 text-[11px] font-semibold hover:bg-emerald-500/30 transition-colors"
                        >
                          <Download className="w-3.5 h-3.5" />
                          <span>Download chinese-khmer-translator-source.zip</span>
                        </a>
                      </div>

                      <div className="bg-[#161616] border border-[#2B2B2B] rounded-lg p-3.5">
                        <div className="text-xs font-bold text-sky-400 mb-1">Method 2: Google AI Studio Header</div>
                        <ol className="list-decimal list-inside space-y-1 text-[11px] text-[#CCC]">
                          <li>Look at the <strong>top-right header</strong> of Google AI Studio.</li>
                          <li>Click the <strong>Code icon (&lt;/&gt;)</strong> or <strong>Export</strong> button.</li>
                          <li>Click <strong>&quot;Download ZIP&quot;</strong> or <strong>&quot;Push to GitHub&quot;</strong>.</li>
                        </ol>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="flex items-center justify-between px-6 py-3 border-t border-[#262626] bg-[#161616]">
              <span className="text-[11px] text-[#777]">Chinese-Khmer SRT Translator • Full-Stack Codebase Ready</span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleSafeBlobDownload("/api/download-app-html", "chinese-khmer-translator-app.html")}
                  className="px-3.5 py-1.5 rounded-lg text-xs font-bold bg-emerald-500 hover:bg-emerald-400 text-black transition-colors flex items-center gap-1.5"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Download HTML App</span>
                </button>
                <button
                  onClick={() => handleSafeBlobDownload("/api/download-all-code-html", "chinese-khmer-translator-all-code.html")}
                  className="px-3.5 py-1.5 rounded-lg text-xs font-bold bg-sky-500 hover:bg-sky-400 text-black transition-colors flex items-center gap-1.5"
                >
                  <FileText className="w-3.5 h-3.5" />
                  <span>All Code HTML</span>
                </button>
                <button
                  onClick={() => setShowCodeModal(false)}
                  className="px-4 py-1.5 rounded-lg text-xs font-semibold bg-[#262626] hover:bg-[#333] text-white transition-colors cursor-pointer"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
