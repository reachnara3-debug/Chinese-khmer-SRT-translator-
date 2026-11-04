import React, { useState, useRef, useEffect } from "react";
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize2,
  Minimize2,
  Film,
  Sparkles,
  Layers,
  Clock,
  FastForward,
  Rewind,
  X,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  Video,
  FileText,
  Sliders,
  Check,
} from "lucide-react";
import { SubtitleBlock } from "../types";
import { parseTimecodeToSeconds, shiftTimecodes } from "../utils/srtParser";
import { ExtractedTrack } from "../utils/videoSubtitleExtractor";

interface VideoPlayerStudioProps {
  videoFile: File | null;
  videoUrl: string | null;
  blocks: SubtitleBlock[];
  onBlocksChange: (blocks: SubtitleBlock[]) => void;
  extractedTracks?: ExtractedTrack[];
  onSelectTrack?: (track: ExtractedTrack) => void;
  onTranscribeVideo?: () => void;
  isTranscribing?: boolean;
  transcribeProgress?: { percent: number; message: string };
  onCloseVideo?: () => void;
  selectedBlockIndex?: number | null;
  onSelectBlock?: (index: number) => void;
  activeBlockIndex?: number | null;
}

export const VideoPlayerStudio: React.FC<VideoPlayerStudioProps> = ({
  videoFile,
  videoUrl,
  blocks,
  onBlocksChange,
  extractedTracks = [],
  onSelectTrack,
  onTranscribeVideo,
  isTranscribing = false,
  transcribeProgress,
  onCloseVideo,
  selectedBlockIndex,
  onSelectBlock,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [subtitleMode, setSubtitleMode] = useState<"khmer" | "bilingual" | "chinese">("bilingual");
  const [fontSize, setFontSize] = useState<"sm" | "md" | "lg">("md");
  const [currentSubtitle, setCurrentSubtitle] = useState<SubtitleBlock | null>(null);
  const [showSyncControls, setShowSyncControls] = useState(false);
  const [syncOffset, setSyncOffset] = useState(0);

  // Parse timecodes of all blocks into start/end seconds
  const blockTimings = React.useMemo(() => {
    return blocks.map((b) => {
      const parts = b.timecode.split("-->");
      if (parts.length !== 2) return { index: b.index, start: 0, end: 0, block: b };

      const parseTime = (str: string): number => {
        const cleanStr = str.trim().replace(",", ".");
        const hmsParts = cleanStr.split(":");
        if (hmsParts.length !== 3) return 0;
        const hrs = parseFloat(hmsParts[0]);
        const mins = parseFloat(hmsParts[1]);
        const secs = parseFloat(hmsParts[2]);
        return hrs * 3600 + mins * 60 + secs;
      };

      return {
        index: b.index,
        start: parseTime(parts[0]),
        end: parseTime(parts[1]),
        block: b,
      };
    });
  }, [blocks]);

  // Update current active subtitle based on video current time
  useEffect(() => {
    const active = blockTimings.find((t) => currentTime >= t.start && currentTime <= t.end);
    if (active) {
      setCurrentSubtitle(active.block);
    } else {
      setCurrentSubtitle(null);
    }
  }, [currentTime, blockTimings]);

  // Seek video when user clicks on a subtitle block externally
  useEffect(() => {
    if (selectedBlockIndex != null && videoRef.current) {
      const timing = blockTimings.find((t) => t.index === selectedBlockIndex);
      if (timing && Math.abs(videoRef.current.currentTime - timing.start) > 0.5) {
        videoRef.current.currentTime = timing.start;
        setCurrentTime(timing.start);
      }
    }
  }, [selectedBlockIndex, blockTimings]);

  const togglePlay = () => {
    if (!videoRef.current) return;
    if (videoRef.current.paused) {
      videoRef.current.play();
      setIsPlaying(true);
    } else {
      videoRef.current.pause();
      setIsPlaying(false);
    }
  };

  const handleTimeUpdate = () => {
    if (!videoRef.current) return;
    setCurrentTime(videoRef.current.currentTime);
  };

  const handleLoadedMetadata = () => {
    if (!videoRef.current) return;
    setDuration(videoRef.current.duration || 0);
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value);
    if (videoRef.current) {
      videoRef.current.currentTime = time;
      setCurrentTime(time);
    }
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    setVolume(val);
    if (videoRef.current) {
      videoRef.current.volume = val;
      videoRef.current.muted = val === 0;
      setIsMuted(val === 0);
    }
  };

  const toggleMute = () => {
    if (!videoRef.current) return;
    const nextMuted = !isMuted;
    setIsMuted(nextMuted);
    videoRef.current.muted = nextMuted;
  };

  const handleSpeedChange = (speed: number) => {
    setPlaybackRate(speed);
    if (videoRef.current) {
      videoRef.current.playbackRate = speed;
    }
  };

  const seekRelative = (sec: number) => {
    if (!videoRef.current) return;
    const next = Math.max(0, Math.min(duration, videoRef.current.currentTime + sec));
    videoRef.current.currentTime = next;
    setCurrentTime(next);
  };

  const applyOffset = (offsetSec: number) => {
    const updated = shiftTimecodes(blocks, offsetSec);
    onBlocksChange(updated);
    setSyncOffset((prev) => Math.round((prev + offsetSec) * 1000) / 1000);
  };

  const formatSeconds = (sec: number): string => {
    if (isNaN(sec)) return "00:00";
    const mins = Math.floor(sec / 60);
    const secs = Math.floor(sec % 60);
    return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  };

  if (!videoUrl) return null;

  return (
    <div
      id="video-player-studio"
      className="bg-[#18181A] border border-[#27272A] rounded-xl overflow-hidden shadow-2xl mb-6 transition-all duration-300"
    >
      {/* Header bar */}
      <div className="bg-[#202023] px-4 py-3 border-b border-[#27272A] flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="p-1.5 rounded-lg bg-[#FF9F0A]/10 text-[#FF9F0A] border border-[#FF9F0A]/20">
            <Film className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-[#EBEBEB] truncate max-w-[200px] sm:max-w-md">
                {videoFile?.name || "Video Preview Player"}
              </span>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 font-medium border border-emerald-500/20">
                Synced ({blocks.length} subs)
              </span>
            </div>
            <p className="text-[11px] text-[#A1A1AA] truncate">
              Live Subtitle Preview & Synchronization Studio
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {extractedTracks.length > 1 && (
            <div className="relative inline-block">
              <select
                id="video-track-selector"
                className="bg-[#27272A] text-xs text-[#EBEBEB] border border-[#3F3F46] rounded-lg px-2.5 py-1 pr-6 cursor-pointer focus:outline-none focus:border-[#FF9F0A]"
                onChange={(e) => {
                  const trk = extractedTracks.find((t) => String(t.id) === e.target.value);
                  if (trk && onSelectTrack) onSelectTrack(trk);
                }}
                defaultValue={extractedTracks[0]?.id}
              >
                {extractedTracks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.language ? `Track: ${t.language}` : t.title} ({t.type.toUpperCase()})
                  </option>
                ))}
              </select>
            </div>
          )}

          {onTranscribeVideo && (
            <button
              id="btn-transcribe-video"
              onClick={onTranscribeVideo}
              disabled={isTranscribing}
              className="flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1.5 rounded-lg bg-[#FF9F0A]/10 text-[#FF9F0A] hover:bg-[#FF9F0A]/20 border border-[#FF9F0A]/30 transition disabled:opacity-50"
              title="Transcribe speech in this video directly with Gemini AI"
            >
              <Sparkles className={`h-3.5 w-3.5 ${isTranscribing ? "animate-spin" : ""}`} />
              <span className="hidden sm:inline">
                {isTranscribing ? "Transcribing..." : "AI Transcribe Video"}
              </span>
            </button>
          )}

          <button
            id="btn-toggle-collapse-video"
            onClick={() => setIsCollapsed(!isCollapsed)}
            className="p-1.5 text-[#A1A1AA] hover:text-[#EBEBEB] hover:bg-[#27272A] rounded-lg transition"
            title={isCollapsed ? "Expand video player" : "Collapse video player"}
          >
            {isCollapsed ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
          </button>

          {onCloseVideo && (
            <button
              id="btn-close-video"
              onClick={onCloseVideo}
              className="p-1.5 text-[#A1A1AA] hover:text-red-400 hover:bg-[#27272A] rounded-lg transition"
              title="Close video"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* Progress banner during transcription */}
      {isTranscribing && transcribeProgress && (
        <div className="bg-[#27272A]/80 px-4 py-2.5 border-b border-[#3F3F46] flex items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2 text-[#FF9F0A]">
            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            <span>{transcribeProgress.message}</span>
          </div>
          <div className="w-32 bg-[#18181A] rounded-full h-2 overflow-hidden border border-[#3F3F46]">
            <div
              className="bg-[#FF9F0A] h-full transition-all duration-300"
              style={{ width: `${transcribeProgress.percent}%` }}
            />
          </div>
        </div>
      )}

      {/* Collapsed state */}
      {!isCollapsed && (
        <div className="p-4 space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
            {/* Video Stage & Overlays */}
            <div className="lg:col-span-8 space-y-3">
              <div className="relative bg-black rounded-lg overflow-hidden border border-[#27272A] aspect-video flex items-center justify-center group shadow-inner">
                <video
                  ref={videoRef}
                  src={videoUrl}
                  onTimeUpdate={handleTimeUpdate}
                  onLoadedMetadata={handleLoadedMetadata}
                  onEnded={() => setIsPlaying(false)}
                  onClick={togglePlay}
                  className="w-full h-full object-contain cursor-pointer"
                />

                {/* Video Subtitle Overlay */}
                {currentSubtitle && (
                  <div
                    className={`absolute bottom-6 inset-x-4 flex flex-col items-center justify-center pointer-events-none transition-all duration-150 text-center px-3`}
                  >
                    <div className="bg-black/85 backdrop-blur-md px-4 py-2 rounded-lg border border-white/10 max-w-[90%] shadow-2xl space-y-1">
                      {/* Chinese text */}
                      {(subtitleMode === "chinese" || subtitleMode === "bilingual") && (
                        <p
                          className={`font-medium text-[#D4D4D8] leading-tight ${
                            fontSize === "sm" ? "text-xs" : fontSize === "lg" ? "text-base" : "text-sm"
                          }`}
                        >
                          {currentSubtitle.text}
                        </p>
                      )}

                      {/* Khmer translated text */}
                      {(subtitleMode === "khmer" || subtitleMode === "bilingual") && (
                        <p
                          className={`font-semibold text-[#FFD60A] leading-snug tracking-wide ${
                            fontSize === "sm"
                              ? "text-sm"
                              : fontSize === "lg"
                              ? "text-xl font-bold"
                              : "text-base font-bold"
                          }`}
                        >
                          {currentSubtitle.translatedText || (
                            <span className="text-zinc-500 italic text-xs font-normal">
                              (Translating...)
                            </span>
                          )}
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {/* Big Center Play/Pause button on hover */}
                {!isPlaying && (
                  <button
                    onClick={togglePlay}
                    className="absolute inset-auto p-4 rounded-full bg-black/60 hover:bg-[#FF9F0A] text-white hover:text-black border border-white/20 transition transform hover:scale-110 shadow-2xl"
                  >
                    <Play className="h-7 w-7 fill-current ml-0.5" />
                  </button>
                )}
              </div>

              {/* Video Timeline & Controls */}
              <div className="bg-[#202023] p-3 rounded-lg border border-[#27272A] space-y-2.5">
                {/* Timeline Scrubber */}
                <div className="flex items-center gap-3">
                  <span className="text-[11px] font-mono text-[#A1A1AA] w-12 text-right">
                    {formatSeconds(currentTime)}
                  </span>
                  <input
                    id="video-timeline-scrubber"
                    type="range"
                    min={0}
                    max={duration || 100}
                    step={0.1}
                    value={currentTime}
                    onChange={handleSeek}
                    className="flex-1 accent-[#FF9F0A] h-1.5 bg-[#27272A] rounded-lg cursor-pointer transition"
                  />
                  <span className="text-[11px] font-mono text-[#71717A] w-12">
                    {formatSeconds(duration)}
                  </span>
                </div>

                {/* Playback action bar */}
                <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-[#27272A]">
                  <div className="flex items-center gap-2">
                    <button
                      id="btn-video-play-pause"
                      onClick={togglePlay}
                      className="p-1.5 rounded-lg bg-[#FF9F0A] text-black hover:bg-[#FFB020] transition font-bold"
                      title={isPlaying ? "Pause" : "Play"}
                    >
                      {isPlaying ? (
                        <Pause className="h-4 w-4 fill-current" />
                      ) : (
                        <Play className="h-4 w-4 fill-current ml-0.5" />
                      )}
                    </button>

                    <button
                      onClick={() => seekRelative(-5)}
                      className="p-1.5 text-[#A1A1AA] hover:text-[#EBEBEB] hover:bg-[#27272A] rounded-lg transition"
                      title="Rewind 5s"
                    >
                      <Rewind className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => seekRelative(5)}
                      className="p-1.5 text-[#A1A1AA] hover:text-[#EBEBEB] hover:bg-[#27272A] rounded-lg transition"
                      title="Forward 5s"
                    >
                      <FastForward className="h-4 w-4" />
                    </button>

                    <div className="flex items-center gap-1.5 pl-2 border-l border-[#27272A]">
                      <button
                        onClick={toggleMute}
                        className="p-1.5 text-[#A1A1AA] hover:text-[#EBEBEB] rounded-lg transition"
                      >
                        {isMuted || volume === 0 ? (
                          <VolumeX className="h-4 w-4 text-red-400" />
                        ) : (
                          <Volume2 className="h-4 w-4" />
                        )}
                      </button>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={isMuted ? 0 : volume}
                        onChange={handleVolumeChange}
                        className="w-16 accent-[#FF9F0A] h-1 bg-[#27272A] rounded cursor-pointer"
                      />
                    </div>
                  </div>

                  {/* Right side controls: Subtitle mode, Font size, Speed, Sync */}
                  <div className="flex items-center gap-2">
                    {/* Subtitle Overlay Language Toggle */}
                    <div className="flex items-center bg-[#18181A] p-0.5 rounded-lg border border-[#27272A] text-[11px]">
                      <button
                        onClick={() => setSubtitleMode("bilingual")}
                        className={`px-2 py-0.5 rounded-md font-medium transition ${
                          subtitleMode === "bilingual"
                            ? "bg-[#FF9F0A] text-black font-semibold"
                            : "text-[#A1A1AA] hover:text-[#EBEBEB]"
                        }`}
                      >
                        Bilingual
                      </button>
                      <button
                        onClick={() => setSubtitleMode("khmer")}
                        className={`px-2 py-0.5 rounded-md font-medium transition ${
                          subtitleMode === "khmer"
                            ? "bg-[#FF9F0A] text-black font-semibold"
                            : "text-[#A1A1AA] hover:text-[#EBEBEB]"
                        }`}
                      >
                        Khmer
                      </button>
                      <button
                        onClick={() => setSubtitleMode("chinese")}
                        className={`px-2 py-0.5 rounded-md font-medium transition ${
                          subtitleMode === "chinese"
                            ? "bg-[#FF9F0A] text-black font-semibold"
                            : "text-[#A1A1AA] hover:text-[#EBEBEB]"
                        }`}
                      >
                        Chinese
                      </button>
                    </div>

                    {/* Speed selector */}
                    <select
                      value={playbackRate}
                      onChange={(e) => handleSpeedChange(parseFloat(e.target.value))}
                      className="bg-[#18181A] border border-[#27272A] text-[11px] text-[#EBEBEB] rounded-lg px-2 py-1 cursor-pointer focus:outline-none"
                    >
                      <option value={0.75}>0.75x</option>
                      <option value={1}>1.0x</option>
                      <option value={1.25}>1.25x</option>
                      <option value={1.5}>1.5x</option>
                      <option value={2}>2.0x</option>
                    </select>

                    {/* Sync adjuster toggle */}
                    <button
                      id="btn-toggle-sync-adjust"
                      onClick={() => setShowSyncControls(!showSyncControls)}
                      className={`flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg border transition ${
                        showSyncControls
                          ? "bg-[#FF9F0A]/10 text-[#FF9F0A] border-[#FF9F0A]/40 font-semibold"
                          : "bg-[#18181A] text-[#A1A1AA] border-[#27272A] hover:text-[#EBEBEB]"
                      }`}
                      title="Adjust subtitle timestamp sync offset"
                    >
                      <Clock className="h-3 w-3" />
                      <span>Sync {syncOffset !== 0 ? `(${syncOffset > 0 ? "+" : ""}${syncOffset}s)` : ""}</span>
                    </button>
                  </div>
                </div>

                {/* Subtitle Offset Adjustment Bar */}
                {showSyncControls && (
                  <div className="mt-2 pt-2 border-t border-[#27272A] flex flex-wrap items-center justify-between gap-2 text-xs bg-[#18181A] p-2.5 rounded-lg">
                    <div className="flex items-center gap-1.5 text-[#A1A1AA]">
                      <Sliders className="h-3.5 w-3.5 text-[#FF9F0A]" />
                      <span className="font-semibold text-[#EBEBEB]">Subtitle Timecode Sync Shift:</span>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => applyOffset(-0.5)}
                        className="px-2 py-1 rounded bg-[#27272A] hover:bg-[#3F3F46] text-[#EBEBEB] font-mono text-[11px] border border-[#3F3F46]"
                      >
                        -0.5s
                      </button>
                      <button
                        onClick={() => applyOffset(-0.1)}
                        className="px-2 py-1 rounded bg-[#27272A] hover:bg-[#3F3F46] text-[#EBEBEB] font-mono text-[11px] border border-[#3F3F46]"
                      >
                        -0.1s
                      </button>
                      <span className="font-mono text-xs font-bold text-[#FF9F0A] px-2">
                        {syncOffset > 0 ? `+${syncOffset}` : syncOffset}s
                      </span>
                      <button
                        onClick={() => applyOffset(0.1)}
                        className="px-2 py-1 rounded bg-[#27272A] hover:bg-[#3F3F46] text-[#EBEBEB] font-mono text-[11px] border border-[#3F3F46]"
                      >
                        +0.1s
                      </button>
                      <button
                        onClick={() => applyOffset(0.5)}
                        className="px-2 py-1 rounded bg-[#27272A] hover:bg-[#3F3F46] text-[#EBEBEB] font-mono text-[11px] border border-[#3F3F46]"
                      >
                        +0.5s
                      </button>
                      {syncOffset !== 0 && (
                        <button
                          onClick={() => applyOffset(-syncOffset)}
                          className="px-2 py-1 rounded bg-red-500/10 hover:bg-red-500/20 text-red-400 text-[11px] border border-red-500/30 ml-2"
                        >
                          Reset
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Subtitle Cue List & Click-to-Jump Navigator */}
            <div className="lg:col-span-4 bg-[#202023] rounded-lg border border-[#27272A] p-3 flex flex-col h-[380px]">
              <div className="flex items-center justify-between pb-2 mb-2 border-b border-[#27272A]">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-[#EBEBEB]">
                  <Layers className="h-3.5 w-3.5 text-[#FF9F0A]" />
                  <span>Subtitle Cues ({blocks.length})</span>
                </div>
                <span className="text-[10px] text-[#71717A]">Click line to jump video</span>
              </div>

              <div className="flex-1 overflow-y-auto space-y-1.5 pr-1 custom-scrollbar">
                {blocks.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-center p-4 text-[#71717A] text-xs">
                    <FileText className="h-8 w-8 text-[#3F3F46] mb-2" />
                    <p>No subtitles found in this video.</p>
                    {onTranscribeVideo && (
                      <button
                        onClick={onTranscribeVideo}
                        className="mt-3 text-xs px-3 py-1.5 rounded-lg bg-[#FF9F0A] text-black font-semibold hover:bg-[#FFB020] transition"
                      >
                        Extract with AI Transcribe
                      </button>
                    )}
                  </div>
                ) : (
                  blocks.map((b) => {
                    const isActive = currentSubtitle?.index === b.index;
                    return (
                      <div
                        key={b.index}
                        onClick={() => {
                          if (onSelectBlock) onSelectBlock(b.index);
                          const timing = blockTimings.find((t) => t.index === b.index);
                          if (timing && videoRef.current) {
                            videoRef.current.currentTime = timing.start;
                            setCurrentTime(timing.start);
                          }
                        }}
                        className={`p-2 rounded-lg text-xs cursor-pointer border transition-all duration-150 ${
                          isActive
                            ? "bg-[#FF9F0A]/15 border-[#FF9F0A] text-[#EBEBEB] shadow-md ring-1 ring-[#FF9F0A]/50"
                            : "bg-[#18181A] border-[#27272A] text-[#A1A1AA] hover:bg-[#27272A] hover:text-[#EBEBEB]"
                        }`}
                      >
                        <div className="flex items-center justify-between text-[10px] mb-1">
                          <span
                            className={`font-bold font-mono ${
                              isActive ? "text-[#FF9F0A]" : "text-[#71717A]"
                            }`}
                          >
                            #{b.index} {b.timecode}
                          </span>
                          {isActive && (
                            <span className="flex items-center gap-1 text-[#FF9F0A] font-semibold text-[9px] uppercase tracking-wider">
                              <span className="h-1.5 w-1.5 rounded-full bg-[#FF9F0A] animate-ping" />
                              Playing
                            </span>
                          )}
                        </div>
                        <p className="font-medium text-[#EBEBEB] line-clamp-1 mb-0.5">{b.text}</p>
                        <p
                          className={`line-clamp-1 ${
                            b.translatedText ? "text-emerald-400 font-medium" : "text-[#71717A] italic"
                          }`}
                        >
                          {b.translatedText || "(Untranslated)"}
                        </p>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
