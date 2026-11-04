import fs from "fs";
import path from "path";

/**
 * Generates an interactive single-file HTML document containing 100% of the project's source code.
 * Users can view all code, search, copy individual files or functions, and save it anywhere.
 */
export function generateAllCodeHtml(projectRoot: string): string {
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
    const files = ${filesJson};
    let activeIndex = 0;

    function renderSidebar() {
      const list = document.getElementById("fileList");
      list.innerHTML = "";
      files.forEach((f, idx) => {
        const item = document.createElement("div");
        item.className = "file-item" + (idx === activeIndex ? " active" : "");
        item.onclick = () => selectFile(idx);
        item.innerHTML = \`
          <div class="file-name">\${f.path}</div>
          <div class="file-desc">\${f.desc}</div>
          <div class="file-lines">\${f.lineCount} lines</div>
        \`;
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
      let combined = "// CHINESE-KHMER SUBTITLE TRANSLATOR - FULL SOURCE REPOSITORY\\n\\n";
      files.forEach(f => {
        combined += "/* ==========================================================================\\n";
        combined += "   FILE: " + f.path + "\\n";
        combined += "   ========================================================================== */\\n\\n";
        combined += f.content + "\\n\\n";
      });
      navigator.clipboard.writeText(combined).then(() => {
        showToast("Copied all 11 repository files to clipboard!");
      });
    }

    // Initialize
    selectFile(0);
  </script>
</body>
</html>`;
}

/**
 * Generates a self-contained, standalone single-file HTML Application.
 * Anyone who downloads this file can simply double-click it in ANY browser
 * and run the subtitle studio, video player, amount-to-Khmer words converter,
 * and Gemini AI translation without needing Node.js or a server!
 */
export function generateStandaloneAppHtml(): string {
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
    ::-webkit-scrollbar-thumb:hover { background: #444; }
  </style>
</head>
<body class="min-h-screen flex flex-col antialiased">
  <!-- Top Bar -->
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
        <input id="userApiKey" type="password" placeholder="AIzaSy..." class="bg-transparent text-white font-mono text-xs focus:outline-none w-36" onchange="saveApiKey(this.value)">
      </div>
      <button onclick="handleExportSRT()" class="px-3 py-1.5 bg-[#FF9F0A] hover:bg-[#e68e09] text-black font-semibold text-xs rounded-lg transition-colors">
        Export .SRT
      </button>
      <button onclick="handleExportVTT()" class="px-3 py-1.5 bg-[#222] hover:bg-[#2A2A2A] text-white font-medium text-xs rounded-lg transition-colors border border-[#333]">
        Export .VTT
      </button>
    </div>
  </header>

  <!-- Main Workspace -->
  <main class="flex-1 p-6 max-w-7xl w-full mx-auto grid grid-cols-1 lg:grid-cols-12 gap-6">
    <!-- Left Column: Controls & Video Player -->
    <div class="lg:col-span-5 space-y-4">
      <!-- File Loader Card -->
      <div class="bg-[#141414] border border-[#242424] rounded-xl p-4 space-y-3">
        <div class="text-xs font-bold text-white uppercase tracking-wider">Load Subtitle or Video</div>
        <div class="grid grid-cols-2 gap-2">
          <label class="flex flex-col items-center justify-center p-4 border border-dashed border-[#333] hover:border-sky-500 rounded-lg cursor-pointer bg-[#0D0D0D] transition-colors">
            <span class="text-xs text-sky-400 font-semibold mb-1">📄 Load SRT / VTT</span>
            <span class="text-[10px] text-[#777]">Upload subtitle file</span>
            <input type="file" accept=".srt,.vtt,.txt" class="hidden" onchange="handleSubtitleFileUpload(event)">
          </label>
          <label class="flex flex-col items-center justify-center p-4 border border-dashed border-[#333] hover:border-emerald-500 rounded-lg cursor-pointer bg-[#0D0D0D] transition-colors">
            <span class="text-xs text-emerald-400 font-semibold mb-1">🎬 Load Video</span>
            <span class="text-[10px] text-[#777]">MP4, WebM, MKV</span>
            <input type="file" accept="video/*" class="hidden" onchange="handleVideoFileUpload(event)">
          </label>
        </div>
      </div>

      <!-- Video Player Studio -->
      <div class="bg-[#141414] border border-[#242424] rounded-xl p-3 relative overflow-hidden">
        <div class="relative bg-black rounded-lg aspect-video flex items-center justify-center overflow-hidden">
          <video id="videoPlayer" class="w-full h-full object-contain" ontimeupdate="handleVideoTimeUpdate()"></video>
          <div id="videoPlaceholder" class="text-center text-xs text-[#555] p-4">
            Upload a video above to sync subtitles with video playback
          </div>
          <!-- Karaoke Subtitle Overlay -->
          <div id="subtitleOverlay" class="absolute bottom-4 left-4 right-4 text-center pointer-events-none text-white font-bold text-sm bg-black/75 px-3 py-1.5 rounded-lg border border-white/10 hidden khmer-font">
          </div>
        </div>
      </div>

      <!-- Quick Actions -->
      <div class="bg-[#141414] border border-[#242424] rounded-xl p-4 space-y-2">
        <div class="text-xs font-bold text-white uppercase tracking-wider mb-2">Automated Khmer Cleaners</div>
        <button onclick="cleanAllAmounts()" class="w-full text-left px-3 py-2 rounded-lg bg-[#1A1A1A] hover:bg-[#222] border border-[#2A2A2A] text-xs text-amber-300 font-medium transition-colors flex items-center justify-between">
          <span>✨ Convert Amount Numbers to Khmer Words</span>
          <span class="text-[10px] text-[#777]">100000 ➔ មួយសែន</span>
        </button>
        <button onclick="cleanForeignScripts()" class="w-full text-left px-3 py-2 rounded-lg bg-[#1A1A1A] hover:bg-[#222] border border-[#2A2A2A] text-xs text-sky-300 font-medium transition-colors flex items-center justify-between">
          <span>🧹 Purge Burmese & Arabic Leaks</span>
          <span class="text-[10px] text-[#777]">ခរុ, ـینگ ➔ ខ្មែរ</span>
        </button>
        <button onclick="stripAllEllipses()" class="w-full text-left px-3 py-2 rounded-lg bg-[#1A1A1A] hover:bg-[#222] border border-[#2A2A2A] text-xs text-red-300 font-medium transition-colors flex items-center justify-between">
          <span>✂️ Strip Trailing Dots (...)</span>
          <span class="text-[10px] text-[#777]">No ... trailers</span>
        </button>
      </div>
    </div>

    <!-- Right Column: Subtitles Workbench -->
    <div class="lg:col-span-7 flex flex-col bg-[#141414] border border-[#242424] rounded-xl overflow-hidden">
      <!-- Workbench Header -->
      <div class="p-4 border-b border-[#242424] flex items-center justify-between bg-[#161616]">
        <div>
          <h2 class="text-sm font-bold text-white">Subtitle Workbench</h2>
          <p class="text-xs text-[#777]" id="statsLabel">0 subtitle blocks loaded</p>
        </div>
        <div class="flex items-center gap-2">
          <button onclick="translateAllWithGemini()" class="px-3.5 py-1.5 bg-emerald-500 hover:bg-emerald-400 text-black font-bold text-xs rounded-lg transition-colors flex items-center gap-1.5 shadow-md shadow-emerald-950/40">
            <span>✨ Translate All (Gemini)</span>
          </button>
        </div>
      </div>

      <!-- Subtitle Blocks List -->
      <div id="subtitlesList" class="flex-1 p-4 overflow-y-auto max-h-[680px] space-y-3">
        <div class="text-center py-16 text-[#555] text-xs">
          No subtitles loaded yet.<br>Click "Load SRT / VTT" or paste your subtitles into the scratchpad.
        </div>
      </div>
    </div>
  </main>

  <script>
    // App State
    let blocks = [];
    const KHMER_DIGITS = ["សូន្យ", "មួយ", "ពីរ", "បី", "បួន", "ប្រាំ", "ប្រាំមួយ", "ប្រាំពីរ", "ប្រាំបី", "ប្រាំបួន"];
    const KHMER_TENS = ["", "ដប់", "ម្ភៃ", "សាមសិប", "សែសិប", "ហាសិប", "ហុកសិប", "ចិតសិប", "ប៉ែតសិប", "កៅសិប"];

    // Initialize API Key from storage
    window.addEventListener("DOMContentLoaded", () => {
      const savedKey = localStorage.getItem("gemini_api_key");
      if (savedKey) document.getElementById("userApiKey").value = savedKey;
      loadSampleSubtitles();
    });

    function saveApiKey(key) {
      if (key && key.trim()) {
        localStorage.setItem("gemini_api_key", key.trim());
      }
    }

    function loadSampleSubtitles() {
      const sample = \`1
00:00:01,000 --> 00:00:03,500
这里有100000元，给你做投资。

2
00:00:04,000 --> 00:00:07,000
我们需要100,000,000资金支持项目！

3
00:00:07,500 --> 00:00:10,000
姐夫，你能不能借我1000000元？\`;
      parseAndSetSRT(sample);
    }

    function parseSRT(text) {
      const clean = text.replace(/\\r\\n/g, "\\n").replace(/\\r/g, "\\n");
      const parts = clean.split(/\\n\\s*\\n/);
      const parsed = [];
      for (const p of parts) {
        const lines = p.trim().split("\\n");
        if (lines.length >= 2) {
          const idx = parseInt(lines[0], 10) || parsed.length + 1;
          const timecode = lines[1].includes("-->") ? lines[1] : "00:00:00,000 --> 00:00:02,000";
          const subText = lines.slice(lines[1].includes("-->") ? 2 : 1).join(" ");
          parsed.push({ index: idx, timecode, text: subText, translatedText: "" });
        }
      }
      return parsed;
    }

    function parseAndSetSRT(text) {
      blocks = parseSRT(text);
      renderBlocks();
    }

    function renderBlocks() {
      const container = document.getElementById("subtitlesList");
      document.getElementById("statsLabel").textContent = blocks.length + " subtitle blocks";
      if (blocks.length === 0) {
        container.innerHTML = '<div class="text-center py-16 text-[#555] text-xs">No subtitles loaded.</div>';
        return;
      }
      container.innerHTML = blocks.map((b, i) => \`
        <div class="bg-[#181818] border border-[#262626] rounded-xl p-3 space-y-2 hover:border-[#38BDF8]/40 transition-colors">
          <div class="flex items-center justify-between text-[11px] text-[#777]">
            <span class="font-bold text-sky-400">#\${b.index}</span>
            <span class="font-mono text-[10px] text-[#666]">\${b.timecode}</span>
          </div>
          <div class="text-xs text-[#CCC] font-medium">\${b.text}</div>
          <input 
            type="text" 
            value="\${b.translatedText || ''}" 
            placeholder="ការបកប្រែជាភាសាខ្មែរ..." 
            onchange="updateBlockTranslation(\${i}, this.value)"
            class="w-full bg-[#101010] border border-[#2E2E2E] focus:border-amber-400 rounded-lg px-3 py-1.5 text-xs text-white khmer-font focus:outline-none"
          />
        </div>
      \`).join("");
    }

    function updateBlockTranslation(index, val) {
      if (blocks[index]) {
        blocks[index].translatedText = convertSentenceAmountsToKhmerWords(val);
      }
    }

    // Number converter
    function convertIntegerToKhmerWords(val) {
      let n = BigInt(val);
      if (n === 0n) return "";
      let res = "";
      if (n >= 100000n) { const s = n / 100000n; n = n % 100000n; res += KHMER_DIGITS[Number(s)] + "សែន"; }
      if (n >= 10000n) { const m = n / 10000n; n = n % 10000n; res += KHMER_DIGITS[Number(m)] + "ម៉ឺន"; }
      if (n >= 1000n) { const p = n / 1000n; n = n % 1000n; res += KHMER_DIGITS[Number(p)] + "ពាន់"; }
      if (n >= 100n) { const r = n / 100n; n = n % 100n; res += KHMER_DIGITS[Number(r)] + "រយ"; }
      if (n > 0n) {
        const rem = Number(n);
        if (rem < 10) res += KHMER_DIGITS[rem];
        else if (rem < 20) res += "ដប់" + (rem > 10 ? KHMER_DIGITS[rem - 10] : "");
        else {
          const t = Math.floor(rem / 10);
          const d = rem % 10;
          res += KHMER_TENS[t] + (d > 0 ? KHMER_DIGITS[d] : "");
        }
      }
      return res;
    }

    function numberToKhmerWords(str) {
      let clean = str.replace(/[,.]/g, "").trim();
      if (!clean || !/^\\d+$/.test(clean)) return str;
      const num = BigInt(clean);
      if (num === 0n) return "សូន្យ";
      const MILLION = 1000000n;
      if (num >= MILLION) {
        const mil = num / MILLION;
        const rem = num % MILLION;
        let part = "";
        if (mil >= 1000n) {
          const tho = mil / 1000n;
          const remTho = mil % 1000n;
          part = convertIntegerToKhmerWords(tho) + "ពាន់";
          if (remTho > 0n) part += convertIntegerToKhmerWords(remTho);
          part += "លាន";
        } else {
          part = convertIntegerToKhmerWords(mil) + "លាន";
        }
        return rem > 0n ? part + " " + convertIntegerToKhmerWords(rem) : part;
      }
      return convertIntegerToKhmerWords(num);
    }

    function convertSentenceAmountsToKhmerWords(text) {
      if (!text) return "";
      return text.replace(/(?<![a-zA-Z\\d])(\\d{1,3}(?:,\\d{3})+|\\d{4,})(?![a-zA-Z\\d])/g, (m) => numberToKhmerWords(m));
    }

    function cleanAllAmounts() {
      let count = 0;
      blocks.forEach(b => {
        if (b.translatedText) {
          const c = convertSentenceAmountsToKhmerWords(b.translatedText);
          if (c !== b.translatedText) { b.translatedText = c; count++; }
        }
      });
      renderBlocks();
      alert("Converted amount numbers to Khmer words in " + count + " sentences!");
    }

    function cleanForeignScripts() {
      let count = 0;
      blocks.forEach(b => {
        if (b.translatedText) {
          let t = b.translatedText;
          t = t.replace(/ခរុ/g, "គូទខ្យង");
          t = t.replace(/ـینگ/g, "យីង");
          t = t.replace(/[\\u1000-\\u109f\\u0600-\\u06ff]/g, "");
          if (t !== b.translatedText) { b.translatedText = t.trim(); count++; }
        }
      });
      renderBlocks();
      alert("Purged foreign characters in " + count + " sentences!");
    }

    function stripAllEllipses() {
      let count = 0;
      blocks.forEach(b => {
        if (b.translatedText) {
          const t = b.translatedText.replace(/\\.{2,}|…|·{2,}/g, "").trim();
          if (t !== b.translatedText) { b.translatedText = t; count++; }
        }
      });
      renderBlocks();
      alert("Stripped trailing dots in " + count + " sentences!");
    }

    // Direct Gemini Translation
    async function translateAllWithGemini() {
      const apiKey = document.getElementById("userApiKey").value.trim() || localStorage.getItem("gemini_api_key");
      if (!apiKey) {
        alert("Please enter your Gemini API Key in the top bar to translate subtitles directly from this standalone app.");
        return;
      }

      const pending = blocks.filter(b => b.text.trim());
      if (pending.length === 0) return;

      const batchText = pending.map(b => \`#\${b.index}: \${b.text}\`).join("\\n");
      const prompt = \`Translate the following subtitle dialogue into natural, colloquial Khmer (ភាសាខ្មែរ).
STRICT RULES:
1. Translate amount numbers into Khmer sentence words:
- 100,000 / 100000 -> "មួយសែន"
- 1,000,000 / 1000000 -> "មួយលាន"
- 10,000,000 / 10000000 -> "ដប់លាន"
- 100,000,000 / 100000000 -> "មួយរយលាន"
- 1,000,000,000 -> "មួយពាន់លាន"
2. Distinguish Husband (ស្វាមី/ប្ដី) from Brother-in-law (បងថ្លៃ/ប្អូនថ្លៃ).
3. Do not include ellipsis (...) signs.
4. Output format: #index: [Khmer text]

Input:
\${batchText}\`;

      try {
        const url = \`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=\${apiKey}\`;
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.2 }
          })
        });

        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error?.message || "Gemini API error");
        }

        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
        
        // Parse results
        const lines = text.split("\\n");
        lines.forEach(l => {
          const m = l.match(/^#(\\d+):\\s*(.*)$/);
          if (m) {
            const idx = parseInt(m[1], 10);
            const b = blocks.find(x => x.index === idx);
            if (b) b.translatedText = convertSentenceAmountsToKhmerWords(m[2].trim());
          }
        });

        renderBlocks();
        alert("Translation complete!");
      } catch (err) {
        alert("Translation failed: " + err.message);
      }
    }

    // Video Handling
    function handleVideoFileUpload(e) {
      const file = e.target.files?.[0];
      if (!file) return;
      const url = URL.createObjectURL(file);
      const v = document.getElementById("videoPlayer");
      v.src = url;
      v.play();
      document.getElementById("videoPlaceholder").classList.add("hidden");
    }

    function handleSubtitleFileUpload(e) {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (evt) => parseAndSetSRT(evt.target.result);
      reader.readAsText(file);
    }

    function parseTimeToSeconds(timeStr) {
      const clean = timeStr.trim().replace(",", ".");
      const p = clean.split(":");
      if (p.length === 3) return parseFloat(p[0]) * 3600 + parseFloat(p[1]) * 60 + parseFloat(p[2]);
      return 0;
    }

    function handleVideoTimeUpdate() {
      const v = document.getElementById("videoPlayer");
      const cur = v.currentTime;
      const overlay = document.getElementById("subtitleOverlay");

      const active = blocks.find(b => {
        const p = b.timecode.split("-->");
        if (p.length === 2) {
          const s = parseTimeToSeconds(p[0]);
          const e = parseTimeToSeconds(p[1]);
          return cur >= s && cur <= e;
        }
        return false;
      });

      if (active && (active.translatedText || active.text)) {
        overlay.textContent = active.translatedText || active.text;
        overlay.classList.remove("hidden");
      } else {
        overlay.classList.add("hidden");
      }
    }

    // Exporters
    function handleExportSRT() {
      if (blocks.length === 0) return;
      const content = blocks.map(b => \`\${b.index}\\n\${b.timecode}\\n\${b.translatedText || b.text}\`).join("\\n\\n");
      const blob = new Blob([content], { type: "text/srt;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "translated_subtitles_khmer.srt";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }

    function handleExportVTT() {
      if (blocks.length === 0) return;
      const cues = blocks.map(b => \`\${b.index}\\n\${b.timecode.replace(/,/g, ".")}\\n\${b.translatedText || b.text}\`).join("\\n\\n");
      const content = "WEBVTT\\n\\n" + cues;
      const blob = new Blob([content], { type: "text/vtt;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "translated_subtitles_khmer.vtt";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  </script>
</body>
</html>`;
}
