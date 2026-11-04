import { SubtitleBlock } from "../types";
import { parseSRT, parseVTT, parseASS } from "./srtParser";

export interface ExtractedTrack {
  id: number;
  trackNumber: number;
  type: "srt" | "ass" | "vtt" | "text";
  language?: string;
  title?: string;
  codecId?: string;
  blocks: SubtitleBlock[];
  rawText: string;
}

/**
 * Reads variable-length integer (VINT) for EBML Matroska files
 */
function readEbmlVint(view: DataView, offset: number): { value: number; length: number; rawValue: number } | null {
  if (offset >= view.byteLength) return null;
  const firstByte = view.getUint8(offset);
  if (firstByte === 0) return null;

  let length = 1;
  let mask = 0x80;
  while ((firstByte & mask) === 0 && length <= 8) {
    mask >>= 1;
    length++;
  }

  if (length > 8 || offset + length > view.byteLength) return null;

  let value = firstByte & (mask - 1);
  let rawValue = firstByte;
  for (let i = 1; i < length; i++) {
    const nextByte = view.getUint8(offset + i);
    value = (value * 256) + nextByte;
    rawValue = (rawValue * 256) + nextByte;
  }

  return { value, length, rawValue };
}

/**
 * Format milliseconds to standard SRT timecode (00:00:00,000)
 */
function formatMsToSRT(ms: number): string {
  if (isNaN(ms) || ms < 0) ms = 0;
  const totalSeconds = Math.floor(ms / 1000);
  const millis = Math.floor(ms % 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

/**
 * Parse embedded subtitles from Matroska (.mkv, .webm) video container
 */
export async function extractSubtitlesFromMKV(file: File): Promise<ExtractedTrack[]> {
  try {
    const buffer = await file.arrayBuffer();
    const view = new DataView(buffer);
    const decoder = new TextDecoder("utf-8");

    let offset = 0;
    const tracks: Map<number, {
      trackNumber: number;
      type: "srt" | "ass" | "vtt" | "text";
      codecId: string;
      language?: string;
      name?: string;
    }> = new Map();

    let timecodeScale = 1000000; // default 1ms in nanoseconds
    let currentClusterTimecode = 0;
    const subtitleEvents: { trackNumber: number; startTimeMs: number; durationMs: number; text: string }[] = [];

    // Helper to read ID
    function readElementId(off: number): { id: number; length: number } | null {
      if (off >= view.byteLength) return null;
      const b0 = view.getUint8(off);
      if ((b0 & 0x80) !== 0) return { id: b0, length: 1 };
      if ((b0 & 0x40) !== 0 && off + 1 < view.byteLength) return { id: (b0 << 8) | view.getUint8(off + 1), length: 2 };
      if ((b0 & 0x20) !== 0 && off + 2 < view.byteLength) return { id: (b0 << 16) | (view.getUint8(off + 1) << 8) | view.getUint8(off + 2), length: 3 };
      if ((b0 & 0x10) !== 0 && off + 3 < view.byteLength) return { id: (b0 << 24) | (view.getUint8(off + 1) << 16) | (view.getUint8(off + 2) << 8) | view.getUint8(off + 3), length: 4 };
      return null;
    }

    // Traverse top-level elements (Segment, Tracks, Cluster)
    while (offset < view.byteLength - 4) {
      const elem = readElementId(offset);
      if (!elem) {
        offset++;
        continue;
      }

      offset += elem.length;
      const sizeVint = readEbmlVint(view, offset);
      if (!sizeVint) break;
      offset += sizeVint.length;
      const elemSize = sizeVint.value;
      const elemEnd = offset + elemSize;

      // 0x18538067 = Segment
      if (elem.id === 0x18538067) {
        continue; // Descend into Segment
      }

      // 0x1549A966 = Info (TimecodeScale)
      if (elem.id === 0x1549A966) {
        let infoOff = offset;
        while (infoOff < elemEnd && infoOff < view.byteLength) {
          const sub = readElementId(infoOff);
          if (!sub) break;
          infoOff += sub.length;
          const sz = readEbmlVint(view, infoOff);
          if (!sz) break;
          infoOff += sz.length;
          // 0x2AD7B1 = TimestampScale / TimecodeScale
          if (sub.id === 0x2AD7B1) {
            if (sz.value === 4) timecodeScale = view.getUint32(infoOff);
            else if (sz.value === 8) timecodeScale = Number(view.getBigUint64(infoOff));
          }
          infoOff += sz.value;
        }
        offset = elemEnd;
        continue;
      }

      // 0x1654AE6B = Tracks
      if (elem.id === 0x1654AE6B) {
        let trackOff = offset;
        while (trackOff < elemEnd && trackOff < view.byteLength) {
          const trackSub = readElementId(trackOff);
          if (!trackSub) break;
          trackOff += trackSub.length;
          const trackSz = readEbmlVint(view, trackOff);
          if (!trackSz) break;
          trackOff += trackSz.length;
          const trackEntryEnd = trackOff + trackSz.value;

          // 0xAE = TrackEntry
          if (trackSub.id === 0xAE) {
            let tNumber = 0;
            let tType = 0;
            let codecId = "";
            let language = "";
            let name = "";

            let entryOff = trackOff;
            while (entryOff < trackEntryEnd && entryOff < view.byteLength) {
              const item = readElementId(entryOff);
              if (!item) break;
              entryOff += item.length;
              const itemSz = readEbmlVint(view, entryOff);
              if (!itemSz) break;
              entryOff += itemSz.length;

              // 0xD7 = TrackNumber
              if (item.id === 0xD7) {
                tNumber = itemSz.value === 1 ? view.getUint8(entryOff) : view.getUint16(entryOff);
              }
              // 0x83 = TrackType (17 = Subtitle)
              else if (item.id === 0x83) {
                tType = itemSz.value === 1 ? view.getUint8(entryOff) : view.getUint16(entryOff);
              }
              // 0x86 = CodecID
              else if (item.id === 0x86) {
                const codecBytes = new Uint8Array(buffer, entryOff, itemSz.value);
                codecId = decoder.decode(codecBytes).replace(/\0/g, "");
              }
              // 0x22B59C = Language
              else if (item.id === 0x22B59C) {
                const langBytes = new Uint8Array(buffer, entryOff, itemSz.value);
                language = decoder.decode(langBytes).replace(/\0/g, "");
              }
              // 0x536E = Name
              else if (item.id === 0x536E) {
                const nameBytes = new Uint8Array(buffer, entryOff, itemSz.value);
                name = decoder.decode(nameBytes).replace(/\0/g, "");
              }

              entryOff += itemSz.value;
            }

            // TrackType 17 = Subtitle (0x11)
            if (tType === 17 || codecId.startsWith("S_TEXT") || codecId.startsWith("S_ASS") || codecId.startsWith("S_SSA") || codecId.startsWith("S_VOBSUB")) {
              let subType: "srt" | "ass" | "vtt" | "text" = "srt";
              if (codecId.includes("ASS") || codecId.includes("SSA")) subType = "ass";
              else if (codecId.includes("WEBVTT")) subType = "vtt";

              tracks.set(tNumber, {
                trackNumber: tNumber,
                type: subType,
                codecId,
                language,
                name
              });
            }
          }

          trackOff = trackEntryEnd;
        }

        offset = elemEnd;
        continue;
      }

      // 0x1F43B675 = Cluster
      if (elem.id === 0x1F43B675) {
        let clusterOff = offset;
        while (clusterOff < elemEnd && clusterOff < view.byteLength) {
          const cSub = readElementId(clusterOff);
          if (!cSub) break;
          clusterOff += cSub.length;
          const cSz = readEbmlVint(view, clusterOff);
          if (!cSz) break;
          clusterOff += cSz.length;
          const cItemEnd = clusterOff + cSz.value;

          // 0xE7 = Cluster Timestamp / Timecode
          if (cSub.id === 0xE7) {
            if (cSz.value === 1) currentClusterTimecode = view.getUint8(clusterOff);
            else if (cSz.value === 2) currentClusterTimecode = view.getUint16(clusterOff);
            else if (cSz.value === 4) currentClusterTimecode = view.getUint32(clusterOff);
          }
          // 0xA3 = SimpleBlock or 0xA0 = BlockGroup
          else if (cSub.id === 0xA3 || cSub.id === 0xA0) {
            let blockDataOffset = clusterOff;
            let blockDurationMs = 3000; // default 3s if duration not specified

            if (cSub.id === 0xA0) {
              // Read BlockGroup children (0xA1 = Block, 0x9B = BlockDuration)
              let bgOff = clusterOff;
              while (bgOff < cItemEnd && bgOff < view.byteLength) {
                const bgSub = readElementId(bgOff);
                if (!bgSub) break;
                bgOff += bgSub.length;
                const bgSz = readEbmlVint(view, bgOff);
                if (!bgSz) break;
                bgOff += bgSz.length;

                if (bgSub.id === 0xA1) {
                  blockDataOffset = bgOff;
                } else if (bgSub.id === 0x9B) {
                  let dVal = 0;
                  if (bgSz.value === 1) dVal = view.getUint8(bgOff);
                  else if (bgSz.value === 2) dVal = view.getUint16(bgOff);
                  else if (bgSz.value === 4) dVal = view.getUint32(bgOff);
                  blockDurationMs = (dVal * timecodeScale) / 1000000;
                }
                bgOff += bgSz.value;
              }
            }

            // Parse Block header
            if (blockDataOffset < view.byteLength) {
              const trackNumVint = readEbmlVint(view, blockDataOffset);
              if (trackNumVint && tracks.has(trackNumVint.value)) {
                const trkNum = trackNumVint.value;
                const relTimecode = view.getInt16(blockDataOffset + trackNumVint.length);
                const flags = view.getUint8(blockDataOffset + trackNumVint.length + 2);
                const headerSize = trackNumVint.length + 3;

                const payloadOffset = blockDataOffset + headerSize;
                const payloadSize = cItemEnd - payloadOffset;

                if (payloadSize > 0 && payloadOffset + payloadSize <= view.byteLength) {
                  const payloadBytes = new Uint8Array(buffer, payloadOffset, payloadSize);
                  let text = decoder.decode(payloadBytes).trim();

                  // For ASS subtitles in Matroska, line format is often: ReadOrder, Layer, Style, Name, MarginL, MarginR, MarginV, Effect, Text
                  if (tracks.get(trkNum)?.type === "ass") {
                    const parts = text.split(",");
                    if (parts.length >= 9) {
                      text = parts.slice(8).join(",").trim();
                    }
                  }

                  // Strip ASS tags like {\an8} or {\pos(x,y)}
                  text = text.replace(/\{[^\}]+\}/g, "").replace(/\\N/g, "\n").trim();

                  if (text.length > 0) {
                    const startTimeMs = ((currentClusterTimecode + relTimecode) * timecodeScale) / 1000000;
                    subtitleEvents.push({
                      trackNumber: trkNum,
                      startTimeMs: Math.max(0, startTimeMs),
                      durationMs: Math.max(500, blockDurationMs),
                      text
                    });
                  }
                }
              }
            }
          }

          clusterOff = cItemEnd;
        }

        offset = elemEnd;
        continue;
      }

      offset = elemEnd;
    }

    // Assemble extracted events into ExtractedTrack list
    const results: ExtractedTrack[] = [];

    tracks.forEach((meta, trkNum) => {
      const events = subtitleEvents.filter(e => e.trackNumber === trkNum);
      if (events.length > 0) {
        // Sort chronologically
        events.sort((a, b) => a.startTimeMs - b.startTimeMs);

        const blocks: SubtitleBlock[] = events.map((ev, i) => {
          const startStr = formatMsToSRT(ev.startTimeMs);
          const endStr = formatMsToSRT(ev.startTimeMs + ev.durationMs);
          const hasLetters = /[a-zA-Z\u4e00-\u9fa5\d]/.test(ev.text);

          return {
            index: i + 1,
            timecode: `${startStr} --> ${endStr}`,
            text: ev.text,
            translatedText: "",
            status: hasLetters ? "pending" : "done"
          };
        });

        const rawSRT = blocks.map(b => `${b.index}\n${b.timecode}\n${b.text}`).join("\n\n");

        results.push({
          id: trkNum,
          trackNumber: trkNum,
          type: meta.type,
          language: meta.language || (meta.name ? meta.name : `Track ${trkNum}`),
          title: meta.name || `${meta.codecId} (Track ${trkNum})`,
          codecId: meta.codecId,
          blocks,
          rawText: rawSRT
        });
      }
    });

    return results;
  } catch (err) {
    console.warn("Could not extract Matroska subtitles:", err);
    return [];
  }
}

/**
 * Checks if a file is a video file by extension or MIME type
 */
export function isVideoFile(file: File): boolean {
  if (!file) return false;
  if (file.type && file.type.startsWith("video/")) return true;
  const name = file.name.toLowerCase();
  return (
    name.endsWith(".mp4") ||
    name.endsWith(".mkv") ||
    name.endsWith(".webm") ||
    name.endsWith(".mov") ||
    name.endsWith(".avi") ||
    name.endsWith(".m4v") ||
    name.endsWith(".ts") ||
    name.endsWith(".flv") ||
    name.endsWith(".wmv")
  );
}

/**
 * Extracts compact mono 16kHz WAV audio from a video file in-browser for AI Speech Transcription
 */
export async function extractAudioFromVideoFile(
  file: File,
  maxDurationSeconds = 300,
  onProgress?: (percent: number, message: string) => void
): Promise<{ base64Wav: string; durationSec: number }> {
  onProgress?.(10, "Decoding audio track from video...");
  const arrayBuffer = await file.arrayBuffer();

  onProgress?.(30, "Processing audio stream...");
  const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
  
  let audioBuffer: AudioBuffer;
  try {
    audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
  } catch (e) {
    audioContext.close();
    throw new Error("Could not decode audio from video file. Ensure the video contains a supported audio stream.");
  }

  const durationSec = Math.min(audioBuffer.duration, maxDurationSeconds);
  const targetSampleRate = 16000;
  const lengthSamples = Math.floor(durationSec * targetSampleRate);

  onProgress?.(60, "Resampling to 16kHz mono audio...");
  const offlineCtx = new OfflineAudioContext(1, lengthSamples, targetSampleRate);
  const source = offlineCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(offlineCtx.destination);
  source.start(0);

  const renderedBuffer = await offlineCtx.startRendering();
  audioContext.close();

  onProgress?.(85, "Encoding WAV payload for AI analysis...");
  const pcmData = renderedBuffer.getChannelData(0);
  const wavBytes = encodeWAVMono16Bit(pcmData, targetSampleRate);

  // Convert to base64
  let binary = "";
  const len = wavBytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(wavBytes[i]);
  }
  const base64Wav = btoa(binary);

  onProgress?.(100, "Audio ready for transcription!");
  return { base64Wav, durationSec };
}

/**
 * Encodes Float32Array into 16-bit PCM WAV ArrayBuffer
 */
function encodeWAVMono16Bit(samples: Float32Array, sampleRate: number): Uint8Array {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  function writeString(offset: number, str: string) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  // RIFF chunk descriptor
  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, "WAVE");

  // fmt sub-chunk
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // SubChunk1Size (16 for PCM)
  view.setUint16(20, 1, true); // AudioFormat (1 for PCM)
  view.setUint16(22, 1, true); // NumChannels (1 = mono)
  view.setUint32(24, sampleRate, true); // SampleRate
  view.setUint32(28, sampleRate * 2, true); // ByteRate
  view.setUint16(32, 2, true); // BlockAlign
  view.setUint16(34, 16, true); // BitsPerSample

  // data sub-chunk
  writeString(36, "data");
  view.setUint32(40, samples.length * 2, true);

  // Write PCM samples
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return new Uint8Array(buffer);
}
