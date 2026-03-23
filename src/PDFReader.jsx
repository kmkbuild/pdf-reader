import { useState, useEffect, useRef, useCallback } from "react";

// ── PDF.js ────────────────────────────────────────────────────────────────────
const PV = "3.11.174";
const PDFJS_URL = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PV}/pdf.min.js`;
const WORKER_URL = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PV}/pdf.worker.min.js`;
function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) return res();
    const s = document.createElement("script");
    s.src = src; s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
}

// ── IndexedDB ─────────────────────────────────────────────────────────────────
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("PDFReaderDB", 3); // version 3 — adds thumbnails store
    r.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("pdfs"))
        db.createObjectStore("pdfs", { keyPath: "name" });
      if (!db.objectStoreNames.contains("settings"))
        db.createObjectStore("settings", { keyPath: "key" });
      if (!db.objectStoreNames.contains("bookmarks"))
        db.createObjectStore("bookmarks", { keyPath: "bookName" });
      if (!db.objectStoreNames.contains("notes"))
        db.createObjectStore("notes", { keyPath: "bookName" });
      // FIX ii: thumbnail cache store
      if (!db.objectStoreNames.contains("thumbs"))
        db.createObjectStore("thumbs", { keyPath: "name" });
    };
    r.onsuccess = e => res(e.target.result);
    r.onerror = e => rej(e.target.error);
  });
}
async function dbSavePDF(name, buf, size, modified) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction("pdfs", "readwrite");
    tx.objectStore("pdfs").put({ name, data: buf, size, modified });
    tx.oncomplete = res; tx.onerror = e => rej(e.target.error);
  });
}
async function dbGetAllPDFs() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction("pdfs", "readonly");
    const r = tx.objectStore("pdfs").getAll();
    r.onsuccess = e => res(e.target.result || []);
    r.onerror = e => rej(e.target.error);
  });
}
async function dbDeletePDF(name) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction("pdfs", "readwrite");
    tx.objectStore("pdfs").delete(name);
    tx.oncomplete = res; tx.onerror = e => rej(e.target.error);
  });
}
async function dbSet(key, value) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction("settings", "readwrite");
    tx.objectStore("settings").put({ key, value });
    tx.oncomplete = res; tx.onerror = e => rej(e.target.error);
  });
}
async function dbGet(key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction("settings", "readonly");
    const r = tx.objectStore("settings").get(key);
    r.onsuccess = e => res(e.target.result?.value ?? null);
    r.onerror = e => rej(e.target.error);
  });
}
async function dbSaveBookmarks(bookName, pages) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction("bookmarks", "readwrite");
    tx.objectStore("bookmarks").put({ bookName, pages });
    tx.oncomplete = res; tx.onerror = e => rej(e.target.error);
  });
}
async function dbGetAllBookmarks() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction("bookmarks", "readonly");
    const r = tx.objectStore("bookmarks").getAll();
    r.onsuccess = e => {
      const map = {};
      (e.target.result || []).forEach(row => { map[row.bookName] = row.pages; });
      res(map);
    };
    r.onerror = e => rej(e.target.error);
  });
}
async function dbSaveNotes(bookName, pageNotes) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction("notes", "readwrite");
    tx.objectStore("notes").put({ bookName, pageNotes });
    tx.oncomplete = res; tx.onerror = e => rej(e.target.error);
  });
}
async function dbGetAllNotes() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction("notes", "readonly");
    const r = tx.objectStore("notes").getAll();
    r.onsuccess = e => {
      const map = {};
      (e.target.result || []).forEach(row => { map[row.bookName] = row.pageNotes; });
      res(map);
    };
    r.onerror = e => rej(e.target.error);
  });
}
// FIX ii: thumbnail store helpers
async function dbSaveThumb(name, dataUrl) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction("thumbs", "readwrite");
    tx.objectStore("thumbs").put({ name, dataUrl });
    tx.oncomplete = res; tx.onerror = e => rej(e.target.error);
  });
}
async function dbGetAllThumbs() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction("thumbs", "readonly");
    const r = tx.objectStore("thumbs").getAll();
    r.onsuccess = e => {
      const map = {};
      (e.target.result || []).forEach(row => { map[row.name] = row.dataUrl; });
      res(map);
    };
    r.onerror = e => rej(e.target.error);
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good Morning ☀️";
  if (h < 17) return "Good Afternoon 🌤️";
  if (h < 21) return "Good Evening 🌆";
  return "Good Night 🌙";
}
function coverHue(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++)
    h = (h * 31 + name.charCodeAt(i)) & 0xffffffff;
  return [210, 230, 250, 270, 190, 200, 220][Math.abs(h) % 7];
}
const SKIP_DIRS = new Set([
  "android","data","obb","proc","sys","dev","acct","cache",
  ".thumbnails",".cache","lost+found","system","dalvik-cache",
  "app","priv-app","framework","lib","lib64",".android_secure",
]);
async function scanDir(dh, depth = 0, onFound) {
  if (depth > 10) return;
  try {
    for await (const [n, h] of dh.entries()) {
      const lo = n.toLowerCase();
      if (h.kind === "file" && lo.endsWith(".pdf")) {
        try {
          const f = await h.getFile();
          onFound?.({ name: n.replace(/\.pdf$/i,""), file:f, size:f.size, modified:f.lastModified });
        } catch {}
      } else if (h.kind === "directory" && !lo.startsWith(".") && !SKIP_DIRS.has(lo)) {
        await scanDir(h, depth+1, onFound);
      }
    }
  } catch {}
}

// FIX ii: Generate thumbnail from PDF first page
async function generateThumb(buf, name) {
  try {
    if (!window.pdfjsLib) return null;
    const doc = await window.pdfjsLib.getDocument({
      data: buf.slice(0), // slice so original buffer stays usable
      cMapUrl: `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PV}/cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PV}/standard_fonts/`,
      disableFontFace: false,
      useSystemFonts: true,
    }).promise;
    const page = await doc.getPage(1);
    const vp = page.getViewport({ scale: 0.3 }); // small thumbnail
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp, intent: "print" }).promise;
    const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
    doc.destroy();
    return dataUrl;
  } catch {
    return null;
  }
}

// ── Design tokens ─────────────────────────────────────────────────────────────
const C = {
  bg0: "#03050f", bg1: "#070d1a", bg2: "#0c1428", bg3: "#101e38",
  glass: "rgba(12,20,40,0.80)", glow: "#2563eb", purple: "#7c3aed",
  neon: "#3b82f6", neonL: "#60a5fa", purpleL: "#a78bfa",
  border: "rgba(59,130,246,0.18)", borderG: "rgba(59,130,246,0.50)",
  tx: "#e2e8f0", txM: "#64748b", txD: "#1e293b",
};
const glassBtn = (extra={}) => ({
  background: C.glass, backdropFilter:"blur(12px)",
  border:`1px solid ${C.border}`, borderRadius:12,
  color:C.tx, cursor:"pointer",
  display:"flex", alignItems:"center", justifyContent:"center",
  width:38, height:38, fontSize:16, flexShrink:0,
  transition:"border-color .2s", ...extra,
});
const glassCard = (active=false) => ({
  background: active?"rgba(59,130,246,0.14)":"rgba(255,255,255,0.04)",
  backdropFilter:"blur(10px)",
  border:`1px solid ${active?C.borderG:C.border}`,
  borderRadius:16, padding:"14px 16px",
  boxShadow: active?`0 0 20px rgba(37,99,235,0.2)`:"none",
  transition:"all .2s",
});

// ══════════════════════════════════════════════════════════════════════════════
export default function App() {
  const [screen, setScreen] = useState("home");
  const [pdfjsReady, setPdfjsReady] = useState(false);
  const [dark, setDark] = useState(true);

  // Library
  const [library, setLibrary] = useState([]);
  const [thumbs, setThumbs] = useState({}); // FIX ii: thumbnail cache
  const [recentBooks, setRecentBooks] = useState([]);
  const [libSearch, setLibSearch] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scanCount, setScanCount] = useState(0);
  const [scanStatus, setScanStatus] = useState("");
  const [toast, setToast] = useState(null);
  const [showPerm, setShowPerm] = useState(false);
  const [permState, setPermState] = useState("unknown");
  const [fileKey, setFileKey] = useState(0); // FIX 2: increment to remount input
  const [scanKey, setScanKey] = useState(0);
  const [plusPressed, setPlusPressed] = useState(false);

  // Drawer
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerView, setDrawerView] = useState("menu");

  // Reader
  const [pdfDoc, setPdfDoc] = useState(null);
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [rendering, setRendering] = useState(false);
  const [currentBook, setCurrentBook] = useState(null);
  const [toc, setToc] = useState([]);
  const [bookmarks, setBookmarks] = useState({});
  const [notes, setNotes] = useState({});
  const [noteInput, setNoteInput] = useState("");
  const [lastRead, setLastRead] = useState({});
  const [showControls, setShowControls] = useState(true);
  const [activePanel, setActivePanel] = useState(null);
  const [goInput, setGoInput] = useState("");
  const [searchQ, setSearchQ] = useState("");
  const [searchRes, setSearchRes] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchTotal, setSearchTotal] = useState(0);
  const [textCache, setTextCache] = useState({});
  const [resultIdx, setResultIdx] = useState(0);
  const [voicePlaying, setVoicePlaying] = useState(false);
  const [voiceSpeed, setVoiceSpeed] = useState(1);
  const [voiceProgress, setVoiceProgress] = useState(0);

  const canvasRef = useRef(null);
  const renderTaskRef = useRef(null);
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const containerRef = useRef(null);
  const pinchRef = useRef({ active:false, startDist:0, startZoom:1 });
  const swipeRef = useRef({ startX: 0, startY: 0, isSwiping: false });
  const controlsTimer = useRef(null);
  const utterRef = useRef(null);
  const restoredRef = useRef(false);

  // Refs for back button
  const screenRef = useRef("home");
  const activePanelRef = useRef(null);
  const drawerRef = useRef(false);
  useEffect(() => { screenRef.current = screen; }, [screen]);
  useEffect(() => { activePanelRef.current = activePanel; }, [activePanel]);
  useEffect(() => { drawerRef.current = drawerOpen; }, [drawerOpen]);

  // ── BOOT ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    loadScript(PDFJS_URL).then(() => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER_URL;
      setPdfjsReady(true);
    });
    (async () => {
      try {
        const rows = await dbGetAllPDFs();
        if (rows.length) {
          setLibrary(rows.map(r => ({
            name: r.name,
            file: new File([r.data], r.name+".pdf", { type:"application/pdf" }),
            size: r.size, modified: r.modified,
          })));
        }
        const [bm, nt, lr, rb, perm, dk, th] = await Promise.all([
          dbGetAllBookmarks(), dbGetAllNotes(),
          dbGet("lastRead"), dbGet("recentBooks"),
          dbGet("permState"), dbGet("dark"),
          dbGetAllThumbs(), // FIX ii
        ]);
        if (bm && Object.keys(bm).length) setBookmarks(bm);
        if (nt && Object.keys(nt).length) setNotes(nt);
        if (lr) setLastRead(lr);
        if (rb) setRecentBooks(rb);
        if (dk !== null) setDark(dk);
        if (th && Object.keys(th).length) setThumbs(th); // FIX ii
        if (perm==="granted"||perm==="skipped") setPermState(perm);
        else setTimeout(() => setShowPerm(true), 900);
      } catch {
        setTimeout(() => setShowPerm(true), 900);
      } finally {
        restoredRef.current = true;
      }
    })();
  }, []);

  // ── BACK BUTTON ─────────────────────────────────────────────────────────────
  useEffect(() => {
    try { window.history.pushState({ p:1 }, ""); } catch {}
    const nav = () => {
      try { window.history.pushState({ p:1 }, ""); } catch {}
      if (drawerRef.current) { setDrawerOpen(false); return; }
      if (activePanelRef.current) { setActivePanel(null); return; }
      if (screenRef.current === "reader") {
        setScreen("home"); setPdfDoc(null); stopVoice(); return;
      }
      try { window.Capacitor?.Plugins?.App?.minimizeApp?.(); } catch {}
    };
    const onBack = e => { if (e?.preventDefault) e.preventDefault(); nav(); };
    document.addEventListener("backbutton", onBack, false);
    document.addEventListener("ionBackButton", onBack, false);
    window.addEventListener("popstate", nav);
    return () => {
      document.removeEventListener("backbutton", onBack, false);
      document.removeEventListener("ionBackButton", onBack, false);
      window.removeEventListener("popstate", nav);
    };
  }, []);

  // ── AUTO-SAVE ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!restoredRef.current) return;
    Object.entries(bookmarks).forEach(([n,p]) => dbSaveBookmarks(n,p).catch(()=>{}));
  }, [bookmarks]);
  useEffect(() => {
    if (!restoredRef.current) return;
    Object.entries(notes).forEach(([n,p]) => dbSaveNotes(n,p).catch(()=>{}));
  }, [notes]);
  useEffect(() => {
  if (pdfDoc) {
    renderPage(pdfDoc, currentPage);
  }
}, [currentPage, zoom]);
  useEffect(() => { if (restoredRef.current) dbSet("lastRead",lastRead).catch(()=>{}); }, [lastRead]);
  useEffect(() => { if (restoredRef.current) dbSet("recentBooks",recentBooks).catch(()=>{}); }, [recentBooks]);
  useEffect(() => { if (restoredRef.current) dbSet("dark",dark).catch(()=>{}); }, [dark]);
  useEffect(() => {
    if (currentBook) setNoteInput(notes[currentBook.name]?.[currentPage]||"");
  }, [currentPage, currentBook]);

  const toast_ = (msg, type="info") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 2600);
  };

  const touchControls = () => {
    setShowControls(true);
    clearTimeout(controlsTimer.current);
    controlsTimer.current = setTimeout(() => {
      if (!activePanelRef.current) setShowControls(false);
    }, 4000);
  };
useEffect(() => {
  if (screen === "reader" && pdfDoc) {
    setTimeout(() => {
      renderPage(pdfDoc, currentPage);
    }, 100);
  }
}, [screen, pdfDoc]);
  // ── FIX ii: Generate and cache thumbnail for a book ──────────────────────────
  const ensureThumb = useCallback(async (name, buf) => {
    if (thumbs[name]) return; // already have it
    try {
      const dataUrl = await generateThumb(buf, name);
      if (dataUrl) {
        setThumbs(prev => ({ ...prev, [name]: dataUrl }));
        dbSaveThumb(name, dataUrl).catch(()=>{});
      }
    } catch {}
  }, [thumbs]);

  // FIX 3: Storage permission & scan
  // On Capacitor Android WebView, showDirectoryPicker is NOT available.
  // webkitdirectory input works but requires user to navigate to the folder.
  // Best UX: show a clear guide, then open the folder picker input.
  const grantPermission = async () => {
    setShowPerm(false);
    setPermState("granted");
    await dbSet("permState","granted").catch(()=>{});

    // Try modern File System Access API (Chrome desktop only)
    if ("showDirectoryPicker" in window) {
      try {
        const dir = await window.showDirectoryPicker({ mode:"read" });
        await runFolderScan(dir);
        return;
      } catch (e) {
        if (e?.name === "AbortError") return;
        // Not available in this environment — fall through to input
      }
    }
    // Fallback: folder input (works in Android WebView via webkitdirectory)
    triggerFolderPicker();
  };

  const skipPerm = () => {
    setShowPerm(false); setPermState("skipped");
    dbSet("permState","skipped").catch(()=>{});
  };
  const runFolderScan = async (dir) => {
    setScanning(true); setScanCount(0); setScanStatus("Scanning…");
    const seen = new Set(library.map(b=>b.name));
    let count = 0;
    await scanDir(dir, 0, async (book) => {
      if (seen.has(book.name)) return;
      seen.add(book.name); count++;
      setScanCount(count); setScanStatus(`Found: ${book.name}`);
      try {
        const buf = await book.file.arrayBuffer();
        await dbSavePDF(book.name, buf, book.size, book.modified);
        // FIX ii: generate thumbnail in background
        ensureThumb(book.name, buf);
      } catch {}
      setLibrary(prev => prev.find(b=>b.name===book.name) ? prev : [...prev, book]);
    });
    setScanning(false); setScanStatus("");
    if (!count) toast_("No new PDFs found. Select your Internal Storage root.");
    else toast_(`Found ${count} PDF${count>1?"s":""}!`, "success");
  };
  const handleFolderInput = async (e) => {
    const files = Array.from(e.target.files||[]).filter(f=>f.name.toLowerCase().endsWith(".pdf"));
    if (!files.length) { toast_("No PDFs found."); e.target.value=""; return; }
    setScanning(true); setScanCount(0);
    const seen = new Set(library.map(b=>b.name));
    let count=0;
    for (const f of files) {
      const name = f.name.replace(/\.pdf$/i,"");
      if (seen.has(name)) continue;
      seen.add(name); count++;
      setScanCount(count); setScanStatus(`Found: ${name}`);
      const book = { name, file:f, size:f.size, modified:f.lastModified };
      try {
        const buf = await f.arrayBuffer();
        await dbSavePDF(name, buf, f.size, f.lastModified);
        ensureThumb(name, buf); // FIX ii
      } catch {}
      setLibrary(prev => prev.find(b=>b.name===name) ? prev : [...prev, book]);
    }
    setScanning(false); setScanStatus("");
    e.target.value = ""; // reset so same folder can be re-selected
    if (!count) toast_("No new PDFs found.");
    else toast_(`${count} PDF${count>1?"s":""} added!`, "success");
  };

  // FIX 2: Remount the input element by changing its key — guarantees
  // onChange always fires even when same file is selected again
  // Use a ref flag to prevent double-trigger (onTouchEnd + onClick both fire on mobile)
  const filePickerBusy = useRef(false);
  const triggerFilePicker = () => {
    if (filePickerBusy.current) return;
    filePickerBusy.current = true;
    setTimeout(() => { filePickerBusy.current = false; }, 800);
    setFileKey(k => k + 1); // triggers remount of input element
    // 100 ms gives React time to re-render the new input before we .click() it
    setTimeout(() => fileInputRef.current?.click(), 100);
  };
  const triggerFolderPicker = () => {
    setScanKey(k => k + 1);
    setTimeout(() => folderInputRef.current?.click(), 100);
  };

  const handleFiles = async (files) => {
    if (!files?.length) return;
    const books = Array.from(files)
      .filter(f => f.name.toLowerCase().endsWith(".pdf"))
      .map(f => ({ name:f.name.replace(/\.pdf$/i,""), file:f, size:f.size, modified:f.lastModified }));
    if (!books.length) return;
    for (const b of books) {
      try {
        const buf = await b.file.arrayBuffer();
        await dbSavePDF(b.name, buf, b.size, b.modified);
        ensureThumb(b.name, buf); // FIX ii
      } catch {}
    }
    setLibrary(prev => {
      const s = new Set(prev.map(x=>x.name));
      return [...prev, ...books.filter(x=>!s.has(x.name))];
    });
    toast_(`${books.length} PDF${books.length>1?"s":""} added!`, "success");
  };

  // FIX 4: openBook — try multiple loading strategies for maximum compatibility
  // Strategy 1: full options (Urdu/Arabic/Unicode fonts)
  // Strategy 2: simplified options (some PDFs reject certain options)
  // Strategy 3: minimal options (last resort for unusual PDFs)
  const openBook = async (book) => {
    if (!pdfjsReady) { toast_("PDF engine loading…"); return; }
    stopVoice();
    setCurrentBook(book); setToc([]);
    setSearchRes([]); setSearchQ(""); setTextCache({});
    setActivePanel(null); setDrawerOpen(false);
    setRecentBooks(prev=>[book.name,...prev.filter(n=>n!==book.name)].slice(0,6));
    const resumePage = lastRead[book.name] || 1;

    let doc = null;
    let buf;
    try { buf = await book.file.arrayBuffer(); } catch {
      toast_("Could not read this file. Try re-importing it.", "error"); return;
    }

    // Strategy 1: Full options — best for Urdu/Arabic/Unicode
    const strategies = [
      {
        data: buf,
        cMapUrl: `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PV}/cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PV}/standard_fonts/`,
        useSystemFonts: true,
        disableFontFace: false,
        isEvalSupported: false,
        verbosity: 0,
      },
      // Strategy 2: Without system fonts (some PDFs conflict with it)
      {
        data: buf,
        cMapUrl: `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PV}/cmaps/`,
        cMapPacked: true,
        useSystemFonts: false,
        verbosity: 0,
      },
      // Strategy 3: Bare minimum (maximum compatibility)
      {
        data: buf,
        verbosity: 0,
      },
    ];

    for (const opts of strategies) {
      try {
        doc = await window.pdfjsLib.getDocument(opts).promise;
        break; // success
      } catch (err) {
        console.warn("PDF strategy failed:", err?.message);
        doc = null;
      }
    }

    if (!doc) {
      toast_("Could not open this PDF. It may be corrupted or password-protected.", "error");
      return;
    }

    setCurrentPage(resumePage);
    setNumPages(doc.numPages);
    setPdfDoc(doc);setTimeout(() => {
  renderPage(doc, resumePage);
}, 150);
    try { setToc(flattenOutline(await doc.getOutline())); } catch { setToc([]); }
    setScreen("reader");
    setShowControls(true);
  };

  const flattenOutline = (items, d=0) => {
    if (!items) return [];
    return items.flatMap(i=>[{title:i.title,dest:i.dest,depth:d},...flattenOutline(i.items,d+1)]);
  };

  // ── FIX iii: RENDER PAGE — wait for container dimensions before rendering ────
  // Root cause of blank page 1: containerRef.clientWidth is 0 right after screen
  // switches. Fix: measure after a rAF so DOM has laid out.
  const renderPage = useCallback(async (doc, pageNum, scaleOvr) => {
    if (!canvasRef.current || !doc) return;
    if (renderTaskRef.current) { try { renderTaskRef.current.cancel(); } catch {} }
    setRendering(true);
    try {
      const page = await doc.getPage(pageNum);

      // FIX iii: ensure container has real dimensions
      let availW = containerRef.current?.clientWidth || 0;
      if (availW < 10) {
        // Wait one animation frame for DOM layout to complete
        await new Promise(r => requestAnimationFrame(r));
        availW = containerRef.current?.clientWidth || window.innerWidth;
      }
      // Still 0? Use window width as fallback
      if (availW < 10) availW = window.innerWidth;

      const naturalVP = page.getViewport({ scale: 1 });
      const fit = availW / naturalVP.width;
      const scale = scaleOvr !== undefined ? scaleOvr : fit;
      const dpr = window.devicePixelRatio || 1;
      const vp = page.getViewport({ scale });
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      canvas.style.opacity = 0.7;
      canvas.width  = Math.floor(vp.width  * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      canvas.style.width  = `${Math.floor(vp.width)}px`;
      canvas.style.height = `${Math.floor(vp.height)}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
     // 🔥 Create temp canvas (background render)
const tempCanvas = document.createElement("canvas");
const tempCtx = tempCanvas.getContext("2d");

tempCanvas.width = Math.floor(vp.width * dpr);
tempCanvas.height = Math.floor(vp.height * dpr);
tempCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

// Render in background
const task = page.render({
  canvasContext: tempCtx,
  viewport: vp,
  intent: "display",
});
renderTaskRef.current = task;

await task.promise;
canvas.style.opacity = 1;
// 🔥 Swap to main canvas (instant display)
canvas.width = tempCanvas.width;
canvas.height = tempCanvas.height;
canvas.style.width = `${Math.floor(vp.width)}px`;
canvas.style.height = `${Math.floor(vp.height)}px`;

ctx.setTransform(1, 0, 0, 1, 0, 0);
ctx.drawImage(tempCanvas, 0, 0);
      if (scaleOvr === undefined) setZoom(fit);
    } catch (e) {
      if (e?.name !== "RenderingCancelledException") console.error("Render:", e);
    } finally {
      setRendering(false);
    }
  }, []);

  useEffect(() => {
    if (pdfDoc) renderPage(pdfDoc, currentPage, undefined);
  }, [pdfDoc, currentPage]);

  const zt = useRef(null);
  useEffect(() => {
    if (!pdfDoc) return;
    clearTimeout(zt.current);
    zt.current = setTimeout(() => renderPage(pdfDoc, currentPage, zoom), 150);
  }, [zoom]);

  // ── FIX 1: SMOOTH PINCH ZOOM ─────────────────────────────────────────────────
  // Old problem: every touch move fired setZoom → triggered re-render → lag
  // Fix: accumulate zoom in a ref during gesture, only setZoom on touchend
  const liveZoomRef = useRef(zoom); // tracks zoom during gesture without re-renders
 const onTS = e => {
  if (e.touches.length === 1) {
    swipeRef.current = {
      startX: e.touches[0].clientX,
      startY: e.touches[0].clientY,
      isSwiping: true
    };
  }

  if (e.touches.length !== 2) return;
  e.preventDefault();

  const dx = e.touches[0].clientX - e.touches[1].clientX;
  const dy = e.touches[0].clientY - e.touches[1].clientY;

  pinchRef.current = {
    active: true,
    startDist: Math.hypot(dx, dy),
    startZoom: liveZoomRef.current
  };
};
  const onTM = e => {
    if (!pinchRef.current.active || e.touches.length !== 2) return;
    e.preventDefault();
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    const raw = pinchRef.current.startZoom * (Math.hypot(dx,dy) / pinchRef.current.startDist);
    // Apply slight dampening (0.92) so fast gestures feel controlled not jumpy
    const dampened = pinchRef.current.startZoom + (raw - pinchRef.current.startZoom) * 0.92;
    liveZoomRef.current = Math.max(0.4, Math.min(4, dampened));
    // Apply CSS transform instantly (no re-render) for visual smoothness
    if (canvasRef.current) {
      const scaleFactor = liveZoomRef.current / pinchRef.current.startZoom;
      canvasRef.current.parentElement.style.transform = `scale(${scaleFactor})`;
      canvasRef.current.parentElement.style.transformOrigin = "top center";
    }
  };
  const onTE = () => { 
     if (swipeRef.current.isSwiping) {
    const endX = e.changedTouches[0].clientX;
    const diffX = endX - swipeRef.current.startX;
    const threshold = 50; // pixels

    if (diffX < -threshold && currentPage < numPages) {
      setCurrentPage(p => p + 1); // swipe left → next page
    }
    if (diffX > threshold && currentPage > 1) {
      setCurrentPage(p => p - 1); // swipe right → previous page
    }

    swipeRef.current.isSwiping = false;
  }
    if (!pinchRef.current.active) return;
    pinchRef.current.active = false;
    // Remove temporary CSS transform
    if (canvasRef.current) {
      canvasRef.current.parentElement.style.transform = "";
    }
    // Now trigger actual re-render with final zoom value
    const finalZoom = parseFloat(liveZoomRef.current.toFixed(2));
    setZoom(finalZoom);
  };

  // ── PAGE NAV ─────────────────────────────────────────────────────────────────
  const goToPage = n => {
    const p=Math.max(1,Math.min(n,numPages));
    setCurrentPage(p);
    if (currentBook) setLastRead(prev=>({...prev,[currentBook.name]:p}));
  };
  const navToc = async item => {
    if (!pdfDoc||!item.dest) return;
    try {
      let d=item.dest;
      if (typeof d==="string") d=await pdfDoc.getDestination(d);
      if (!d) return;
      goToPage((await pdfDoc.getPageIndex(d[0]))+1);
      setActivePanel(null); setDrawerOpen(false);
    } catch {}
  };

  // ── BOOKMARKS ────────────────────────────────────────────────────────────────
  const bKey = currentBook?.name||"";
  const bBms = bookmarks[bKey]||[];
  const isBm = bBms.includes(currentPage);
  const toggleBm = () => {
    if (isBm) {
      setBookmarks(p=>({...p,[bKey]:bBms.filter(x=>x!==currentPage)}));
      toast_("Bookmark removed");
    } else {
      setBookmarks(p=>({...p,[bKey]:[...bBms,currentPage].sort((a,b)=>a-b)}));
      toast_(`Page ${currentPage} saved!`, "success");
    }
  };
  const allBms = Object.entries(bookmarks).flatMap(([bookName,pages])=>
    pages.map(pg=>({ bookName, page:pg }))
  );

  // ── NOTES ────────────────────────────────────────────────────────────────────
  const bNotes = notes[bKey]||{};
  const saveNote = () => {
    const u={...bNotes};
    if (!noteInput.trim()) delete u[currentPage]; else u[currentPage]=noteInput;
    setNotes(p=>({...p,[bKey]:u}));
    toast_(noteInput.trim()?"Note saved!":"Note deleted","success");
  };

  // ── SEARCH ───────────────────────────────────────────────────────────────────
  const getPageText = async (doc,p) => {
    if (textCache[p]) return textCache[p];
    const page=await doc.getPage(p);
    const c=await page.getTextContent();
    const text=c.items.map(i=>i.str).join(" ");
    setTextCache(prev=>({...prev,[p]:text}));
    return text;
  };
  const runSearch = async () => {
    if (!pdfDoc||!searchQ.trim()) return;
    setSearching(true); setSearchRes([]); setSearchTotal(0); setResultIdx(0);
    const q=searchQ.trim().toLowerCase();
    const results=[]; let total=0;
    for (let p=1;p<=numPages;p++) {
      try {
        const text=await getPageText(pdfDoc,p);
        const lower=text.toLowerCase();
        let idx=lower.indexOf(q);
        const snippets=[]; let count=0;
        while (idx!==-1) {
          count++;
          if (snippets.length<3) {
            const s=Math.max(0,idx-40), e=Math.min(text.length,idx+q.length+40);
            snippets.push({ before:text.slice(s,idx), match:text.slice(idx,idx+q.length), after:text.slice(idx+q.length,e) });
          }
          idx=lower.indexOf(q,idx+1);
        }
        if (snippets.length) { total+=count; results.push({page:p,snippets,count}); }
      } catch {}
    }
    setSearchRes(results); setSearchTotal(total); setSearching(false);
    if (!results.length) toast_(`No results for "${searchQ}"`);
    else toast_(`${total} matches on ${results.length} pages`,"success");
  };
  const jumpResult = dir => {
    if (!searchRes.length) return;
    const i=(resultIdx+dir+searchRes.length)%searchRes.length;
    setResultIdx(i); goToPage(searchRes[i].page);
  };

  // ── FIX 2: VOICE — language auto-detect + male/female + works on Android ────
  const [voices, setVoices] = useState([]);
  const [voiceGender, setVoiceGender] = useState("female");
  const [detectedLang, setDetectedLang] = useState("en");
  const voicesLoadedRef = useRef(false);

  // Load voices — they load async on Android, need multiple attempts
  useEffect(() => {
    const load = () => {
      const v = window.speechSynthesis?.getVoices() || [];
      if (v.length > 0) { setVoices(v); voicesLoadedRef.current = true; }
    };
    load();
    window.speechSynthesis?.addEventListener("voiceschanged", load);
    setTimeout(load, 500);
    setTimeout(load, 1500);
    setTimeout(load, 3000);
    return () => window.speechSynthesis?.removeEventListener("voiceschanged", load);
  }, []);

  const detectLanguage = (text) => {
    if (!text || text.trim().length < 10) return "en";
    const s = text.slice(0, 500);
    // Compare against NON-WHITESPACE chars so spaces don't dilute the ratio
    const nonSpace = (s.replace(/\s/g, '').length) || 1;
    const counts = {
      arabic: (s.match(/[\u0600-\u06FF]/g)||[]).length,
      hindi:  (s.match(/[\u0900-\u097F]/g)||[]).length,
      chinese:(s.match(/[\u4E00-\u9FFF]/g)||[]).length,
      french: (s.match(/[àâçéèêëîïôùûüÿæœ]/gi)||[]).length,
    };
    // Threshold: 5% of non-space chars (was 12% of all chars — too strict for PDFs)
    if (counts.arabic  / nonSpace > 0.05) {
      // Urdu-specific letters: ٹ ڈ ڑ ں ھ ہ ۃ ے ی (not present in pure Arabic)
      const urduOnly = (s.match(/[\u0679\u0688\u0691\u06BA\u06BE\u06C1\u06C3\u06D2\u06CC]/g)||[]).length;
      return urduOnly > 0 ? "ur" : "ar";
    }
    if (counts.hindi   / nonSpace > 0.05) return "hi";
    if (counts.chinese / nonSpace > 0.05) return "zh";
    if (counts.french  / nonSpace > 0.02) return "fr";
    return "en";
  };

  const findVoice = (lang, gender, allVoices) => {
    if (!allVoices.length) return null;
    const langCodes = { en:["en-US","en-GB","en-IN","en"], ur:["ur-PK","ur","ar-SA","ar"],
      ar:["ar-SA","ar-EG","ar"], hi:["hi-IN","hi"], zh:["zh-CN","zh-TW","zh"], fr:["fr-FR","fr-CA","fr"] };
    const maleKW   = ["male","man","david","mark","daniel","jorge","carlos","pierre","wei","raj","ali","google uk english male"];
    const femaleKW = ["female","woman","samantha","victoria","karen","alice","anna","moira","tessa","zira","nora","sara","aria","zoya","google uk english female"];
    const codes  = langCodes[lang] || [lang,"en"];
    const genderKW = gender==="male" ? maleKW : femaleKW;
    // Try lang + gender match first
    for (const code of codes) {
      const v = allVoices.find(v => v.lang.toLowerCase().startsWith(code.toLowerCase().split("-")[0])
        && genderKW.some(kw => v.name.toLowerCase().includes(kw)));
      if (v) return v;
    }
    // Then any voice for this language
    for (const code of codes) {
      const v = allVoices.find(v => v.lang.toLowerCase().startsWith(code.toLowerCase().split("-")[0]));
      if (v) return v;
    }
    // English fallback with gender
    const eng = allVoices.find(v => v.lang.startsWith("en") && genderKW.some(kw => v.name.toLowerCase().includes(kw)));
    return eng || allVoices[0] || null;
  };

  const startVoice = async () => {
    if (!pdfDoc) return;
    // Hard check — some Android WebViews don't have speechSynthesis at all
    if (!('speechSynthesis' in window)) {
      toast_("Voice reading is not supported in this browser. Try Chrome.");
      return;
    }
    // Reload voices if not yet loaded (Android loads them async)
    if (!voicesLoadedRef.current || voices.length === 0) {
      const v = window.speechSynthesis?.getVoices() || [];
      if (v.length > 0) { setVoices(v); voicesLoadedRef.current = true; }
    }
    try {
      const text = await getPageText(pdfDoc, currentPage);
      if (!text?.trim()) { toast_("No readable text on this page."); return; }
      stopVoice();
      const lang = detectLanguage(text);
      setDetectedLang(lang);
      const langLocale = { en:"en-US", ur:"ur-PK", ar:"ar-SA", hi:"hi-IN", zh:"zh-CN", fr:"fr-FR" };
      const utter = new SpeechSynthesisUtterance(text);
      utter.rate  = voiceSpeed;
      utter.pitch = 1;
      utter.lang  = langLocale[lang] || "en-US";
      // Get latest voice list — don't block speech if list is still empty
      const allV  = window.speechSynthesis?.getVoices() || voices;
      if (allV.length > 0) {
        const best = findVoice(lang, voiceGender, allV);
        if (best) utter.voice = best;
      }
      utter.onstart    = () => setVoicePlaying(true);
      utter.onend      = () => { setVoicePlaying(false); setVoiceProgress(0); };
      utter.onerror    = e  => {
        setVoicePlaying(false); setVoiceProgress(0);
        if (e.error === "synthesis-unavailable" || e.error === "audio-hardware-unavailable") {
          toast_("TTS engine not installed. Go to Android Settings → Accessibility → Text-to-speech and install a TTS engine.");
        } else if (e.error !== "interrupted" && e.error !== "canceled") {
          toast_("Voice error: " + e.error);
        }
      };
      utter.onboundary = e  => { if (e.name==="word") setVoiceProgress(e.charIndex/text.length); };
      utterRef.current = utter;
      // Small delay needed on Android WebView before speak() fires reliably
      setTimeout(() => { if (utterRef.current===utter) window.speechSynthesis.speak(utter); }, 120);
    } catch (err) {
      console.error("Voice:", err);
      toast_("Voice reading failed. Check that TTS is enabled in your device settings.");
    }
  };
  const stopVoice = () => {
    window.speechSynthesis?.cancel();
    utterRef.current=null; setVoicePlaying(false); setVoiceProgress(0);
  };
  const toggleVoice = () => { if (voicePlaying) stopVoice(); else startVoice(); };

  // ── DERIVED ───────────────────────────────────────────────────────────────────
  const filtLib = library.filter(b=>b.name.toLowerCase().includes(libSearch.toLowerCase()));
  const recentList = recentBooks.map(n=>library.find(b=>b.name===n)).filter(Boolean);

  // ── THEME ─────────────────────────────────────────────────────────────────────
  const d = dark;
  const bg      = d?"#03050f":"#f0f4ff";
  const surface = d?"#0c1428":"#ffffff";
  const border_ = d?C.border:"rgba(59,130,246,0.15)";
  const tx      = d?C.tx:"#0f172a";
  const txM     = d?C.txM:"#64748b";
  const inputBg = d?"rgba(255,255,255,0.06)":"rgba(0,0,0,0.04)";

  // ════════════════════════════════════════════════════════════════════════════
  return (
    <div style={{ height:"100vh", background:bg, color:tx,
      fontFamily:"'SF Pro Display','-apple-system','Segoe UI',sans-serif",
      display:"flex", flexDirection:"column", overflow:"hidden", position:"relative" }}>

      {/* Ambient glow */}
      <div style={{ position:"fixed", inset:0, pointerEvents:"none", zIndex:0 }}>
        <div style={{ position:"absolute", top:"-20%", left:"-10%", width:"60%", height:"60%",
          background:"radial-gradient(circle,rgba(37,99,235,0.10) 0%,transparent 70%)", borderRadius:"50%" }} />
        <div style={{ position:"absolute", bottom:"-20%", right:"-10%", width:"50%", height:"50%",
          background:"radial-gradient(circle,rgba(124,58,237,0.08) 0%,transparent 70%)", borderRadius:"50%" }} />
      </div>

      {/* FIX 2: key prop forces complete remount — onChange always fires */}
      <input key={`file-${fileKey}`} ref={fileInputRef}
        type="file" accept=".pdf,application/pdf"
        multiple style={{ display:"none" }}
        onChange={e=>handleFiles(e.target.files)} />
      {/* FIX: NO accept attribute on folder input — some Android WebViews filter
           files before JS sees them, causing missing PDFs. Filter in handleFolderInput instead. */}
      <input key={`folder-${scanKey}`} ref={folderInputRef}
        type="file"
        multiple webkitdirectory="" mozdirectory=""
        style={{ display:"none" }} onChange={handleFolderInput} />

      {/* Scanning overlay */}
      {scanning && (
        <div style={{ position:"fixed", inset:0, zIndex:290,
          background:"rgba(0,0,0,0.93)", backdropFilter:"blur(16px)",
          display:"flex", alignItems:"center", justifyContent:"center", padding:24 }}>
          <div style={{ background:"linear-gradient(135deg,#0c1428,#101e38)",
            borderRadius:24, padding:32, maxWidth:340, width:"100%",
            border:`1px solid ${C.borderG}`, textAlign:"center",
            boxShadow:`0 0 60px rgba(37,99,235,0.4)` }}>
            <div style={{ fontSize:48, marginBottom:16, animation:"pulse 1s ease infinite" }}>📂</div>
            <div style={{ fontSize:18, fontWeight:800, color:C.neonL, marginBottom:8 }}>Scanning Storage…</div>
            <div style={{ fontSize:40, fontWeight:900, marginBottom:6,
              background:`linear-gradient(135deg,${C.neonL},${C.purpleL})`,
              WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" }}>{scanCount}</div>
            <div style={{ fontSize:13, color:C.txM, marginBottom:20 }}>PDF{scanCount!==1?"s":""} found…</div>
            <div style={{ height:4, background:C.bg3, borderRadius:4, overflow:"hidden", marginBottom:12 }}>
              <div style={{ height:"100%", background:`linear-gradient(90deg,${C.neon},${C.purple})`,
                animation:"scan 1.5s ease infinite", width:"40%" }} />
            </div>
            <div style={{ fontSize:11, color:C.txM, overflow:"hidden",
              textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{scanStatus}</div>
          </div>
        </div>
      )}

      {/* Permission popup */}
      {showPerm && (
        <div style={{ position:"fixed", inset:0, zIndex:300,
          background:"rgba(0,0,0,0.90)", backdropFilter:"blur(16px)",
          display:"flex", alignItems:"center", justifyContent:"center", padding:24 }}>
          <div style={{ background:"linear-gradient(135deg,#0c1428,#101e38)",
            borderRadius:24, padding:32, maxWidth:340, width:"100%",
            border:`1px solid ${C.borderG}`, boxShadow:`0 0 60px rgba(37,99,235,0.3)` }}>
            <div style={{ fontSize:44, textAlign:"center", marginBottom:16 }}>📱</div>
            <div style={{ fontSize:20, fontWeight:800, color:C.neonL, textAlign:"center", marginBottom:8 }}>
              Storage Access
            </div>
            <div style={{ fontSize:13, color:C.txM, lineHeight:1.8, textAlign:"center", marginBottom:20 }}>
              Allow PDF Reader to find all PDFs on your device automatically
            </div>
            {[
              {n:"1",t:"Tap \"Scan All PDFs\" below"},
              {n:"2",t:"A file browser opens — navigate to Internal Storage"},
              {n:"3",t:"Select any PDF or tap the folder then \"Use This Folder\""},
              {n:"4",t:"No storage permission needed — the file picker handles it"},
            ].map((s,i)=>(
              <div key={i} style={{ display:"flex", alignItems:"flex-start", gap:12, marginBottom:12 }}>
                <div style={{ width:24, height:24, borderRadius:"50%", flexShrink:0,
                  background:`linear-gradient(135deg,${C.glow},${C.purple})`,
                  display:"flex", alignItems:"center", justifyContent:"center",
                  fontSize:11, fontWeight:800, color:"#fff" }}>{s.n}</div>
                <div style={{ fontSize:13, color:C.tx, lineHeight:1.5, paddingTop:3 }}>{s.t}</div>
              </div>
            ))}
            <div style={{ height:20 }} />
            <GlowBtn label="📂 Scan All PDFs" onClick={grantPermission} full />
            <div style={{ height:10 }} />
            <GlowBtn label="Pick Files Manually" full outline
              onClick={()=>{ setShowPerm(false); skipPerm(); triggerFilePicker(); }} />
            <button onClick={skipPerm} style={{ background:"none", border:"none", width:"100%",
              color:C.txM, fontSize:12, cursor:"pointer", padding:"12px", fontFamily:"inherit" }}>
              Don't ask again
            </button>
          </div>
        </div>
      )}

      {/* Drawer backdrop */}
      {drawerOpen && (
        <div style={{ position:"fixed", inset:0, zIndex:80,
          background:"rgba(0,0,0,0.6)", backdropFilter:"blur(4px)" }}
          onClick={()=>{ setDrawerOpen(false); setDrawerView("menu"); }} />
      )}

      {/* Drawer */}
      <div style={{ position:"fixed", top:0, left:0, bottom:0, width:300, zIndex:90,
        background:d?"linear-gradient(180deg,#070d1a,#0c1428)":"#ffffff",
        borderRight:`1px solid ${border_}`,
        transform:drawerOpen?"translateX(0)":"translateX(-100%)",
        transition:"transform .28s cubic-bezier(.4,0,.2,1)",
        backdropFilter:"blur(20px)", display:"flex", flexDirection:"column",
        boxShadow:drawerOpen?`6px 0 60px rgba(37,99,235,0.15)`:"none" }}>
        <div style={{ padding:"22px 20px 16px", borderBottom:`1px solid ${border_}`,
          display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <div>
            <div style={{ fontSize:18, fontWeight:800,
              background:`linear-gradient(135deg,${C.neonL},${C.purpleL})`,
              WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" }}>
              PDF Reader
            </div>
            <div style={{ fontSize:11, color:txM, marginTop:2 }}>
              {library.length} book{library.length!==1?"s":""} in library
            </div>
          </div>
          <button onClick={()=>{ setDrawerOpen(false); setDrawerView("menu"); }}
            style={{ background:"none", border:"none", color:txM, fontSize:22, cursor:"pointer" }}>×</button>
        </div>

        <div style={{ flex:1, overflowY:"auto", padding:"12px 8px" }}>
          {drawerView==="menu" ? (
            <>
              <DrawerSection label="Library" />
              <DrawerRow icon="🏠" label="My Library" sub={`${library.length} books`}
                tx={tx} txM={txM}
                onClick={()=>{ setScreen("home"); setPdfDoc(null); stopVoice(); setDrawerOpen(false); }} />
              <DrawerRow icon="➕" label="Add PDF" sub="Pick from device"
                tx={tx} txM={txM}
                onClick={()=>{ setDrawerOpen(false); triggerFilePicker(); }} />
              <DrawerRow icon="📂" label="Scan Storage" sub="Find all PDFs automatically"
                tx={tx} txM={txM}
                onClick={async()=>{ setDrawerOpen(false); await grantPermission(); }} />

              <div style={{ height:1, background:border_, margin:"10px 12px" }} />
              <DrawerSection label="Bookmarks" />
              <DrawerRow icon="🔖" label="All Saved Pages"
                sub={`${allBms.length} saved across all books`}
                tx={tx} txM={txM}
                onClick={()=>setDrawerView("allsaved")} />

              {screen==="reader" && (
                <>
                  <div style={{ height:1, background:border_, margin:"10px 12px" }} />
                  <DrawerSection label="Current Book" />
                  <DrawerRow icon="🔍" label="Search PDF" sub="Full text search"
                    tx={tx} txM={txM}
                    onClick={()=>{ setActivePanel("search"); setDrawerOpen(false); }} />
                  <DrawerRow icon="✏️" label="Notes" sub={`${Object.keys(bNotes).length} notes`}
                    tx={tx} txM={txM}
                    onClick={()=>{ setActivePanel("notes"); setDrawerOpen(false); }} />
                  <DrawerRow icon="📑" label="Contents" sub={toc.length>0?`${toc.length} sections`:"Not available"}
                    tx={tx} txM={txM}
                    onClick={()=>{ setActivePanel("toc"); setDrawerOpen(false); }} />
                </>
              )}

              <div style={{ height:1, background:border_, margin:"10px 12px" }} />
              <DrawerSection label="Settings" />
              <DrawerRow icon={d?"☀️":"🌙"} label={d?"Light Mode":"Dark Mode"}
                sub="Switch appearance" tx={tx} txM={txM}
                onClick={()=>setDark(!d)} />
            </>
          ) : (
            /* ALL SAVED PAGES */
            <>
              <div style={{ padding:"10px 12px", display:"flex", alignItems:"center", gap:10 }}>
                <button onClick={()=>setDrawerView("menu")}
                  style={{ background:"none", border:"none", cursor:"pointer",
                    color:C.neon, fontSize:13, fontFamily:"inherit", fontWeight:700 }}>← Back</button>
                <div style={{ fontSize:15, fontWeight:800, color:tx }}>
                  All Saved Pages ({allBms.length})
                </div>
              </div>
              {allBms.length===0 ? (
                <div style={{ textAlign:"center", color:txM, padding:"30px 20px", fontSize:13, lineHeight:1.7 }}>
                  No saved pages yet.<br/>Tap 🔖 while reading to save a page.
                </div>
              ) : allBms.map((item,i)=>(
                <div key={i} onClick={async()=>{
                  const book=library.find(b=>b.name===item.bookName);
                  if (book) { await openBook(book); setTimeout(()=>goToPage(item.page),800); }
                  setDrawerOpen(false); setDrawerView("menu");
                }} style={{ padding:"12px 14px", borderRadius:12, marginBottom:6,
                  cursor:"pointer", border:`1px solid ${border_}`, background:inputBg,
                  transition:"border-color .15s" }}
                  onMouseEnter={e=>e.currentTarget.style.borderColor=C.borderG}
                  onMouseLeave={e=>e.currentTarget.style.borderColor=border_}>
                  <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                    <div style={{ width:36, height:36, borderRadius:10, overflow:"hidden",
                      background:`linear-gradient(135deg,hsl(${coverHue(item.bookName)},50%,28%),hsl(${coverHue(item.bookName)+30},40%,16%))`,
                      display:"flex", alignItems:"center", justifyContent:"center",
                      fontSize:16, flexShrink:0 }}>
                      {thumbs[item.bookName]
                        ? <img src={thumbs[item.bookName]} alt="" style={{ width:"100%", height:"100%", objectFit:"cover" }} />
                        : "📄"}
                    </div>
                    <div style={{ flex:1, overflow:"hidden" }}>
                      <div style={{ fontSize:13, fontWeight:700, color:C.neonL }}>Page {item.page}</div>
                      <div style={{ fontSize:11, color:txM, marginTop:2,
                        overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                        {item.bookName}
                      </div>
                    </div>
                    <div style={{ fontSize:12, color:txM }}>›</div>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>

        {screen==="reader" && pdfDoc && (
          <div style={{ padding:"14px 18px", borderTop:`1px solid ${border_}` }}>
            <div style={{ display:"flex", justifyContent:"space-between",
              fontSize:11, color:txM, marginBottom:5 }}>
              <span>Reading Progress</span>
              <span>{Math.round((currentPage/numPages)*100)}%</span>
            </div>
            <div style={{ height:4, background:d?C.bg3:"#e2e8f0", borderRadius:4 }}>
              <div style={{ height:"100%", borderRadius:4,
                background:`linear-gradient(90deg,${C.neon},${C.purple})`,
                width:`${(currentPage/numPages)*100}%`, transition:"width .3s",
                boxShadow:`0 0 8px ${C.neon}` }} />
            </div>
            <div style={{ fontSize:11, color:txM, marginTop:4, textAlign:"center" }}>
              Page {currentPage} of {numPages}
            </div>
          </div>
        )}
      </div>

      {/* ════ HOME SCREEN ════ */}
      {screen==="home" && (
        <div style={{ flex:1, display:"flex", flexDirection:"column",
          overflow:"hidden", position:"relative", zIndex:1 }}>

          <div style={{ flexShrink:0, padding:"16px 18px 0",
            display:"flex", alignItems:"center", justifyContent:"space-between" }}>
            <button onClick={()=>{ setDrawerOpen(true); setDrawerView("menu"); }}
              style={{ background:inputBg, border:`1px solid ${border_}`,
                borderRadius:12, width:40, height:40, cursor:"pointer", color:tx,
                fontSize:18, display:"flex", alignItems:"center", justifyContent:"center" }}>☰</button>
            <div style={{ flex:1, paddingLeft:12 }}>
              <div style={{ fontSize:13, color:txM }}>{getGreeting()}</div>
            </div>
            <button onClick={()=>setDark(!d)}
              style={{ background:"none", border:"none", fontSize:20, cursor:"pointer", color:C.neon }}>
              {d?"☀️":"🌙"}
            </button>
          </div>

          <div style={{ padding:"10px 18px 0" }}>
            <div style={{ fontSize:26, fontWeight:800,
              background:`linear-gradient(135deg,${d?"#fff":C.bg0},${C.neonL})`,
              WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" }}>
              Your Library
            </div>
            <div style={{ fontSize:13, color:txM, marginTop:2 }}>
              {library.length} book{library.length!==1?"s":""} · Ready to read
            </div>
          </div>

          <div style={{ padding:"12px 18px 0" }}>
            <div style={{ position:"relative" }}>
              <span style={{ position:"absolute", left:14, top:"50%",
                transform:"translateY(-50%)", fontSize:15, color:txM }}>🔍</span>
              <input value={libSearch} onChange={e=>setLibSearch(e.target.value)}
                placeholder="Search books…"
                style={{ width:"100%", padding:"11px 14px 11px 40px",
                  borderRadius:14, border:`1.5px solid ${border_}`,
                  background:inputBg, backdropFilter:"blur(10px)",
                  color:tx, fontSize:14, fontFamily:"inherit",
                  outline:"none", boxSizing:"border-box", transition:"border-color .2s" }}
                onFocus={e=>e.target.style.borderColor=C.neon}
                onBlur={e=>e.target.style.borderColor=border_} />
              {libSearch && (
                <button onClick={()=>setLibSearch("")}
                  style={{ position:"absolute", right:12, top:"50%",
                    transform:"translateY(-50%)", background:"none",
                    border:"none", cursor:"pointer", color:txM, fontSize:18 }}>×</button>
              )}
            </div>
          </div>

          <div style={{ flex:1, overflowY:"auto", padding:"0 18px 110px" }}>
            {library.length===0 ? (
              <div style={{ display:"flex", flexDirection:"column", alignItems:"center",
                justifyContent:"center", minHeight:"55vh", gap:16, textAlign:"center" }}>
                <div style={{ fontSize:72, filter:`drop-shadow(0 0 20px rgba(37,99,235,0.4))` }}>📚</div>
                <div style={{ fontSize:20, fontWeight:800, color:C.neonL }}>No books yet</div>
                <div style={{ fontSize:14, color:txM, lineHeight:1.8, maxWidth:260 }}>
                  Tap the <strong style={{color:C.neonL}}>+</strong> button below to import your first PDF
                </div>
              </div>
            ) : (
              <>
                {/* RECENTLY OPENED */}
                {recentList.length>0 && !libSearch && (
                  <div style={{ marginTop:18 }}>
                    <SectionLabel label="Recently Opened" color={txM} />
                    <div style={{ display:"flex", gap:12, overflowX:"auto",
                      paddingBottom:4, scrollbarWidth:"none" }}>
                      {recentList.slice(0,3).map((book,i)=>(
                        <BookCard key={i} book={book}
                          hue={coverHue(book.name)}
                          thumb={thumbs[book.name]}
                          lastPage={lastRead[book.name]}
                          bms={(bookmarks[book.name]||[]).length}
                          onOpen={()=>openBook(book)}
                          onAction={()=>setRecentBooks(prev=>prev.filter(n=>n!==book.name))}
                          actionLabel="×"
                          width={108} height={148}
                          d={d} txM={txM} />
                      ))}
                    </div>
                  </div>
                )}

                {/* ALL BOOKS — FIX i: same proportions as recently opened */}
                <div style={{ marginTop:20 }}>
                  <SectionLabel
                    label={libSearch?`Results (${filtLib.length})`:`All Books (${library.length})`}
                    color={txM} />
                  {filtLib.length===0 ? (
                    <div style={{ textAlign:"center", padding:"28px 0", color:txM, fontSize:14 }}>
                      No books match "<span style={{color:C.neonL}}>{libSearch}</span>"
                    </div>
                  ) : (
                    /* FIX i: 3 equal columns, same card height as recently opened */
                    <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:12 }}>
                      {filtLib.map((book,i)=>(
                        <BookCard key={i} book={book}
                          hue={coverHue(book.name)}
                          thumb={thumbs[book.name]}
                          lastPage={lastRead[book.name]}
                          bms={(bookmarks[book.name]||[]).length}
                          onOpen={()=>openBook(book)}
                          onAction={()=>{
                            if (window.confirm(`Remove "${book.name}"?`)) {
                              dbDeletePDF(book.name).catch(()=>{});
                              setLibrary(prev=>prev.filter(b=>b.name!==book.name));
                              setRecentBooks(prev=>prev.filter(n=>n!==book.name));
                              toast_("Removed from library");
                            }
                          }}
                          actionLabel="×"
                          gridMode={true}
                          d={d} txM={txM} />
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          {/* FIX v: Smaller + button (52px instead of 64px) */}
          <div style={{ position:"fixed", bottom:0, left:0, right:0,
            display:"flex", justifyContent:"center", alignItems:"flex-end",
            pointerEvents:"none", zIndex:20 }}>
            <div style={{ position:"relative", pointerEvents:"auto" }}>
              <div style={{ position:"absolute", bottom:-2, left:"50%",
                transform:"translateX(-50%)",
                width:plusPressed?42:58, height:plusPressed?5:8,
                background:`radial-gradient(ellipse,rgba(37,99,235,${plusPressed?0.2:0.35}) 0%,transparent 70%)`,
                borderRadius:"50%", transition:"all .15s" }} />
              <button
                onMouseDown={()=>setPlusPressed(true)}
                onMouseUp={()=>setPlusPressed(false)}
                onTouchStart={()=>setPlusPressed(true)}
                onTouchEnd={(e)=>{ e.preventDefault(); setPlusPressed(false); triggerFilePicker(); }}
                onClick={()=>triggerFilePicker()}
                style={{ marginBottom:22,
                  width:plusPressed?46:52, height:plusPressed?46:52, // FIX v: smaller
                  borderRadius:"50%",
                  background:plusPressed
                    ?`linear-gradient(135deg,#1d4ed8,${C.purple})`
                    :`linear-gradient(135deg,${C.glow},${C.purple})`,
                  border:"none", cursor:"pointer",
                  fontSize:plusPressed?24:26, color:"#fff",
                  display:"flex", alignItems:"center", justifyContent:"center",
                  boxShadow:plusPressed
                    ?`0 2px 10px rgba(37,99,235,0.6), 0 0 0 6px rgba(37,99,235,0.08)`
                    :`0 6px 24px rgba(37,99,235,0.6), 0 0 0 10px rgba(37,99,235,0.10)`,
                  transform:plusPressed?"translateY(3px) scale(0.93)":"translateY(0) scale(1)",
                  transition:"all .15s cubic-bezier(.34,1.56,.64,1)",
                  lineHeight:1 }}>
                +
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ════ READER SCREEN ════ */}
      {screen==="reader" && (
        <div style={{ flex:1, display:"flex", flexDirection:"column",
          overflow:"hidden", position:"relative", zIndex:1 }}>

          {/* Top bar — in flow */}
          <div style={{ flexShrink:0,
            background:d?"rgba(7,13,26,0.97)":"rgba(255,255,255,0.97)",
            borderBottom:`1px solid ${border_}`,
            padding:"11px 14px",
            display:"flex", alignItems:"center", gap:10,
            opacity:showControls?1:0, transition:"opacity .3s",
            pointerEvents:showControls?"auto":"none" }}>
            <button onClick={()=>{ setDrawerOpen(true); setDrawerView("menu"); }}
              style={glassBtn()}>☰</button>
            <div style={{ flex:1, overflow:"hidden" }}>
              <div style={{ fontSize:12, fontWeight:700, color:C.neonL,
                whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>
                {currentBook?.name}
              </div>
              <div style={{ fontSize:10, color:txM }}>Page {currentPage} of {numPages}</div>
            </div>
            <button onClick={()=>setZoom(z=>Math.max(0.4, parseFloat((z-0.03).toFixed(2))))}
              style={glassBtn()}>−</button>
            <span style={{ fontSize:10, color:txM, minWidth:36, textAlign:"center" }}>
              {Math.round(zoom*100)}%
            </span>
            <button onClick={()=>setZoom(z=>Math.min(4, parseFloat((z+0.03).toFixed(2))))}
              style={glassBtn()}>+</button>
          </div>

          {/* PDF canvas area */}
          <div ref={containerRef}
            onTouchStart={onTS} onTouchMove={onTM} onTouchEnd={onTE}
            onClick={()=>{ touchControls(); if(activePanelRef.current) setActivePanel(null); }}
            style={{ flex:1, overflowY:"auto", overflowX:"hidden",
              display:"flex", flexDirection:"column", alignItems:"center",
              background:d?"linear-gradient(180deg,#0f0f1a,#141428)":"#e8edf5",
              WebkitOverflowScrolling:"touch",
              paddingTop:8, paddingBottom:8 }}>

            {rendering && (
              <div style={{ position:"fixed", top:"50%", left:"50%",
                transform:"translate(-50%,-50%)", zIndex:20,
                background:C.glass, backdropFilter:"blur(12px)",
                border:`1px solid ${C.borderG}`, borderRadius:20,
                padding:"8px 20px", fontSize:12, color:C.neonL }}>
                Rendering…
              </div>
            )}

            <div style={{ width:"100%",
              transition: "transform 0.25s ease", // 🔥 animation
              boxShadow:d
                ?"0 0 40px rgba(37,99,235,0.12),0 8px 40px rgba(0,0,0,0.7)"
                :"0 4px 24px rgba(0,0,0,0.15)" }}>
              <canvas ref={canvasRef} style={{ display:"block", width:"100%" }} />
            </div>

            {bNotes[currentPage] && (
              <div dir="auto" style={{ margin:"12px 12px 0", width:"calc(100% - 24px)",
                background:C.glass, backdropFilter:"blur(12px)",
                border:`1px solid ${border_}`, borderRadius:12,
                padding:"10px 14px", fontSize:13, color:txM }}>
                <span style={{ color:C.neonL, fontWeight:700 }}>✏️ Note: </span>
                {bNotes[currentPage]}
              </div>
            )}
          </div>

          {/* Bottom controls */}
          <div style={{ flexShrink:0,
            background:d?"rgba(7,13,26,0.97)":"rgba(255,255,255,0.97)",
            borderTop:`1px solid ${border_}`,
            opacity:showControls?1:0, transition:"opacity .3s",
            pointerEvents:showControls?"auto":"none" }}>

            {/* Prev / page / next */}
            <div style={{ display:"flex", alignItems:"center",
              justifyContent:"space-between", padding:"10px 14px 6px", gap:6 }}>
              <button onClick={()=>goToPage(1)} disabled={currentPage===1}
                style={{ ...glassBtn({width:34,height:34,fontSize:12}), opacity:currentPage===1?.3:1 }}>⏮</button>
              <button onClick={()=>goToPage(currentPage-1)} disabled={currentPage===1}
                style={{ ...glassBtn({padding:"0 12px",width:"auto",height:34,fontSize:11,borderRadius:20}),
                  opacity:currentPage===1?.3:1 }}>◀ Prev</button>
              <div style={{ flex:1, textAlign:"center" }}>
                <div style={{ fontSize:13, fontWeight:800, color:C.neonL }}>
                  {currentPage} / {numPages}
                </div>
                <div style={{ height:3, background:d?C.bg3:"#e2e8f0",
                  borderRadius:3, marginTop:3 }}>
                  <div style={{ height:"100%", borderRadius:3,
                    background:`linear-gradient(90deg,${C.neon},${C.purple})`,
                    width:`${(currentPage/numPages)*100}%`, transition:"width .3s",
                    boxShadow:`0 0 6px ${C.neon}` }} />
                </div>
              </div>
              <button onClick={()=>goToPage(currentPage+1)} disabled={currentPage===numPages}
                style={{ ...glassBtn({padding:"0 12px",width:"auto",height:34,fontSize:11,borderRadius:20}),
                  opacity:currentPage===numPages?.3:1 }}>Next ▶</button>
              <button onClick={()=>goToPage(numPages)} disabled={currentPage===numPages}
                style={{ ...glassBtn({width:34,height:34,fontSize:12}), opacity:currentPage===numPages?.3:1 }}>⏭</button>
            </div>

            {/* 5 icon buttons */}
            <div style={{ display:"flex", borderTop:`1px solid ${border_}` }}>
              {[
                { icon:"🔍", key:"search", tip:"Search" },
                { icon:"🔖", key:"saved",  tip:"Saved"  },
                { icon:"🎧", key:"voice",  tip:"Listen" },
                { icon:"✏️",  key:"notes",  tip:"Notes"  },
                { icon:"🔢", key:"goto",   tip:"Go to"  },
              ].map(item=>(
                <button key={item.key}
                  onClick={()=>{
                    if (item.key==="saved") { toggleBm(); return; }
                    setActivePanel(activePanel===item.key?null:item.key);
                  }}
                  style={{ flex:1, background:"transparent", border:"none",
                    cursor:"pointer", padding:"9px 2px 11px",
                    borderTop:activePanel===item.key||(item.key==="saved"&&isBm)
                      ?`2px solid ${C.neon}`:"2px solid transparent",
                    color:activePanel===item.key||(item.key==="saved"&&isBm)?C.neonL:txM,
                    fontFamily:"inherit", transition:"all .15s" }}>
                  <div style={{ fontSize:item.key==="saved"&&isBm?22:20,
                    filter:activePanel===item.key||(item.key==="saved"&&isBm)
                      ?`drop-shadow(0 0 6px ${C.neon})`:"none",
                    transition:"filter .2s" }}>
                    {item.key==="saved"&&isBm?"🔖":item.icon}
                  </div>
                  <div style={{ fontSize:9, marginTop:2, fontWeight:600 }}>{item.tip}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Panels */}
          {activePanel && (
            <div style={{ position:"fixed", bottom:0, left:0, right:0,
              background:d
                ?"linear-gradient(180deg,rgba(7,13,26,0.99),#070d1a)"
                :"rgba(255,255,255,0.98)",
              backdropFilter:"blur(20px)",
              border:`1px solid ${border_}`,
              borderTop:`1.5px solid ${C.borderG}`,
              borderRadius:"22px 22px 0 0",
              maxHeight:"65vh", overflowY:"auto",
              zIndex:30, animation:"slideUp .3s cubic-bezier(.4,0,.2,1)",
              boxShadow:`0 -16px 60px rgba(37,99,235,0.14)` }}>
              <div style={{ display:"flex", justifyContent:"center", padding:"12px 0 6px" }}>
                <div style={{ width:36, height:4, borderRadius:4, cursor:"pointer",
                  background:`linear-gradient(90deg,${C.neon},${C.purple})` }}
                  onClick={()=>setActivePanel(null)} />
              </div>
              <div style={{ padding:"4px 20px 100px" }}>

                {/* SEARCH */}
                {activePanel==="search" && (
                  <>
                    <PanelTitle title="🔍 Search PDF" tx={tx} />
                    <div style={{ display:"flex", gap:10, marginBottom:14 }}>
                      <div style={{ flex:1, position:"relative" }}>
                        <span style={{ position:"absolute", left:14, top:"50%",
                          transform:"translateY(-50%)", fontSize:14, color:txM }}>🔍</span>
                        <input value={searchQ} onChange={e=>setSearchQ(e.target.value)}
                          onKeyDown={e=>e.key==="Enter"&&runSearch()}
                          placeholder="Search entire document…" dir="auto"
                          style={{ width:"100%", padding:"13px 40px 13px 40px",
                            borderRadius:14, border:`1.5px solid ${C.borderG}`,
                            background:inputBg, color:tx, fontSize:14,
                            fontFamily:"inherit", outline:"none", boxSizing:"border-box" }} />
                        {searchQ&&(
                          <button onClick={()=>{setSearchQ("");setSearchRes([]);}}
                            style={{ position:"absolute",right:12,top:"50%",
                              transform:"translateY(-50%)",background:"none",
                              border:"none",cursor:"pointer",color:txM,fontSize:18 }}>×</button>
                        )}
                      </div>
                      <button onClick={runSearch}
                        style={{ background:`linear-gradient(135deg,${C.glow},${C.purple})`,
                          border:"none",borderRadius:14,padding:"0 20px",
                          color:"#fff",fontWeight:700,cursor:"pointer",fontSize:14 }}>Go</button>
                    </div>
                    {searchRes.length>0&&(
                      <div style={{ display:"flex",alignItems:"center",
                        justifyContent:"space-between",marginBottom:14,
                        background:"rgba(59,130,246,0.08)",borderRadius:12,
                        padding:"10px 14px",border:`1px solid ${border_}` }}>
                        <div style={{ fontSize:12,color:C.neonL,fontWeight:700 }}>
                          {searchTotal} matches · {searchRes.length} pages
                        </div>
                        <div style={{ display:"flex",gap:8,alignItems:"center" }}>
                          <button onClick={()=>jumpResult(-1)}
                            style={glassBtn({width:30,height:30,fontSize:12})}>↑</button>
                          <span style={{ fontSize:11,color:txM }}>{resultIdx+1}/{searchRes.length}</span>
                          <button onClick={()=>jumpResult(1)}
                            style={glassBtn({width:30,height:30,fontSize:12})}>↓</button>
                        </div>
                      </div>
                    )}
                    {searching&&<div style={{ textAlign:"center",color:C.neonL,padding:14,fontSize:13 }}>
                      Searching {numPages} pages…</div>}
                    {!searching&&searchQ&&!searchRes.length&&(
                      <div style={{ textAlign:"center",color:txM,padding:18,fontSize:14 }}>
                        No results for "<span style={{color:C.neonL}}>{searchQ}</span>"
                      </div>
                    )}
                    {searchRes.map((r,i)=>(
                      <div key={i} onClick={()=>{goToPage(r.page);setResultIdx(i);}}
                        style={{ ...glassCard(r.page===currentPage&&i===resultIdx),
                          marginBottom:10,cursor:"pointer" }}>
                        <div style={{ display:"flex",justifyContent:"space-between",
                          alignItems:"center",marginBottom:8 }}>
                          <div style={{ fontSize:13,fontWeight:700,color:C.neonL }}>Page {r.page}</div>
                          <div style={{ fontSize:10,color:txM,
                            background:"rgba(59,130,246,0.12)",borderRadius:8,padding:"2px 8px" }}>
                            {r.count} match{r.count!==1?"es":""}
                          </div>
                        </div>
                        {r.snippets.map((s,j)=>(
                          <div key={j} dir="auto" style={{ fontSize:12,color:txM,
                            lineHeight:1.6,marginBottom:j<r.snippets.length-1?6:0 }}>
                            …{s.before}
                            <span style={{ background:"rgba(59,130,246,0.3)",
                              color:"#fff",borderRadius:3,padding:"0 2px",fontWeight:700 }}>
                              {s.match}
                            </span>
                            {s.after}…
                          </div>
                        ))}
                      </div>
                    ))}
                  </>
                )}

                {/* GO TO PAGE */}
                {activePanel==="goto" && (
                  <>
                    <PanelTitle title="🔢 Go to Page" tx={tx} />
                    <div style={{ display:"flex",gap:10,marginBottom:20 }}>
                      <input type="number" value={goInput}
                        onChange={e=>setGoInput(e.target.value)}
                        onKeyDown={e=>{if(e.key==="Enter"){goToPage(parseInt(goInput));setGoInput("");setActivePanel(null);}}}
                        placeholder={`1 – ${numPages}`}
                        style={{ flex:1,padding:"14px 16px",borderRadius:14,
                          border:`1.5px solid ${C.borderG}`,background:inputBg,
                          color:tx,fontSize:16,fontFamily:"inherit",outline:"none" }} />
                      <button onClick={()=>{goToPage(parseInt(goInput));setGoInput("");setActivePanel(null);}}
                        style={{ background:`linear-gradient(135deg,${C.glow},${C.purple})`,
                          border:"none",borderRadius:14,padding:"0 22px",
                          color:"#fff",fontWeight:700,cursor:"pointer",fontSize:14 }}>Go</button>
                    </div>
                    <div style={{ display:"flex",gap:8,flexWrap:"wrap" }}>
                      {[1,Math.floor(numPages*.25),Math.floor(numPages*.5),Math.floor(numPages*.75),numPages]
                        .filter((v,i,a)=>v>0&&a.indexOf(v)===i)
                        .map(pg=>(
                          <button key={pg} onClick={()=>{goToPage(pg);setActivePanel(null);}}
                            style={{ background:pg===currentPage
                              ?`linear-gradient(135deg,${C.glow},${C.purple})`:inputBg,
                              border:`1px solid ${pg===currentPage?C.neon:border_}`,
                              color:pg===currentPage?"#fff":tx,
                              padding:"9px 14px",borderRadius:12,fontSize:12,
                              cursor:"pointer",fontFamily:"inherit",fontWeight:600 }}>
                            {pg===1?"First":pg===numPages?"Last":`Page ${pg}`}
                          </button>
                        ))}
                    </div>
                  </>
                )}

                {/* VOICE */}
                {activePanel==="voice" && (
                  <>
                    <PanelTitle title="🎧 Voice Reader" tx={tx} />

                    {/* TTS not supported at all */}
                    {'speechSynthesis' in window === false ? (
                      <div style={{ textAlign:"center", padding:"24px 16px",
                        background:"rgba(239,68,68,0.08)", borderRadius:16,
                        border:"1px solid rgba(239,68,68,0.25)" }}>
                        <div style={{ fontSize:36, marginBottom:12 }}>🔇</div>
                        <div style={{ fontSize:14, fontWeight:700, color:"#f87171", marginBottom:8 }}>
                          Voice Reading Not Available
                        </div>
                        <div style={{ fontSize:12, color:txM, lineHeight:1.8 }}>
                          Your browser doesn't support Text-to-Speech.<br/>
                          Please use <strong style={{color:C.neonL}}>Google Chrome</strong> for voice reading.<br/>
                          Also make sure a TTS engine is installed in:<br/>
                          <strong style={{color:C.neonL}}>Settings → Accessibility → Text-to-speech</strong>
                        </div>
                      </div>
                    ) : (
                      <>
                    {/* Language detected + gender toggle */}
                    <div style={{ display:"flex", alignItems:"center",
                      justifyContent:"space-between", marginBottom:16,
                      background:"rgba(59,130,246,0.08)", borderRadius:12,
                      padding:"10px 14px", border:`1px solid ${border_}` }}>
                      <div style={{ fontSize:12, color:txM }}>
                        🌐 Language detected:&nbsp;
                        <span style={{ color:C.neonL, fontWeight:700 }}>
                          {{en:"English",ur:"اردو",ar:"Arabic",hi:"हिन्दी",zh:"中文",fr:"Français"}[detectedLang]||"English"}
                        </span>
                      </div>
                      {/* Male / Female toggle */}
                      <div style={{ display:"flex", borderRadius:10, overflow:"hidden",
                        border:`1px solid ${C.border}` }}>
                        {["female","male"].map(g=>(
                          <button key={g} onClick={()=>{ setVoiceGender(g); if(voicePlaying){stopVoice();setTimeout(startVoice,200);} }}
                            style={{ padding:"5px 10px", border:"none", cursor:"pointer",
                              fontSize:11, fontWeight:700, fontFamily:"inherit",
                              background:voiceGender===g?`linear-gradient(135deg,${C.glow},${C.purple})`:"transparent",
                              color:voiceGender===g?"#fff":txM }}>
                            {g==="female"?"♀ F":"♂ M"}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div style={{ fontSize:12,color:txM,marginBottom:12 }}>
                      Page {currentPage} — {voicePlaying?"Reading…":"Tap play to listen"}
                    </div>
                    <div style={{ display:"flex",alignItems:"center",
                      justifyContent:"center",gap:3,margin:"12px 0",height:52 }}>
                      {Array.from({length:22}).map((_,i)=>(
                        <div key={i} style={{ width:4,borderRadius:4,
                          background:voicePlaying
                            ?`linear-gradient(180deg,${C.neon},${C.purple})`
                            :"rgba(59,130,246,0.2)",
                          height:voicePlaying?`${28+Math.abs(Math.sin(i*.5))*72}%`:"20%",
                          animation:voicePlaying?`wave .7s ease ${i*.04}s infinite alternate`:"none",
                          transition:"height .2s" }} />
                      ))}
                    </div>
                    <div style={{ height:4,background:d?C.bg3:"#e2e8f0",borderRadius:4,marginBottom:20 }}>
                      <div style={{ height:"100%",borderRadius:4,
                        background:`linear-gradient(90deg,${C.neon},${C.purple})`,
                        width:`${voiceProgress*100}%`,transition:"width .3s" }} />
                    </div>
                    <div style={{ display:"flex",justifyContent:"center",gap:20,
                      marginBottom:20,alignItems:"center" }}>
                      <button onClick={()=>goToPage(currentPage-1)} disabled={currentPage===1}
                        style={{ ...glassBtn({width:44,height:44}),opacity:currentPage===1?.3:1 }}>⏮</button>
                      <button onClick={toggleVoice}
                        style={{ width:68,height:68,borderRadius:"50%",
                          background:`linear-gradient(135deg,${C.glow},${C.purple})`,
                          border:"none",cursor:"pointer",fontSize:26,color:"#fff",
                          boxShadow:`0 0 40px rgba(37,99,235,0.5)`,
                          display:"flex",alignItems:"center",justifyContent:"center" }}>
                        {voicePlaying?"⏸":"▶"}
                      </button>
                      <button onClick={()=>{stopVoice();goToPage(currentPage+1);}}
                        disabled={currentPage===numPages}
                        style={{ ...glassBtn({width:44,height:44}),opacity:currentPage===numPages?.3:1 }}>⏭</button>
                    </div>
                    <div style={{ textAlign:"center" }}>
                      <div style={{ fontSize:12,color:txM,marginBottom:8 }}>
                        Speed: <span style={{color:C.neonL,fontWeight:700}}>{voiceSpeed}x</span>
                      </div>
                      <input type="range" min="0.5" max="2" step="0.1" value={voiceSpeed}
                        onChange={e=>{
                          setVoiceSpeed(parseFloat(e.target.value));
                          if (voicePlaying){stopVoice();setTimeout(startVoice,200);}
                        }}
                        style={{ width:"80%",accentColor:C.neon }} />
                      <div style={{ display:"flex",justifyContent:"space-between",
                        width:"80%",margin:"4px auto 0",fontSize:10,color:txM }}>
                        <span>0.5x</span><span>1x</span><span>1.5x</span><span>2x</span>
                      </div>
                    </div>
                    {/* Available voices count */}
                    <div style={{ textAlign:"center", marginTop:12, fontSize:10,
                      color: voices.length === 0 ? "#f87171" : C.txD }}>
                      {voices.length === 0
                        ? "⚠️ No TTS voices found. Install a TTS engine in Settings → Accessibility → Text-to-speech"
                        : `${voices.length} voice${voices.length!==1?"s":""} available`}
                    </div>
                      </>
                    )}
                  </> 
                )}

                {/* NOTES */}
                {activePanel==="notes" && (
                  <>
                    <PanelTitle title={`✏️ Note — Page ${currentPage}`} tx={tx} />
                    <textarea value={noteInput} onChange={e=>setNoteInput(e.target.value)}
                      dir="auto" placeholder="Write your note here…"
                      style={{ width:"100%",minHeight:100,padding:14,borderRadius:14,
                        border:`1.5px solid ${C.borderG}`,background:inputBg,
                        color:tx,fontSize:14,fontFamily:"inherit",resize:"vertical",
                        boxSizing:"border-box",outline:"none",lineHeight:1.7,marginBottom:12 }} />
                    <div style={{ display:"flex",gap:10,marginBottom:18 }}>
                      <GlowBtn label="Save Note" onClick={saveNote} />
                      {bNotes[currentPage]&&(
                        <GlowBtn label="Delete" outline onClick={()=>{
                          setNoteInput("");const u={...bNotes};delete u[currentPage];
                          setNotes(p=>({...p,[bKey]:u}));toast_("Note deleted");
                        }} />
                      )}
                    </div>
                    {Object.keys(bNotes).length>0&&(
                      <>
                        <div style={{ fontSize:11,color:txM,fontWeight:700,
                          textTransform:"uppercase",letterSpacing:".08em",marginBottom:10 }}>
                          All Notes in This Book
                        </div>
                        {Object.entries(bNotes).sort(([a],[b])=>Number(a)-Number(b)).map(([pg,note])=>(
                          <div key={pg} onClick={()=>{goToPage(Number(pg));setActivePanel(null);}}
                            style={{ ...glassCard(Number(pg)===currentPage),
                              marginBottom:8,cursor:"pointer" }}>
                            <div style={{ fontSize:12,color:C.neonL,fontWeight:700,marginBottom:4 }}>
                              Page {pg}
                            </div>
                            <div dir="auto" style={{ fontSize:12,color:txM,
                              overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>
                              {note}
                            </div>
                          </div>
                        ))}
                      </>
                    )}
                  </>
                )}

                {/* TOC */}
                {activePanel==="toc" && (
                  <>
                    <PanelTitle title="📑 Contents" tx={tx} />
                    {toc.length===0
                      ?<div style={{ textAlign:"center",color:txM,padding:"20px 0",fontSize:14 }}>
                        This PDF has no table of contents.
                      </div>
                      :toc.map((item,i)=>(
                        <div key={i} dir="auto" onClick={()=>navToc(item)}
                          style={{ padding:"10px 12px",paddingLeft:12+item.depth*18,
                            borderRadius:10,cursor:"pointer",marginBottom:4,
                            fontSize:item.depth===0?14:12,
                            fontWeight:item.depth===0?700:400,
                            color:item.depth===0?C.neonL:tx,
                            borderLeft:item.depth>0?`2px solid ${border_}`:"none",
                            transition:"background .15s" }}
                          onMouseEnter={e=>e.currentTarget.style.background="rgba(59,130,246,0.08)"}
                          onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                          {item.title}
                        </div>
                      ))}
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div style={{ position:"fixed", bottom:90, left:"50%",
          transform:"translateX(-50%)",
          background:toast.type==="success"
            ?`linear-gradient(135deg,${C.glow},${C.purple})`
            :d?"rgba(12,20,40,0.95)":"rgba(255,255,255,0.95)",
          backdropFilter:"blur(12px)",
          color:toast.type==="success"?"#fff":tx,
          padding:"10px 22px", borderRadius:24, fontSize:13,
          boxShadow:`0 4px 28px rgba(37,99,235,0.35)`,
          border:`1px solid ${C.borderG}`,
          zIndex:500, whiteSpace:"nowrap",
          animation:"fadeUp .2s ease", fontWeight:600 }}>
          {toast.msg}
        </div>
      )}

      <style>{`
        @keyframes fadeUp{from{opacity:0;transform:translateX(-50%) translateY(12px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}
        @keyframes slideUp{from{transform:translateY(100%)}to{transform:translateY(0)}}
        @keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
        @keyframes wave{0%{transform:scaleY(.5)}100%{transform:scaleY(1.5)}}
        @keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.7;transform:scale(1.1)}}
        @keyframes scan{0%{transform:translateX(-100%)}100%{transform:translateX(350%)}}
        ::-webkit-scrollbar{width:3px;height:3px}
        ::-webkit-scrollbar-track{background:transparent}
        ::-webkit-scrollbar-thumb{background:rgba(59,130,246,0.25);border-radius:4px}
        input::-webkit-inner-spin-button{opacity:.5}
        *{box-sizing:border-box}
        input:focus,textarea:focus{outline:none}
        input[type=range]{-webkit-appearance:none;height:4px;border-radius:4px;background:rgba(59,130,246,0.15)}
        input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:18px;height:18px;border-radius:50%;background:linear-gradient(135deg,#2563eb,#7c3aed);cursor:pointer}
      `}</style>
    </div>
  );
}

// ── BookCard — FIXED HEIGHT for both grid and row so all cards are identical ──
// Root cause of size difference: thumbnail images had varying aspect ratios
// which caused cards to grow/shrink. Fix: always use a fixed pixel height (148px)
// and use objectFit:"cover" to fill it — thumbnail never changes card size.
const CARD_H = 148; // single constant controls height everywhere

function BookCard({ book, hue, thumb, lastPage, bms, onOpen, onAction, actionLabel, gridMode, d, txM }) {
  return (
    <div style={{
      width: gridMode ? "100%" : 108,
      flexShrink: gridMode ? undefined : 0,
      position:"relative",
      animation: gridMode ? "fadeIn .3s ease both" : undefined,
      cursor:"pointer",
    }} onClick={onOpen}>

      {/* Cover — ALWAYS exactly CARD_H pixels tall */}
      <div style={{
        height: CARD_H,        // ← fixed height, never changes
        borderRadius:14,
        overflow:"hidden",     // ← clips thumbnail to this box
        background:`linear-gradient(160deg,hsl(${hue},58%,26%),hsl(${hue+30},48%,15%))`,
        border:`1px solid hsl(${hue},38%,32%)`,
        boxShadow:`0 0 16px hsla(${hue},55%,35%,.20),0 6px 24px rgba(0,0,0,.5)`,
        display:"flex", flexDirection:"column", alignItems:"center",
        justifyContent:"center", position:"relative",
        marginBottom:6, transition:"transform .2s, box-shadow .2s",
      }}
        onMouseEnter={e=>{e.currentTarget.style.transform="translateY(-3px)";e.currentTarget.style.boxShadow=`0 0 24px hsla(${hue},55%,35%,.36),0 12px 30px rgba(0,0,0,.6)`;}}
        onMouseLeave={e=>{e.currentTarget.style.transform="";e.currentTarget.style.boxShadow=`0 0 16px hsla(${hue},55%,35%,.20),0 6px 24px rgba(0,0,0,.5)`;}} >

        {thumb ? (
          // objectFit:"cover" fills the fixed box — never stretches the card
          <img src={thumb} alt={book.name}
            style={{ position:"absolute", inset:0, width:"100%", height:"100%",
              objectFit:"cover", display:"block" }} />
        ) : (
          <>
            <div style={{ fontSize:20, marginBottom:6 }}>📄</div>
            <div dir="auto" style={{ fontSize:9, color:`hsl(${hue},16%,88%)`,
              textAlign:"center", fontWeight:700, lineHeight:1.35, padding:"0 8px",
              display:"-webkit-box", WebkitLineClamp:4,
              WebkitBoxOrient:"vertical", overflow:"hidden" }}>
              {book.name}
            </div>
          </>
        )}

        {/* Overlay badges — always on top of thumbnail */}
        {lastPage && (
          <div style={{ position:"absolute", bottom:6, left:"50%",
            transform:"translateX(-50%)",
            background:"rgba(0,0,0,0.70)", borderRadius:8,
            padding:"2px 8px", fontSize:9,
            color:`hsl(${hue},40%,80%)`, whiteSpace:"nowrap", zIndex:2 }}>
            Pg {lastPage}
          </div>
        )}
        {bms>0 && (
          <div style={{ position:"absolute", top:5, right:5,
            background:"rgba(0,0,0,0.80)", borderRadius:6,
            padding:"1px 5px", fontSize:8, color:C.neonL, zIndex:2 }}>
            🔖{bms}
          </div>
        )}
      </div>

      {/* Name — 2 lines max, same font size everywhere */}
      <div dir="auto" style={{ fontSize:10, fontWeight:700,
        color:d?C.txM:"#334155",
        lineHeight:1.4, marginBottom:2,
        display:"-webkit-box", WebkitLineClamp:2,
        WebkitBoxOrient:"vertical", overflow:"hidden" }}>
        {book.name}
      </div>

      {/* Action button (× remove) */}
      <button onClick={e=>{ e.stopPropagation(); onAction(); }}
        style={{ position:"absolute", top:4, left:4,
          background:"rgba(0,0,0,0.75)", border:"none", borderRadius:"50%",
          width:22, height:22, cursor:"pointer", color:"#fff", fontSize:12,
          display:"flex", alignItems:"center", justifyContent:"center", zIndex:3 }}>
        {actionLabel}
      </button>
    </div>
  );
}

function GlowBtn({ label, onClick, full, outline }) {
  return (
    <button onClick={onClick}
      style={{ background:outline?"transparent":`linear-gradient(135deg,${C.glow},${C.purple})`,
        border:`1px solid ${outline?C.borderG:"transparent"}`,
        color:"#fff", padding:"12px 22px", borderRadius:14,
        fontSize:14, fontWeight:700, cursor:"pointer", fontFamily:"inherit",
        width:full?"100%":"auto",
        boxShadow:outline?"none":`0 4px 24px rgba(37,99,235,0.4)`,
        transition:"transform .15s" }}
      onMouseEnter={e=>e.currentTarget.style.transform="scale(1.02)"}
      onMouseLeave={e=>e.currentTarget.style.transform="scale(1)"}>
      {label}
    </button>
  );
}
function SectionLabel({ label, color }) {
  return (
    <div style={{ fontSize:12, fontWeight:800, color:color||C.txM,
      textTransform:"uppercase", letterSpacing:".08em", marginBottom:12 }}>
      {label}
    </div>
  );
}
function PanelTitle({ title, tx }) {
  return <div style={{ fontSize:16, fontWeight:800, color:tx||C.tx, marginBottom:16 }}>{title}</div>;
}
function DrawerSection({ label }) {
  return (
    <div style={{ fontSize:10, fontWeight:800, color:C.txM,
      textTransform:"uppercase", letterSpacing:".1em",
      padding:"6px 14px 4px" }}>{label}</div>
  );
}
function DrawerRow({ icon, label, sub, onClick, tx, txM }) {
  return (
    <div onClick={onClick}
      style={{ display:"flex", alignItems:"center", gap:14,
        padding:"12px 14px", borderRadius:14, cursor:"pointer",
        marginBottom:2, transition:"background .15s" }}
      onMouseEnter={e=>e.currentTarget.style.background="rgba(59,130,246,0.10)"}
      onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
      <div style={{ fontSize:20, width:28, textAlign:"center" }}>{icon}</div>
      <div style={{ flex:1 }}>
        <div style={{ fontSize:14, fontWeight:600, color:tx }}>{label}</div>
        <div style={{ fontSize:11, color:txM, marginTop:1 }}>{sub}</div>
      </div>
      <div style={{ color:C.txM, fontSize:14 }}>›</div>
    </div>
  );
}
