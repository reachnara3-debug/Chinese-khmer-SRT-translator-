# Chinese-Khmer SRT Subtitle Translator & Video Studio

A high-performance full-stack web application for translating, editing, condensing, and timing Chinese, Korean, and English subtitles into natural, idiomatic Khmer. Powered by Gemini 2.5/3.1 with automated kinship alignment, subtitle overrun condenser, and amount numbers translation into Khmer sentence words (e.g., 100,000 -> មួយសែន, 100,000,000 -> មួយរយលាន).

---

## 🚀 Features

- **Batch AI Translation**: Translates subtitle chunks preserving subtitle index and SRT/VTT timecodes.
- **Natural Khmer Numbers**: Automatically translates amount numbers and quantities into Khmer alphabet words (`100000` -> `មួយសែន`, `1000000` -> `មួយលាន`, `10000000` -> `ដប់លាន`, `100000000` -> `មួយរយលាន`, `1000000000` -> `មួយពាន់លាន`, `10000000000` -> `ដប់ពាន់លាន`).
- **Purity & Calque Purifier**: Automatically purges Burmese leaks, Arabic glitches, Thai calques, and strips trailing ellipsis (`...`) signs.
- **Kinship Alignment**: Distinguishes between Husband (`ស្វាមី/ប្ដី`) and Brother-in-Law (`បងថ្លៃ/ប្អូនថ្លៃ`) based on Chinese source terms (`丈夫/老公` vs `姐夫/妹夫`).
- **Overrun Condenser**: Identifies lines exceeding speech reading speed (>13 CPS) and condenses them to fit voice narration timing.
- **Embedded Video & Subtitle Studio**: Synchronized video playback with karaoke subtitle overlay, interactive waveform/timecode scrubber, and SAMI/VTT/SRT multi-track support.
- **Browser-Side Export**: Export clean `.srt` and `.vtt` files or copy to clipboard instantly.

---

## 🛠️ Quick Start Guide

### 1. Prerequisites
- **Node.js**: v18.0.0 or higher (v20+ recommended)
- **npm** or **bun** / **yarn** / **pnpm**
- **Gemini API Key**: Get a free API key from [Google AI Studio](https://aistudio.google.com/app/apikey).

### 2. Installation
Extract the downloaded ZIP file, open a terminal in the project folder, and run:

```bash
npm install
```

### 3. Configure Environment Variables
Create a `.env` file in the root directory:

```bash
cp .env.example .env
```

Edit `.env` and insert your Gemini API Key:
```env
GEMINI_API_KEY=your_actual_gemini_api_key_here
PORT=3000
```

### 4. Run the Development Server
```bash
npm run dev
```

Open your browser and navigate to:
```
http://localhost:3000
```

---

## 📦 Project Structure

```
├── server.ts                       # Express backend + Gemini API routes + Vite dev middleware
├── index.html                      # HTML entry point with metadata and fonts
├── vite.config.ts                  # Vite build configuration with Tailwind CSS plugin
├── tsconfig.json                   # TypeScript compiler options
├── package.json                    # Project dependencies and npm scripts
├── src/
│   ├── main.tsx                    # React application bootstrap
│   ├── App.tsx                     # Main translation interface, state management, and video studio
│   ├── types.ts                    # SubtitleBlock, TranslationConfig, and UI TypeScript interfaces
│   ├── index.css                   # Global styles & Tailwind CSS imports
│   ├── components/
│   │   └── VideoPlayerStudio.tsx   # Video player with subtitle overlay and time scrubber
│   └── utils/
│       ├── srtParser.ts            # Parser, exporter, number-to-Khmer converter, and issue detector
│       ├── videoSubtitleExtractor.ts # Audio & subtitle extraction helpers
│       └── exampleSubtitles.ts     # Sample test subtitle scripts
└── README.md                       # Setup and documentation
```

---

## 🚢 Building for Production

To create an optimized production build:

```bash
npm run build
```

Then start the production server:
```bash
npm start
```

---

## 📜 License
MIT License. Built with Google Gemini and Vite.
