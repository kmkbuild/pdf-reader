import { useState, useEffect, useRef, useCallback } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// PDF.js
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// FIX 2: IndexedDB — version bumped to 2, bookmarks/notes get their OWN store
// Root cause was: settings store stored everything as one flat key, and the
// auto-save effects were firing BEFORE restore finished (race condition).
// Solution: dedicated stores + restored flag prevents premature overwrites.
// ─────────────────────────────────────────────────────────────────────────────
const DB_NAME = "PDFReaderDB";
const DB_VERSION = 2; // bumped from 1 → triggers onupgradeneeded migration

function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = e => {
      const db = e.target.result;
      // PDFs store — unchanged
      if (!db.objectStoreNames.contains("pdfs"))
        db.createObjectStore("pdfs", { keyPath: "name" });
      // Settings store — unchanged
      if (!db.objectStoreNames.contains("settings"))
        db.createObjectStore("settings", { keyPath: "key" });
      // NEW: dedicated bookmarks store keyed by bookName
      if (!db.objectStoreNames.contains("bookmarks"))
        db.createObjectStore("bookmarks", { keyPath: "bookName" });
      // NEW: dedicated notes store keyed by bookName
      if (!db.objectStoreNames.contains("notes"))
        db.createObjectStore("notes", { keyPath: "bookName" });
    };
    r.onsuccess = e => res(e.target.result);
    r.onerror = e => rej(e.target.error);
  });
}

// PDF storage
async function dbSavePDF(name, buf, size, modified) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction("pdfs", "readwrite");
    tx.objectStore("pdfs").put({ name, data: buf, size, modified });
    tx.oncomplete = res;
    tx.onerror = e => rej(e.target.error);
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
    tx.oncomplete = res;
    tx.onerror = e => rej(e.target.error);
  });
}

// Settings (simple key-value)
async function dbSet(key, value) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction("settings", "readwrite");
    tx.objectStore("settings").put({ key, value });
    tx.oncomplete = res;
    tx.onerror = e => rej(e.target.error);
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

// Bookmarks — saved per book so one book can't corrupt another
async function dbSaveBookmarks(bookName, pages) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction("bookmarks", "readwrite");
    tx.objectStore("bookmarks").put({ bookName, pages });
    tx.oncomplete = res;
    tx.onerror = e => rej(e.target.error);
  });
}
async function dbGetAllBookmarks() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction("bookmarks", "readonly");
    const r = tx.objectStore("bookmarks").getAll();
    r.onsuccess = e => {
      // Convert array of {bookName, pages} → object {bookName: pages[]}
      const map = {};
      (e.target.result || []).forEach(row => { map[row.bookName] = row.pages; });
      res(map);
    };
    r.onerror = e => rej(e.target.error);
  });
}

// Notes — saved per book per page
async function dbSaveNotes(bookName, pageNotes) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction("notes", "readwrite");
    tx.objectStore("notes").put({ bookName, pageNotes });
    tx.oncomplete = res;
    tx.onerror = e => rej(e.target.error);
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

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
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

// FIX 1: Skip system/hidden dirs that block scanner on Android
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
          onFound?.({
            name: n.replace(/\.pdf$/i, ""),
            file: f, size: f.size, modified: f.lastModified,
          });
        } catch {}
      } else if (h.kind === "directory" && !lo.startsWith(".") && !SKIP_DIRS.has(lo)) {
        await scanDir(h, depth + 1, onFound);
      }
    }
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Design tokens
// ─────────────────────────────────────────────────────────────────────────────
const C = {
  bg0: "#03050f", bg1: "#070d1a", bg2: "#0c1428", bg3: "#101e38",
  glass: "rgba(12,20,40,0.75)", glow: "#2563eb", purple: "#7c3aed",
  neon: "#3b82f6", neonL: "#60a5fa", purpleL: "#a78bfa",
  border: "rgba(59,130,246,0.18)", borderG: "rgba(59,130,246,0.45)",
  tx: "#e2e8f0", txM: "#64748b", txD: "#1e293b", white: "#ffffff",
};

const glassBtn = (extra = {}) => ({
  background: C.glass, backdropFilter: "blur(12px)",
  border: `1px solid ${C.border}`, borderRadius: 12,
  color: C.tx, cursor: "pointer",
  display: "flex", alignItems: "center", justifyContent: "center",
  width: 38, height: 38, fontSize: 16, transition: "border-color .2s",
  ...extra,
});

const glassCard = (active = false) => ({
  background: active ? "rgba(59,130,246,0.14)" : "rgba(255,255,255,0.04)",
  backdropFilter: "blur(10px)",
  border: `1px solid ${active ? C.borderG : C.border}`,
  borderRadius: 16, padding: "14px 16px",
  boxShadow: active ? `0 0 20px rgba(37,99,235,0.2)` : "none",
  transition: "all .2s",
});

// ─────────────────────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState("home");
  const [screen, setScreen] = useState("home");
  const [pdfjsReady, setPdfjsReady] = useState(false);

  // Library
  const [library, setLibrary] = useState([]);
  const [recentBooks, setRecentBooks] = useState([]);
  const [libSearch, setLibSearch] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scanCount, setScanCount] = useState(0);
  const [scanStatus, setScanStatus] = useState("");
  const [toast, setToast] = useState(null);
  const [showPerm, setShowPerm] = useState(false);
  const [permState, setPermState] = useState("unknown");

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
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Search
  const [searchQ, setSearchQ] = useState("");
  const [searchRes, setSearchRes] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchTotal, setSearchTotal] = useState(0);
  const [textCache, setTextCache] = useState({});
  const [currentResultIdx, setCurrentResultIdx] = useState(0);

  // Voice
  const [voicePlaying, setVoicePlaying] = useState(false);
  const [voiceSpeed, setVoiceSpeed] = useState(1);
  const [voiceProgress, setVoiceProgress] = useState(0);
  const utterRef = useRef(null);

  const canvasRef = useRef(null);
  const renderTaskRef = useRef(null);
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null); // FIX 1: separate input for folders
  const containerRef = useRef(null);
  const pinchRef = useRef({ active: false, startDist: 0, startZoom: 1 });
  const controlsTimer = useRef(null);

  // FIX 2: Restored flag — prevents auto-save BEFORE data loads from DB
  const restoredRef = useRef(false);

  // FIX 3: Refs for back button — always has latest state without stale closure
  const screenRef = useRef("home");
  const activePanelRef = useRef(null);
  const drawerOpenRef = useRef(false);
  useEffect(() => { screenRef.current = screen; }, [screen]);
  useEffect(() => { activePanelRef.current = activePanel; }, [activePanel]);
  useEffect(() => { drawerOpenRef.current = drawerOpen; }, [drawerOpen]);

  // ── BOOT ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    // Load PDF.js engine
    loadScript(PDFJS_URL).then(() => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER_URL;
      setPdfjsReady(true);
    });

    // Restore all persisted data from IndexedDB
    const restore = async () => {
      try {
        // Restore PDF library
        const rows = await dbGetAllPDFs();
        if (rows.length) {
          setLibrary(rows.map(r => ({
            name: r.name,
            file: new File([r.data], r.name + ".pdf", { type: "application/pdf" }),
            size: r.size,
            modified: r.modified,
          })));
        }

        // FIX 2: Load bookmarks and notes from dedicated stores
        const [bm, nt, lr, rb, perm] = await Promise.all([
          dbGetAllBookmarks(),   // {bookName: pages[]}
          dbGetAllNotes(),       // {bookName: {page: note}}
          dbGet("lastRead"),     // {bookName: pageNum}
          dbGet("recentBooks"),  // [name, name, ...]
          dbGet("permState"),    // "granted"|"skipped"|null
        ]);

        if (bm && Object.keys(bm).length) setBookmarks(bm);
        if (nt && Object.keys(nt).length) setNotes(nt);
        if (lr) setLastRead(lr);
        if (rb) setRecentBooks(rb);
        if (perm === "granted" || perm === "skipped") setPermState(perm);
        else setTimeout(() => setShowPerm(true), 900);

      } catch (err) {
        console.error("Restore error:", err);
        setTimeout(() => setShowPerm(true), 900);
      } finally {
        // FIX 2: Only allow auto-save AFTER full restore is done
        restoredRef.current = true;
      }
    };

    restore();
  }, []);

  // ── BACK BUTTON — Capacitor Android fix ──────────────────────────────────
  // ROOT CAUSE: Capacitor does NOT fire 'popstate' on Android back press.
  // It fires 'backbutton' on document. popstate = browser only. Never worked.
  // FIX: Listen to 'backbutton' (Capacitor/Cordova) AND 'popstate' (browser).
  // Uses refs so handler is never stale — registered once, works forever.
  useEffect(() => {
    // For browser fallback — push state so popstate has something to catch
    window.history.pushState({ page: 1 }, "");

    const handleBack = (e) => {
      // Prevent default Android back behaviour (which exits the app)
      if (e && e.preventDefault) e.preventDefault();
      if (e && e.detail && e.detail.register) {
        // Capacitor's backbutton event — must call register to claim it
        e.detail.register(10, () => handleNavigation());
        return;
      }
      handleNavigation();
    };

    const handleNavigation = () => {
      // Re-push for browser popstate (keeps history alive)
      try { window.history.pushState({ page: 1 }, ""); } catch {}

      // Priority: drawer → panel → reader → minimize
      if (drawerOpenRef.current) {
        setDrawerOpen(false);
        return;
      }
      if (activePanelRef.current) {
        setActivePanel(null);
        return;
      }
      if (screenRef.current === "reader") {
        setScreen("home");
        setTab("home");
        setPdfDoc(null);
        stopVoice();
        return;
      }
      // On home — minimize app instead of exiting
      try {
        // Capacitor App plugin
        if (window.Capacitor?.Plugins?.App) {
          window.Capacitor.Plugins.App.minimizeApp();
          return;
        }
      } catch {}
      // Android WebView fallback
      try { window.history.go(-1); } catch {}
    };

    // Capacitor Android fires this on document
    document.addEventListener("backbutton", handleBack, false);
    // Capacitor v3+ fires this
    document.addEventListener("ionBackButton", handleBack, false);
    // Browser fallback
    window.addEventListener("popstate", handleNavigation);

    return () => {
      document.removeEventListener("backbutton", handleBack, false);
      document.removeEventListener("ionBackButton", handleBack, false);
      window.removeEventListener("popstate", handleNavigation);
    };
  }, []); // Empty deps — safe because we use refs

  // ── FIX 2: AUTO-SAVE — only runs after restore is complete ─────────────────
  useEffect(() => {
    if (!restoredRef.current) return; // Don't save before loading!
    // Save each book's bookmarks individually
    Object.entries(bookmarks).forEach(([bookName, pages]) => {
      dbSaveBookmarks(bookName, pages).catch(() => {});
    });
  }, [bookmarks]);

  useEffect(() => {
    if (!restoredRef.current) return; // Don't save before loading!
    // Save each book's notes individually
    Object.entries(notes).forEach(([bookName, pageNotes]) => {
      dbSaveNotes(bookName, pageNotes).catch(() => {});
    });
  }, [notes]);

  useEffect(() => {
    if (!restoredRef.current) return;
    dbSet("lastRead", lastRead).catch(() => {});
  }, [lastRead]);

  useEffect(() => {
    if (!restoredRef.current) return;
    dbSet("recentBooks", recentBooks).catch(() => {});
  }, [recentBooks]);

  useEffect(() => {
    if (currentBook) setNoteInput(notes[currentBook.name]?.[currentPage] || "");
  }, [currentPage, currentBook]);

  const toast_ = (msg, type = "info") => {
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

  // ── FIX 1: STORAGE PERMISSION & FILE ACCESS ────────────────────────────────
  // Root cause: showDirectoryPicker() is NOT available in Capacitor's Android
  // WebView. Fix: use two separate <input> elements — one for single files,
  // one with webkitdirectory for folder scanning. This works in all WebViews.
  // Also handle the folder scan gracefully when API is unavailable.

  const grantPermission = async () => {
    setShowPerm(false);
    setPermState("granted");
    dbSet("permState", "granted").catch(() => {});

    // Try modern File System Access API first (Chrome desktop/modern browsers)
    if ("showDirectoryPicker" in window) {
      try {
        const dir = await window.showDirectoryPicker({ mode: "read" });
        await runFolderScan(dir);
        return;
      } catch (e) {
        if (e?.name === "AbortError") return; // user cancelled
        // Fall through to input-based method
      }
    }

    // FIX 1: Fallback — trigger webkitdirectory input (works in Capacitor WebView)
    folderInputRef.current?.click();
  };

  // Handles folder selected via <input webkitdirectory>
  const handleFolderInput = async (e) => {
    const files = Array.from(e.target.files || []);
    const pdfs = files.filter(f => f.name.toLowerCase().endsWith(".pdf"));
    if (!pdfs.length) { toast_("No PDFs found in that folder."); return; }

    setScanning(true); setScanCount(0);
    const seen = new Set(library.map(b => b.name));
    let count = 0;

    for (const f of pdfs) {
      const name = f.name.replace(/\.pdf$/i, "");
      if (seen.has(name)) continue;
      seen.add(name); count++;
      setScanCount(count); setScanStatus(`Found: ${name}`);
      const book = { name, file: f, size: f.size, modified: f.lastModified };
      try {
        const buf = await f.arrayBuffer();
        await dbSavePDF(name, buf, f.size, f.lastModified);
      } catch {}
      setLibrary(prev => prev.find(b => b.name === name) ? prev : [...prev, book]);
    }

    setScanning(false); setScanStatus("");
    // Reset input so same folder can be re-scanned
    e.target.value = "";
    if (count === 0) toast_("No new PDFs found.");
    else toast_(`Found ${count} PDF${count > 1 ? "s" : ""}!`, "success");
  };

  // Scan via File System Access API (when available)
  const runFolderScan = async (dir) => {
    setScanning(true); setScanCount(0); setScanStatus("Scanning…");
    const seen = new Set(library.map(b => b.name));
    let count = 0;

    const onFound = async (book) => {
      if (seen.has(book.name)) return;
      seen.add(book.name); count++;
      setScanCount(count); setScanStatus(`Found: ${book.name}`);
      try {
        const buf = await book.file.arrayBuffer();
        await dbSavePDF(book.name, buf, book.size, book.modified);
      } catch {}
      setLibrary(prev => prev.find(b => b.name === book.name) ? prev : [...prev, book]);
    };

    await scanDir(dir, 0, onFound);
    setScanning(false); setScanStatus("");
    if (count === 0) toast_("No new PDFs found. Select Internal Storage root.");
    else toast_(`Found ${count} PDF${count > 1 ? "s" : ""}!`, "success");
  };

  const skipPerm = () => {
    setShowPerm(false); setPermState("skipped");
    dbSet("permState", "skipped").catch(() => {});
  };

  // Add PDFs manually (file picker — single/multiple files)
  const handleFiles = async (files) => {
    if (!files?.length) return;
    const books = Array.from(files)
      .filter(f => f.name.toLowerCase().endsWith(".pdf"))
      .map(f => ({ name: f.name.replace(/\.pdf$/i, ""), file: f, size: f.size, modified: f.lastModified }));
    if (!books.length) return;
    for (const b of books) {
      try {
        const buf = await b.file.arrayBuffer();
        await dbSavePDF(b.name, buf, b.size, b.modified);
      } catch {}
    }
    setLibrary(prev => {
      const s = new Set(prev.map(x => x.name));
      return [...prev, ...books.filter(x => !s.has(x.name))];
    });
    toast_(`${books.length} PDF${books.length > 1 ? "s" : ""} added!`, "success");
    // Reset so same file can be re-added if needed
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // ── OPEN BOOK ────────────────────────────────────────────────────────────────
  const openBook = async (book) => {
    if (!pdfjsReady) { toast_("PDF engine loading, please wait…"); return; }
    stopVoice();
    setCurrentBook(book); setToc([]);
    setSearchRes([]); setSearchQ(""); setTextCache({});
    setActivePanel(null); setDrawerOpen(false);
    setRecentBooks(prev => [book.name, ...prev.filter(n => n !== book.name)].slice(0, 6));
    const resumePage = lastRead[book.name] || 1;
    try {
      const buf = await book.file.arrayBuffer();
      const doc = await window.pdfjsLib.getDocument({
        data: buf,
        cMapUrl: `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PV}/cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PV}/standard_fonts/`,
      }).promise;
      setCurrentPage(resumePage); setNumPages(doc.numPages); setPdfDoc(doc);
      try { setToc(flattenOutline(await doc.getOutline())); } catch { setToc([]); }
      setScreen("reader"); setTab("reader"); setShowControls(true);
    } catch { toast_("Could not open this PDF.", "error"); }
  };

  const flattenOutline = (items, d = 0) => {
    if (!items) return [];
    return items.flatMap(i => [
      { title: i.title, dest: i.dest, depth: d },
      ...flattenOutline(i.items, d + 1),
    ]);
  };

  // ── RENDER PAGE ──────────────────────────────────────────────────────────────
  const renderPage = useCallback(async (doc, pageNum, scaleOvr) => {
    if (!canvasRef.current || !doc) return;
    if (renderTaskRef.current) {
      try { renderTaskRef.current.cancel(); } catch {}
    }
    setRendering(true);
    try {
      const page = await doc.getPage(pageNum);
      const ctr = containerRef.current;
      const availW = ctr ? ctr.clientWidth - 8 : window.innerWidth - 8;
      const fit = availW / page.getViewport({ scale: 1 }).width;
      const scale = scaleOvr !== undefined ? scaleOvr : fit;
      const dpr = window.devicePixelRatio || 1;
      const vp = page.getViewport({ scale });
      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d");
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      canvas.style.width = `${Math.floor(vp.width)}px`;
      canvas.style.height = `${Math.floor(vp.height)}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, vp.width, vp.height);
      const task = page.render({ canvasContext: ctx, viewport: vp, intent: "display" });
      renderTaskRef.current = task;
      await task.promise;
      if (scaleOvr === undefined) setZoom(fit);
    } catch (e) {
      if (e?.name !== "RenderingCancelledException") console.error(e);
    } finally { setRendering(false); }
  }, []);

  useEffect(() => { if (pdfDoc) renderPage(pdfDoc, currentPage, undefined); }, [pdfDoc, currentPage]);
  const zt = useRef(null);
  useEffect(() => {
    if (!pdfDoc) return;
    clearTimeout(zt.current);
    zt.current = setTimeout(() => renderPage(pdfDoc, currentPage, zoom), 150);
  }, [zoom]);

  // ── PINCH ZOOM ───────────────────────────────────────────────────────────────
  const onTS = (e) => {
    if (e.touches.length !== 2) return;
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    pinchRef.current = { active: true, startDist: Math.hypot(dx, dy), startZoom: zoom };
  };
  const onTM = (e) => {
    if (!pinchRef.current.active || e.touches.length !== 2) return;
    e.preventDefault();
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    const ratio = Math.hypot(dx, dy) / pinchRef.current.startDist;
    setZoom(parseFloat(Math.max(0.5, Math.min(4, pinchRef.current.startZoom * ratio)).toFixed(2)));
  };
  const onTE = () => { pinchRef.current.active = false; };

  // ── NAVIGATION ───────────────────────────────────────────────────────────────
  const goToPage = (n) => {
    const p = Math.max(1, Math.min(n, numPages));
    setCurrentPage(p);
    if (currentBook) setLastRead(prev => ({ ...prev, [currentBook.name]: p }));
  };
  const navToc = async (item) => {
    if (!pdfDoc || !item.dest) return;
    try {
      let d = item.dest;
      if (typeof d === "string") d = await pdfDoc.getDestination(d);
      if (!d) return;
      goToPage((await pdfDoc.getPageIndex(d[0])) + 1);
      setActivePanel(null);
    } catch {}
  };

  // ── BOOKMARKS ────────────────────────────────────────────────────────────────
  const bKey = currentBook?.name || "";
  const bBms = bookmarks[bKey] || [];
  const isBm = bBms.includes(currentPage);
  const toggleBm = () => {
    if (isBm) {
      setBookmarks(p => ({ ...p, [bKey]: bBms.filter(x => x !== currentPage) }));
      toast_("Bookmark removed");
    } else {
      setBookmarks(p => ({ ...p, [bKey]: [...bBms, currentPage].sort((a, b) => a - b) }));
      toast_(`Page ${currentPage} bookmarked!`, "success");
    }
  };

  // ── NOTES ────────────────────────────────────────────────────────────────────
  const bNotes = notes[bKey] || {};
  const saveNote = () => {
    const u = { ...bNotes };
    if (!noteInput.trim()) delete u[currentPage];
    else u[currentPage] = noteInput;
    setNotes(p => ({ ...p, [bKey]: u }));
    toast_(noteInput.trim() ? "Note saved!" : "Note deleted", "success");
  };

  // ── SEARCH ───────────────────────────────────────────────────────────────────
  const getPageText = async (doc, p) => {
    if (textCache[p]) return textCache[p];
    const page = await doc.getPage(p);
    const c = await page.getTextContent();
    const text = c.items.map(i => i.str).join(" ");
    setTextCache(prev => ({ ...prev, [p]: text }));
    return text;
  };

  const runSearch = async () => {
    if (!pdfDoc || !searchQ.trim()) return;
    setSearching(true); setSearchRes([]); setSearchTotal(0); setCurrentResultIdx(0);
    const q = searchQ.trim().toLowerCase();
    const results = [];
    let totalMatches = 0;
    for (let p = 1; p <= numPages; p++) {
      try {
        const text = await getPageText(pdfDoc, p);
        const lower = text.toLowerCase();
        let idx = lower.indexOf(q);
        const snippets = [];
        let count = 0;
        while (idx !== -1) {
          count++;
          if (snippets.length < 3) {
            const start = Math.max(0, idx - 40);
            const end = Math.min(text.length, idx + q.length + 40);
            snippets.push({
              before: text.slice(start, idx),
              match: text.slice(idx, idx + q.length),
              after: text.slice(idx + q.length, end),
            });
          }
          idx = lower.indexOf(q, idx + 1);
        }
        if (snippets.length) { totalMatches += count; results.push({ page: p, snippets, count }); }
      } catch {}
    }
    setSearchRes(results); setSearchTotal(totalMatches); setSearching(false);
    if (!results.length) toast_(`No results for "${searchQ}"`);
    else toast_(`${totalMatches} matches on ${results.length} pages`, "success");
  };

  const jumpResult = (dir) => {
    if (!searchRes.length) return;
    const newIdx = (currentResultIdx + dir + searchRes.length) % searchRes.length;
    setCurrentResultIdx(newIdx);
    goToPage(searchRes[newIdx].page);
  };

  // ── VOICE ────────────────────────────────────────────────────────────────────
  const startVoice = async () => {
    if (!pdfDoc) return;
    try {
      const text = await getPageText(pdfDoc, currentPage);
      if (!text.trim()) { toast_("No readable text on this page."); return; }
      stopVoice();
      const utter = new SpeechSynthesisUtterance(text);
      utter.rate = voiceSpeed;
      utter.onstart = () => setVoicePlaying(true);
      utter.onend = () => { setVoicePlaying(false); setVoiceProgress(0); };
      utter.onboundary = (e) => {
        if (e.name === "word") setVoiceProgress(e.charIndex / text.length);
      };
      utterRef.current = utter;
      window.speechSynthesis.speak(utter);
    } catch { toast_("Text-to-speech not available."); }
  };
  const stopVoice = () => {
    window.speechSynthesis?.cancel();
    utterRef.current = null;
    setVoicePlaying(false); setVoiceProgress(0);
  };
  const toggleVoice = () => { if (voicePlaying) stopVoice(); else startVoice(); };

  // ── DERIVED ──────────────────────────────────────────────────────────────────
  const filtLib = library.filter(b =>
    b.name.toLowerCase().includes(libSearch.toLowerCase())
  );
  const recentList = recentBooks.map(n => library.find(b => b.name === n)).filter(Boolean);

  // ════════════════════════════════════════════════════════════════════════════
  // RENDER
  // ════════════════════════════════════════════════════════════════════════════
  return (
    <div style={{ height: "100vh", background: C.bg0, color: C.tx,
      fontFamily: "'SF Pro Display','-apple-system','Segoe UI',sans-serif",
      display: "flex", flexDirection: "column", overflow: "hidden",
      position: "relative" }}>

      {/* Ambient glow */}
      <div style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 0 }}>
        <div style={{ position: "absolute", top: "-20%", left: "-10%", width: "60%", height: "60%",
          background: "radial-gradient(circle, rgba(37,99,235,0.10) 0%, transparent 70%)", borderRadius: "50%" }} />
        <div style={{ position: "absolute", bottom: "-20%", right: "-10%", width: "50%", height: "50%",
          background: "radial-gradient(circle, rgba(124,58,237,0.08) 0%, transparent 70%)", borderRadius: "50%" }} />
      </div>

      {/* FIX 1: Dual file inputs — single files + folder scanning */}
      <input ref={fileInputRef} type="file" accept=".pdf,application/pdf"
        multiple style={{ display: "none" }}
        onChange={e => handleFiles(e.target.files)} />
      {/* webkitdirectory works in Capacitor Android WebView */}
      <input ref={folderInputRef} type="file" accept=".pdf"
        multiple webkitdirectory="" mozdirectory=""
        style={{ display: "none" }}
        onChange={handleFolderInput} />

      {/* Scanning overlay */}
      {scanning && (
        <div style={{ position: "fixed", inset: 0, zIndex: 290,
          background: "rgba(0,0,0,0.93)", backdropFilter: "blur(16px)",
          display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
          <div style={{ background: "linear-gradient(135deg,#0c1428,#101e38)",
            borderRadius: 24, padding: 32, maxWidth: 340, width: "100%",
            border: `1px solid ${C.borderG}`,
            boxShadow: `0 0 60px rgba(37,99,235,0.4)`, textAlign: "center" }}>
            <div style={{ fontSize: 48, marginBottom: 16, animation: "pulse 1s ease infinite" }}>📂</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: C.neonL, marginBottom: 8 }}>
              Scanning Storage…
            </div>
            <div style={{ fontSize: 40, fontWeight: 900, marginBottom: 6,
              background: `linear-gradient(135deg,${C.neonL},${C.purpleL})`,
              WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
              {scanCount}
            </div>
            <div style={{ fontSize: 13, color: C.txM, marginBottom: 20 }}>
              PDF{scanCount !== 1 ? "s" : ""} found so far…
            </div>
            <div style={{ height: 4, background: C.bg3, borderRadius: 4, overflow: "hidden", marginBottom: 12 }}>
              <div style={{ height: "100%", background: `linear-gradient(90deg,${C.neon},${C.purple})`,
                boxShadow: `0 0 10px ${C.neon}`, animation: "scan 1.5s ease infinite", width: "40%" }} />
            </div>
            <div style={{ fontSize: 11, color: C.txM,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {scanStatus || "Searching…"}
            </div>
          </div>
        </div>
      )}

      {/* Permission popup */}
      {showPerm && (
        <div style={{ position: "fixed", inset: 0, zIndex: 300,
          background: "rgba(0,0,0,0.88)", backdropFilter: "blur(14px)",
          display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
          <div style={{ background: "linear-gradient(135deg,#0c1428,#101e38)",
            borderRadius: 24, padding: 32, maxWidth: 340, width: "100%",
            border: `1px solid ${C.borderG}`,
            boxShadow: `0 0 60px rgba(37,99,235,0.3)` }}>
            <div style={{ fontSize: 44, textAlign: "center", marginBottom: 16 }}>📱</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: C.neonL, textAlign: "center", marginBottom: 8 }}>
              Allow Storage Access
            </div>
            <div style={{ fontSize: 13, color: C.txM, lineHeight: 1.8, textAlign: "center", marginBottom: 20 }}>
              Find all PDFs on your device automatically
            </div>
            {[
              { n: "1", t: "Tap the button below" },
              { n: "2", t: "Select your Internal Storage folder" },
              { n: "3", t: "App scans and finds all PDFs" },
            ].map((s, i) => (
              <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 12 }}>
                <div style={{ width: 24, height: 24, borderRadius: "50%", flexShrink: 0,
                  background: `linear-gradient(135deg,${C.glow},${C.purple})`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 11, fontWeight: 800, color: "#fff" }}>{s.n}</div>
                <div style={{ fontSize: 13, color: C.tx, lineHeight: 1.5, paddingTop: 3 }}>{s.t}</div>
              </div>
            ))}
            <div style={{ height: 20 }} />
            <GlowBtn label="📂 Scan Storage for All PDFs" onClick={grantPermission} full />
            <div style={{ height: 10 }} />
            <GlowBtn label="Pick PDFs Manually" full outline
              onClick={() => { setShowPerm(false); skipPerm(); fileInputRef.current?.click(); }} />
            <button onClick={skipPerm} style={{ background: "none", border: "none", width: "100%",
              color: C.txM, fontSize: 12, cursor: "pointer", padding: "12px", fontFamily: "inherit" }}>
              Don't ask again
            </button>
          </div>
        </div>
      )}

      {/* Drawer backdrop */}
      {drawerOpen && (
        <div style={{ position: "fixed", inset: 0, zIndex: 80,
          background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
          onClick={() => setDrawerOpen(false)} />
      )}

      {/* Drawer */}
      <div style={{ position: "fixed", top: 0, left: 0, bottom: 0, width: 300, zIndex: 90,
        background: "linear-gradient(180deg,#070d1a,#0c1428)",
        borderRight: `1px solid ${C.border}`,
        transform: drawerOpen ? "translateX(0)" : "translateX(-100%)",
        transition: "transform .28s cubic-bezier(.4,0,.2,1)",
        backdropFilter: "blur(20px)", display: "flex", flexDirection: "column",
        boxShadow: drawerOpen ? `6px 0 60px rgba(37,99,235,0.15)` : "none" }}>
        <div style={{ padding: "24px 20px 16px", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ fontSize: 20, fontWeight: 800,
              background: `linear-gradient(135deg,${C.neonL},${C.purpleL})`,
              WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
              PDF Reader
            </div>
            <button onClick={() => setDrawerOpen(false)}
              style={{ background: "none", border: "none", color: C.txM, fontSize: 22, cursor: "pointer" }}>×</button>
          </div>
          <div style={{ fontSize: 12, color: C.txM, marginTop: 4 }}>{library.length} books in library</div>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "12px 8px" }}>
          {[
            { icon: "🏠", label: "My Library", sub: `${library.length} books`,
              action: () => { setScreen("home"); setTab("home"); setPdfDoc(null); stopVoice(); setDrawerOpen(false); } },
            { icon: "➕", label: "Add PDF", sub: "Import from device",
              action: () => { setDrawerOpen(false); fileInputRef.current?.click(); } },
            { icon: "📂", label: "Scan Storage", sub: "Find all PDFs automatically",
              action: async () => { setDrawerOpen(false); await grantPermission(); } },
            ...(screen === "reader" ? [
              null,
              { icon: "🔖", label: "Saved Pages", sub: `${bBms.length} in this book`,
                action: () => { setActivePanel("saved"); setDrawerOpen(false); } },
              { icon: "🔢", label: "Go to Page", sub: `Page ${currentPage} of ${numPages}`,
                action: () => { setActivePanel("goto"); setDrawerOpen(false); } },
              { icon: "🔍", label: "Search PDF", sub: "Full text with highlights",
                action: () => { setActivePanel("search"); setDrawerOpen(false); } },
              { icon: "🎧", label: "Voice Reader", sub: "Listen to this page",
                action: () => { setActivePanel("voice"); setDrawerOpen(false); } },
              { icon: "✏️", label: "Notes", sub: `${Object.keys(bNotes).length} notes`,
                action: () => { setActivePanel("notes"); setDrawerOpen(false); } },
              { icon: "📑", label: "Contents", sub: toc.length > 0 ? `${toc.length} sections` : "Not available",
                action: () => { setActivePanel("toc"); setDrawerOpen(false); } },
            ] : []),
          ].map((item, i) =>
            item === null
              ? <div key={i} style={{ height: 1, background: C.border, margin: "8px 12px" }} />
              : (
                <div key={i} onClick={item.action}
                  style={{ display: "flex", alignItems: "center", gap: 14,
                    padding: "13px 14px", borderRadius: 14, cursor: "pointer",
                    marginBottom: 2, transition: "background .15s" }}
                  onMouseEnter={e => e.currentTarget.style.background = "rgba(59,130,246,0.1)"}
                  onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                  <div style={{ fontSize: 20, width: 28, textAlign: "center" }}>{item.icon}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: C.tx }}>{item.label}</div>
                    <div style={{ fontSize: 11, color: C.txM }}>{item.sub}</div>
                  </div>
                  <div style={{ color: C.txM, fontSize: 14 }}>›</div>
                </div>
              )
          )}
        </div>

        {screen === "reader" && pdfDoc && (
          <div style={{ padding: "14px 18px", borderTop: `1px solid ${C.border}` }}>
            <div style={{ display: "flex", justifyContent: "space-between",
              fontSize: 11, color: C.txM, marginBottom: 6 }}>
              <span>Reading Progress</span>
              <span>{Math.round((currentPage / numPages) * 100)}%</span>
            </div>
            <div style={{ height: 4, background: C.bg3, borderRadius: 4 }}>
              <div style={{ height: "100%", borderRadius: 4,
                background: `linear-gradient(90deg,${C.neon},${C.purple})`,
                width: `${(currentPage / numPages) * 100}%`, transition: "width .3s",
                boxShadow: `0 0 8px ${C.neon}` }} />
            </div>
            <div style={{ fontSize: 11, color: C.txM, marginTop: 5, textAlign: "center" }}>
              Page {currentPage} of {numPages}
            </div>
          </div>
        )}
      </div>

      {/* ── SCREENS ── */}
      <div style={{ flex: 1, overflow: "hidden", position: "relative", zIndex: 1 }}>

        {/* ════ HOME ════ */}
        {tab === "home" && (
          <div style={{ height: "100%", overflowY: "auto", padding: "0 0 90px" }}>
            <div style={{ padding: "20px 20px 0", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <button onClick={() => setDrawerOpen(true)}
                style={{ background: "rgba(255,255,255,0.06)", border: `1px solid ${C.border}`,
                  borderRadius: 12, width: 40, height: 40, cursor: "pointer", color: C.tx,
                  fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center" }}>☰</button>
              <button onClick={() => fileInputRef.current?.click()}
                style={{ background: `linear-gradient(135deg,${C.glow},${C.purple})`,
                  border: "none", borderRadius: 12, padding: "8px 18px",
                  color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer",
                  boxShadow: `0 4px 20px rgba(37,99,235,0.4)` }}>+ Import</button>
            </div>

            <div style={{ padding: "22px 20px 0" }}>
              <div style={{ fontSize: 13, color: C.txM, marginBottom: 4 }}>{getGreeting()}</div>
              <div style={{ fontSize: 26, fontWeight: 800,
                background: `linear-gradient(135deg,${C.white},${C.neonL})`,
                WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
                Your Library
              </div>
              <div style={{ fontSize: 13, color: C.txM, marginTop: 4 }}>
                {library.length} book{library.length !== 1 ? "s" : ""} · Ready to read
              </div>
            </div>

            <div style={{ padding: "16px 20px 0" }}>
              <div style={{ position: "relative" }}>
                <span style={{ position: "absolute", left: 14, top: "50%",
                  transform: "translateY(-50%)", fontSize: 15, color: C.txM }}>🔍</span>
                <input value={libSearch} onChange={e => setLibSearch(e.target.value)}
                  placeholder="Search your books…"
                  style={{ width: "100%", padding: "12px 14px 12px 40px", borderRadius: 14,
                    border: `1px solid ${C.border}`, background: "rgba(255,255,255,0.05)",
                    backdropFilter: "blur(10px)", color: C.tx, fontSize: 14,
                    fontFamily: "inherit", outline: "none", boxSizing: "border-box",
                    transition: "border-color .2s" }}
                  onFocus={e => e.target.style.borderColor = C.neon}
                  onBlur={e => e.target.style.borderColor = C.border} />
                {libSearch && (
                  <button onClick={() => setLibSearch("")}
                    style={{ position: "absolute", right: 12, top: "50%",
                      transform: "translateY(-50%)", background: "none",
                      border: "none", cursor: "pointer", color: C.txM, fontSize: 18 }}>×</button>
                )}
              </div>
            </div>

            {library.length === 0 ? (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center",
                justifyContent: "center", minHeight: "55vh", gap: 16, textAlign: "center", padding: "0 32px" }}>
                <div style={{ fontSize: 64, filter: "drop-shadow(0 0 20px rgba(59,130,246,0.4))" }}>📖</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: C.neonL }}>No books yet</div>
                <div style={{ fontSize: 14, color: C.txM, lineHeight: 1.8 }}>
                  Import your first PDF to start reading
                </div>
                <GlowBtn label="📂 Import PDF" onClick={() => fileInputRef.current?.click()} />
                <GlowBtn label="📁 Scan Storage" onClick={grantPermission} outline />
              </div>
            ) : (
              <>
                {recentList.length > 0 && !libSearch && (
                  <div style={{ padding: "24px 20px 0" }}>
                    <SectionLabel label="Recently Opened" />
                    <div style={{ display: "flex", gap: 14, overflowX: "auto", paddingBottom: 4, scrollbarWidth: "none" }}>
                      {recentList.slice(0, 6).map((book, i) => (
                        <RecentCard key={i} book={book} lastPage={lastRead[book.name]}
                          hue={coverHue(book.name)} onOpen={() => openBook(book)}
                          onRemove={() => setRecentBooks(prev => prev.filter(n => n !== book.name))} />
                      ))}
                    </div>
                  </div>
                )}
                {recentList.length > 0 && !libSearch && (
                  <div style={{ margin: "20px 20px 0", height: 1, background: C.border }} />
                )}
                <div style={{ padding: "20px 20px 0" }}>
                  <SectionLabel label={libSearch ? `Results (${filtLib.length})` : `All Books (${library.length})`} />
                  {filtLib.length === 0 ? (
                    <div style={{ textAlign: "center", padding: "32px 0", color: C.txM, fontSize: 14 }}>
                      No books match "<span style={{ color: C.neonL }}>{libSearch}</span>"
                    </div>
                  ) : (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12 }}>
                      {filtLib.map((book, i) => (
                        <LibCard key={i} book={book} hue={coverHue(book.name)}
                          lastPage={lastRead[book.name]}
                          bmsCount={(bookmarks[book.name] || []).length}
                          onOpen={() => openBook(book)}
                          onDelete={() => {
                            if (window.confirm(`Remove "${book.name}"?`)) {
                              dbDeletePDF(book.name).catch(() => {});
                              setLibrary(prev => prev.filter(b => b.name !== book.name));
                              setRecentBooks(prev => prev.filter(n => n !== book.name));
                              toast_("Removed from library");
                            }
                          }} />
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {/* ════ READER ════ */}
        {tab === "reader" && screen === "reader" && (
          <div style={{ height: "100%", display: "flex", flexDirection: "column",
            background: "#0f0f1a", position: "relative" }}>

            {/* ── Top bar — IN FLOW (not absolute) so PDF always starts below it ── */}
            <div style={{
              flexShrink: 0,
              background: "rgba(7,13,26,0.97)",
              borderBottom: showControls ? `1px solid ${C.border}` : "1px solid transparent",
              padding: "12px 14px",
              display: "flex", alignItems: "center", gap: 10,
              zIndex: 10,
              // Fade out when not interacting — but keep height so PDF doesn't jump
              opacity: showControls ? 1 : 0,
              transition: "opacity .3s, border-color .3s",
              pointerEvents: showControls ? "auto" : "none",
            }}>
              <button onClick={() => setDrawerOpen(true)} style={glassBtn()}>☰</button>
              <div style={{ flex: 1, overflow: "hidden" }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: C.neonL,
                  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {currentBook?.name}
                </div>
                <div style={{ fontSize: 10, color: C.txM }}>Page {currentPage} of {numPages}</div>
              </div>
              <button onClick={() => setZoom(z => Math.max(0.5, +(z - 0.2).toFixed(1)))}
                style={glassBtn()}>−</button>
              <span style={{ fontSize: 10, color: C.txM, minWidth: 36, textAlign: "center" }}>
                {Math.round(zoom * 100)}%
              </span>
              <button onClick={() => setZoom(z => Math.min(4, +(z + 0.2).toFixed(1)))}
                style={glassBtn()}>+</button>
            </div>

            {/* ── Canvas — flex: 1 fills remaining height below top bar ── */}
            <div ref={containerRef}
              onTouchStart={onTS} onTouchMove={onTM} onTouchEnd={onTE}
              onClick={() => { touchControls(); if (activePanelRef.current) setActivePanel(null); }}
              style={{ flex: 1, overflowY: "auto", overflowX: "auto",
                display: "flex", flexDirection: "column", alignItems: "center",
                // paddingTop: 8 so PDF has a small gap from top of its area (not from top of screen)
                padding: "8px 4px 160px",
                WebkitOverflowScrolling: "touch",
                background: "linear-gradient(180deg,#0f0f1a,#141428)" }}>
              {rendering && (
                <div style={{ position: "fixed", top: "50%", left: "50%",
                  transform: "translate(-50%,-50%)", zIndex: 20,
                  background: C.glass, backdropFilter: "blur(12px)",
                  border: `1px solid ${C.borderG}`, borderRadius: 20,
                  padding: "8px 20px", fontSize: 12, color: C.neonL }}>
                  Rendering…
                </div>
              )}
              <div style={{ borderRadius: 4, overflow: "hidden",
                boxShadow: `0 0 40px rgba(37,99,235,0.12), 0 16px 60px rgba(0,0,0,0.7)` }}>
                <canvas ref={canvasRef} style={{ display: "block" }} />
              </div>
              {bNotes[currentPage] && (
                <div dir="auto" style={{ margin: "14px 8px 0", maxWidth: 600,
                  width: "calc(100% - 16px)", background: C.glass, backdropFilter: "blur(12px)",
                  border: `1px solid ${C.border}`, borderRadius: 14,
                  padding: "12px 16px", fontSize: 13, color: C.txM }}>
                  <span style={{ color: C.neonL, fontWeight: 700 }}>✏️ Note: </span>
                  {bNotes[currentPage]}
                </div>
              )}
            </div>

            {/* Page arrows + progress — fixed to screen so always visible */}
            <div style={{ position: "fixed", bottom: 150, left: 0, right: 0,
              display: "flex", justifyContent: "space-between", padding: "0 16px",
              opacity: showControls ? 1 : 0, transition: "opacity .3s",
              pointerEvents: showControls ? "auto" : "none", zIndex: 10 }}>
              <button onClick={() => goToPage(currentPage - 1)} disabled={currentPage === 1}
                style={{ ...glassBtn(), opacity: currentPage === 1 ? 0.3 : 1,
                  width: 44, height: 44, fontSize: 18 }}>◀</button>
              <div style={{ background: C.glass, backdropFilter: "blur(12px)",
                border: `1px solid ${C.border}`, borderRadius: 20,
                padding: "8px 16px", display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 12, color: C.tx, fontWeight: 700 }}>
                  {currentPage} / {numPages}
                </span>
                <div style={{ width: 80, height: 4, background: C.bg3, borderRadius: 4 }}>
                  <div style={{ height: "100%",
                    background: `linear-gradient(90deg,${C.neon},${C.purple})`,
                    borderRadius: 4, width: `${(currentPage / numPages) * 100}%`,
                    transition: "width .3s", boxShadow: `0 0 8px ${C.neon}` }} />
                </div>
              </div>
              <button onClick={() => goToPage(currentPage + 1)} disabled={currentPage === numPages}
                style={{ ...glassBtn(), opacity: currentPage === numPages ? 0.3 : 1,
                  width: 44, height: 44, fontSize: 18 }}>▶</button>
            </div>

            {/* Floating action bar — fixed so always above bottom nav */}
            <div style={{ position: "fixed", bottom: 66, left: "50%",
              transform: "translateX(-50%)",
              background: C.glass, backdropFilter: "blur(20px)",
              border: `1px solid ${C.borderG}`, borderRadius: 28, padding: "10px 22px",
              display: "flex", gap: 28, alignItems: "center",
              boxShadow: `0 0 40px rgba(37,99,235,0.2), 0 16px 40px rgba(0,0,0,0.5)`,
              opacity: showControls ? 1 : 0, transition: "opacity .3s",
              pointerEvents: showControls ? "auto" : "none", zIndex: 10 }}>
              {[
                { icon: "🎧", tip: "Voice",    key: "voice"  },
                { icon: "🔍", tip: "Search",   key: "search" },
                { icon: isBm ? "🔖" : "🏷️", tip: "Bookmark", key: "bookmark" },
                { icon: "✏️",  tip: "Notes",   key: "notes"  },
                { icon: "🔢", tip: "Go to",   key: "goto"   },
              ].map(item => (
                <button key={item.key} title={item.tip}
                  onClick={() => {
                    if (item.key === "bookmark") { toggleBm(); return; }
                    setActivePanel(activePanel === item.key ? null : item.key);
                  }}
                  style={{ background: "none", border: "none", cursor: "pointer",
                    fontSize: 22, display: "flex", flexDirection: "column",
                    alignItems: "center", gap: 2,
                    filter: (activePanel === item.key || (item.key === "bookmark" && isBm))
                      ? `drop-shadow(0 0 8px ${C.neon})` : "none",
                    transform: (activePanel === item.key || (item.key === "bookmark" && isBm))
                      ? "scale(1.15)" : "scale(1)",
                    transition: "filter .2s, transform .15s" }}>
                  {item.icon}
                  {(activePanel === item.key || (item.key === "bookmark" && isBm)) && (
                    <div style={{ width: 4, height: 4, borderRadius: "50%",
                      background: C.neon, boxShadow: `0 0 8px ${C.neon}` }} />
                  )}
                </button>
              ))}
            </div>

            {/* Panels — fixed so they always slide up from screen bottom */}
            {activePanel && (
              <div style={{ position: "fixed", bottom: 0, left: 0, right: 0,
                background: "linear-gradient(180deg,rgba(7,13,26,0.98),rgba(7,13,26,1))",
                backdropFilter: "blur(20px)",
                border: `1px solid ${C.border}`, borderTop: `1px solid ${C.borderG}`,
                borderRadius: "24px 24px 0 0", maxHeight: "70vh", overflowY: "auto",
                zIndex: 30, animation: "slideUp .3s cubic-bezier(.4,0,.2,1)",
                boxShadow: `0 -20px 60px rgba(37,99,235,0.12)` }}>
                <div style={{ display: "flex", justifyContent: "center", padding: "12px 0 8px" }}>
                  <div style={{ width: 36, height: 4, borderRadius: 4, cursor: "pointer",
                    background: `linear-gradient(90deg,${C.neon},${C.purple})`,
                    boxShadow: `0 0 8px ${C.neon}` }}
                    onClick={() => setActivePanel(null)} />
                </div>
                <div style={{ padding: "0 20px 100px" }}>

                  {/* SEARCH */}
                  {activePanel === "search" && (
                    <>
                      <PanelTitle title="🔍 Search PDF" />
                      <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
                        <div style={{ flex: 1, position: "relative" }}>
                          <span style={{ position: "absolute", left: 14, top: "50%",
                            transform: "translateY(-50%)", fontSize: 15, color: C.txM }}>🔍</span>
                          <input value={searchQ} onChange={e => setSearchQ(e.target.value)}
                            onKeyDown={e => e.key === "Enter" && runSearch()}
                            placeholder="Search entire document…" dir="auto"
                            style={{ width: "100%", padding: "14px 44px 14px 42px",
                              borderRadius: 16, border: `1px solid ${C.borderG}`,
                              background: "rgba(255,255,255,0.05)",
                              color: C.tx, fontSize: 14, fontFamily: "inherit",
                              outline: "none", boxSizing: "border-box" }} />
                          {searchQ && (
                            <button onClick={() => { setSearchQ(""); setSearchRes([]); }}
                              style={{ position: "absolute", right: 12, top: "50%",
                                transform: "translateY(-50%)", background: "none",
                                border: "none", cursor: "pointer", color: C.txM, fontSize: 18 }}>×</button>
                          )}
                        </div>
                        <button onClick={runSearch}
                          style={{ background: `linear-gradient(135deg,${C.glow},${C.purple})`,
                            border: "none", borderRadius: 14, padding: "14px 20px",
                            color: "#fff", fontWeight: 700, cursor: "pointer", fontSize: 14,
                            boxShadow: `0 4px 20px rgba(37,99,235,0.4)` }}>Go</button>
                      </div>
                      {searchRes.length > 0 && (
                        <div style={{ display: "flex", alignItems: "center",
                          justifyContent: "space-between", marginBottom: 14,
                          background: "rgba(59,130,246,0.08)", borderRadius: 12,
                          padding: "10px 14px", border: `1px solid ${C.border}` }}>
                          <div style={{ fontSize: 12, color: C.neonL, fontWeight: 700 }}>
                            {searchTotal} matches · {searchRes.length} pages
                          </div>
                          <div style={{ display: "flex", gap: 8 }}>
                            <button onClick={() => jumpResult(-1)} style={glassBtn({ width: 30, height: 30, fontSize: 12 })}>↑</button>
                            <span style={{ fontSize: 11, color: C.txM, alignSelf: "center" }}>
                              {currentResultIdx + 1}/{searchRes.length}
                            </span>
                            <button onClick={() => jumpResult(1)} style={glassBtn({ width: 30, height: 30, fontSize: 12 })}>↓</button>
                          </div>
                        </div>
                      )}
                      {searching && <div style={{ textAlign: "center", color: C.neonL, padding: 16, fontSize: 13 }}>🔍 Searching {numPages} pages…</div>}
                      {!searching && searchQ && !searchRes.length && (
                        <div style={{ textAlign: "center", color: C.txM, padding: 20, fontSize: 14 }}>
                          No results for "<span style={{ color: C.neonL }}>{searchQ}</span>"
                        </div>
                      )}
                      {searchRes.map((r, i) => (
                        <div key={i} onClick={() => { goToPage(r.page); setCurrentResultIdx(i); }}
                          style={{ ...glassCard(r.page === currentPage && i === currentResultIdx),
                            marginBottom: 10, cursor: "pointer" }}>
                          <div style={{ display: "flex", justifyContent: "space-between",
                            alignItems: "center", marginBottom: 8 }}>
                            <div style={{ fontSize: 13, fontWeight: 700, color: C.neonL }}>Page {r.page}</div>
                            <div style={{ fontSize: 10, color: C.txM,
                              background: "rgba(59,130,246,0.12)", borderRadius: 8, padding: "2px 8px" }}>
                              {r.count} match{r.count !== 1 ? "es" : ""}
                            </div>
                          </div>
                          {r.snippets.map((s, j) => (
                            <div key={j} dir="auto" style={{ fontSize: 12, color: C.txM, lineHeight: 1.6, marginBottom: j < r.snippets.length - 1 ? 6 : 0 }}>
                              …{s.before}
                              <span style={{ background: "rgba(59,130,246,0.3)", color: C.white,
                                borderRadius: 3, padding: "0 2px", fontWeight: 700 }}>{s.match}</span>
                              {s.after}…
                            </div>
                          ))}
                        </div>
                      ))}
                    </>
                  )}

                  {/* VOICE */}
                  {activePanel === "voice" && (
                    <>
                      <PanelTitle title="🎧 Voice Reader" />
                      <div style={{ fontSize: 12, color: C.txM, marginBottom: 20 }}>Listening to Page {currentPage}</div>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 3, margin: "16px 0", height: 64 }}>
                        {Array.from({ length: 24 }).map((_, i) => (
                          <div key={i} style={{ width: 4, borderRadius: 4,
                            background: voicePlaying ? `linear-gradient(180deg,${C.neon},${C.purple})` : "rgba(59,130,246,0.2)",
                            boxShadow: voicePlaying ? `0 0 8px ${C.neon}` : "none",
                            height: voicePlaying ? `${30 + Math.abs(Math.sin(i * 0.5)) * 70}%` : "20%",
                            animation: voicePlaying ? `wave .7s ease ${i * .04}s infinite alternate` : "none",
                            transition: "height .2s" }} />
                        ))}
                      </div>
                      <div style={{ height: 4, background: C.bg3, borderRadius: 4, marginBottom: 24 }}>
                        <div style={{ height: "100%", borderRadius: 4, background: `linear-gradient(90deg,${C.neon},${C.purple})`,
                          width: `${voiceProgress * 100}%`, transition: "width .3s", boxShadow: `0 0 10px ${C.neon}` }} />
                      </div>
                      <div style={{ display: "flex", justifyContent: "center", gap: 20, marginBottom: 24, alignItems: "center" }}>
                        <button onClick={() => goToPage(currentPage - 1)} disabled={currentPage === 1}
                          style={{ ...glassBtn({ width: 44, height: 44 }), opacity: currentPage === 1 ? 0.3 : 1 }}>⏮</button>
                        <button onClick={toggleVoice}
                          style={{ width: 72, height: 72, borderRadius: "50%",
                            background: `linear-gradient(135deg,${C.glow},${C.purple})`,
                            border: "none", cursor: "pointer", fontSize: 28, color: "#fff",
                            boxShadow: `0 0 40px rgba(37,99,235,0.5)`,
                            display: "flex", alignItems: "center", justifyContent: "center",
                            transition: "transform .15s" }}
                          onMouseEnter={e => e.currentTarget.style.transform = "scale(1.08)"}
                          onMouseLeave={e => e.currentTarget.style.transform = "scale(1)"}>
                          {voicePlaying ? "⏸" : "▶"}
                        </button>
                        <button onClick={() => { stopVoice(); goToPage(currentPage + 1); }} disabled={currentPage === numPages}
                          style={{ ...glassBtn({ width: 44, height: 44 }), opacity: currentPage === numPages ? 0.3 : 1 }}>⏭</button>
                      </div>
                      <div style={{ textAlign: "center" }}>
                        <div style={{ fontSize: 12, color: C.txM, marginBottom: 10 }}>
                          Speed: <span style={{ color: C.neonL, fontWeight: 700 }}>{voiceSpeed}x</span>
                        </div>
                        <input type="range" min="0.5" max="2" step="0.25" value={voiceSpeed}
                          onChange={e => { setVoiceSpeed(parseFloat(e.target.value)); if (voicePlaying) { stopVoice(); setTimeout(startVoice, 100); } }}
                          style={{ width: "80%", accentColor: C.neon }} />
                        <div style={{ display: "flex", justifyContent: "space-between", width: "80%", margin: "6px auto 0", fontSize: 10, color: C.txM }}>
                          <span>0.5x</span><span>1x</span><span>1.5x</span><span>2x</span>
                        </div>
                      </div>
                    </>
                  )}

                  {/* SAVED PAGES */}
                  {activePanel === "saved" && (
                    <>
                      <PanelTitle title="🔖 Saved Pages" />
                      <GlowBtn label={isBm ? "Remove from Saved" : `Save Page ${currentPage}`}
                        onClick={toggleBm} outline={isBm} />
                      <div style={{ height: 16 }} />
                      {bBms.length === 0 ? (
                        <div style={{ textAlign: "center", color: C.txM, padding: "20px 0", fontSize: 14 }}>No saved pages yet.</div>
                      ) : bBms.map(pg => (
                        <div key={pg} onClick={() => { goToPage(pg); setActivePanel(null); }}
                          style={{ ...glassCard(pg === currentPage), marginBottom: 10,
                            display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }}>
                          <div>
                            <div style={{ fontSize: 14, fontWeight: 700, color: pg === currentPage ? C.neonL : C.tx }}>Page {pg}</div>
                            {bNotes[pg] && <div style={{ fontSize: 11, color: C.txM, marginTop: 2 }}>✏️ Has note</div>}
                          </div>
                          <button onClick={e => { e.stopPropagation(); setBookmarks(p => ({ ...p, [bKey]: bBms.filter(x => x !== pg) })); }}
                            style={{ background: "none", border: "none", cursor: "pointer", color: C.txM, fontSize: 20 }}>×</button>
                        </div>
                      ))}
                    </>
                  )}

                  {/* GO TO PAGE */}
                  {activePanel === "goto" && (
                    <>
                      <PanelTitle title="🔢 Go to Page" />
                      <div style={{ display: "flex", gap: 10, marginBottom: 20 }}>
                        <input type="number" value={goInput} onChange={e => setGoInput(e.target.value)}
                          onKeyDown={e => { if (e.key === "Enter") { goToPage(parseInt(goInput)); setGoInput(""); setActivePanel(null); } }}
                          placeholder={`1 – ${numPages}`} min={1} max={numPages}
                          style={{ flex: 1, padding: "14px 16px", borderRadius: 16, border: `1px solid ${C.borderG}`,
                            background: "rgba(255,255,255,0.05)", color: C.tx, fontSize: 16, fontFamily: "inherit", outline: "none" }} />
                        <button onClick={() => { goToPage(parseInt(goInput)); setGoInput(""); setActivePanel(null); }}
                          style={{ background: `linear-gradient(135deg,${C.glow},${C.purple})`, border: "none",
                            borderRadius: 14, padding: "14px 22px", color: "#fff", fontWeight: 700, cursor: "pointer",
                            fontSize: 14, boxShadow: `0 4px 20px rgba(37,99,235,0.4)` }}>Go</button>
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        {[1, Math.floor(numPages * .25), Math.floor(numPages * .5), Math.floor(numPages * .75), numPages]
                          .filter((v, i, a) => v > 0 && a.indexOf(v) === i)
                          .map(pg => (
                            <button key={pg} onClick={() => { goToPage(pg); setActivePanel(null); }}
                              style={{ background: pg === currentPage ? `linear-gradient(135deg,${C.glow},${C.purple})` : "rgba(255,255,255,0.06)",
                                border: `1px solid ${pg === currentPage ? C.neon : C.border}`,
                                color: pg === currentPage ? "#fff" : C.tx,
                                padding: "10px 16px", borderRadius: 12, fontSize: 12,
                                cursor: "pointer", fontFamily: "inherit", fontWeight: 600,
                                boxShadow: pg === currentPage ? `0 4px 16px rgba(37,99,235,0.4)` : "none" }}>
                              {pg === 1 ? "First" : pg === numPages ? "Last" : `Page ${pg}`}
                            </button>
                          ))}
                      </div>
                    </>
                  )}

                  {/* NOTES */}
                  {activePanel === "notes" && (
                    <>
                      <PanelTitle title={`✏️ Note — Page ${currentPage}`} />
                      <textarea value={noteInput} onChange={e => setNoteInput(e.target.value)}
                        dir="auto" placeholder="Write your note here…"
                        style={{ width: "100%", minHeight: 110, padding: 14, borderRadius: 14,
                          border: `1px solid ${C.borderG}`, background: "rgba(255,255,255,0.05)",
                          color: C.tx, fontSize: 14, fontFamily: "inherit", resize: "vertical",
                          boxSizing: "border-box", outline: "none", lineHeight: 1.7, marginBottom: 12 }} />
                      <div style={{ display: "flex", gap: 10, marginBottom: 20 }}>
                        <GlowBtn label="Save Note" onClick={saveNote} />
                        {bNotes[currentPage] && (
                          <GlowBtn label="Delete" outline onClick={() => {
                            setNoteInput(""); const u = { ...bNotes }; delete u[currentPage];
                            setNotes(p => ({ ...p, [bKey]: u })); toast_("Note deleted");
                          }} />
                        )}
                      </div>
                      {Object.keys(bNotes).length > 0 && (
                        <>
                          <div style={{ fontSize: 11, color: C.txM, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 10 }}>All Notes</div>
                          {Object.entries(bNotes).sort(([a], [b]) => Number(a) - Number(b)).map(([pg, note]) => (
                            <div key={pg} onClick={() => { goToPage(Number(pg)); setActivePanel(null); }}
                              style={{ ...glassCard(Number(pg) === currentPage), marginBottom: 8, cursor: "pointer" }}>
                              <div style={{ fontSize: 12, color: C.neonL, fontWeight: 700, marginBottom: 4 }}>Page {pg}</div>
                              <div dir="auto" style={{ fontSize: 12, color: C.txM, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{note}</div>
                            </div>
                          ))}
                        </>
                      )}
                    </>
                  )}

                  {/* TABLE OF CONTENTS */}
                  {activePanel === "toc" && (
                    <>
                      <PanelTitle title="📑 Table of Contents" />
                      {toc.length === 0
                        ? <div style={{ textAlign: "center", color: C.txM, padding: "20px 0", fontSize: 14 }}>This PDF has no table of contents.</div>
                        : toc.map((item, i) => (
                          <div key={i} dir="auto" onClick={() => navToc(item)}
                            style={{ padding: "11px 14px", paddingLeft: 14 + item.depth * 18,
                              borderRadius: 12, cursor: "pointer", marginBottom: 4,
                              fontSize: item.depth === 0 ? 14 : 12,
                              fontWeight: item.depth === 0 ? 700 : 400,
                              color: item.depth === 0 ? C.neonL : C.tx,
                              borderLeft: item.depth > 0 ? `2px solid ${C.border}` : "none",
                              transition: "background .15s" }}
                            onMouseEnter={e => e.currentTarget.style.background = "rgba(59,130,246,0.08)"}
                            onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
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
      </div>

      {/* ── Bottom Nav — 2 tabs ── */}
      <div style={{ flexShrink: 0, background: C.glass, backdropFilter: "blur(20px)",
        borderTop: `1px solid ${C.border}`, display: "flex",
        position: "relative", zIndex: 10, boxShadow: `0 -4px 40px rgba(37,99,235,0.08)` }}>
        {[
          { key: "home",   icon: "⊞",  label: "Library" },
          { key: "reader", icon: "📖", label: "Reader"  },
        ].map(item => {
          const active = tab === item.key;
          const disabled = item.key === "reader" && screen !== "reader";
          return (
            <button key={item.key}
              onClick={() => { if (!disabled) setTab(item.key); }}
              style={{ flex: 1, background: "transparent", border: "none",
                cursor: disabled ? "default" : "pointer",
                padding: "13px 4px 15px", fontFamily: "inherit",
                position: "relative", opacity: disabled ? 0.35 : 1, transition: "opacity .2s" }}>
              {active && (
                <div style={{ position: "absolute", top: 0, left: "25%", right: "25%", height: 2,
                  background: `linear-gradient(90deg,${C.neon},${C.purple})`,
                  borderRadius: "0 0 4px 4px", boxShadow: `0 0 10px ${C.neon}` }} />
              )}
              <div style={{ fontSize: 22, marginBottom: 3,
                filter: active ? `drop-shadow(0 0 8px ${C.neon})` : "none", transition: "filter .2s" }}>
                {item.icon}
              </div>
              <div style={{ fontSize: 11, fontWeight: active ? 700 : 500,
                color: active ? C.neonL : C.txM, transition: "color .2s" }}>
                {item.label}
              </div>
            </button>
          );
        })}
      </div>

      {/* Toast */}
      {toast && (
        <div style={{ position: "fixed", bottom: 90, left: "50%", transform: "translateX(-50%)",
          background: toast.type === "success"
            ? `linear-gradient(135deg,${C.glow},${C.purple})` : C.glass,
          backdropFilter: "blur(12px)", color: "#fff", padding: "10px 22px",
          borderRadius: 24, fontSize: 13, boxShadow: `0 4px 28px rgba(37,99,235,0.35)`,
          border: `1px solid ${C.borderG}`, zIndex: 500,
          whiteSpace: "nowrap", animation: "fadeUp .2s ease", fontWeight: 600 }}>
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
        input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:18px;height:18px;border-radius:50%;background:linear-gradient(135deg,#2563eb,#7c3aed);cursor:pointer;box-shadow:0 0 10px rgba(37,99,235,0.5)}
      `}</style>
    </div>
  );
}

// ── Reusable components ───────────────────────────────────────────────────────
function GlowBtn({ label, onClick, full, outline }) {
  return (
    <button onClick={onClick}
      style={{ background: outline ? "transparent" : `linear-gradient(135deg,${C.glow},${C.purple})`,
        border: `1px solid ${outline ? C.borderG : "transparent"}`,
        color: "#fff", padding: "13px 24px", borderRadius: 14,
        fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
        width: full ? "100%" : "auto",
        boxShadow: outline ? "none" : `0 4px 24px rgba(37,99,235,0.4)`,
        transition: "transform .15s" }}
      onMouseEnter={e => e.currentTarget.style.transform = "scale(1.02)"}
      onMouseLeave={e => e.currentTarget.style.transform = "scale(1)"}>
      {label}
    </button>
  );
}
function SectionLabel({ label }) {
  return (
    <div style={{ fontSize: 12, fontWeight: 800, color: C.txM,
      textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 14 }}>
      {label}
    </div>
  );
}
function PanelTitle({ title }) {
  return <div style={{ fontSize: 17, fontWeight: 800, color: C.tx, marginBottom: 18 }}>{title}</div>;
}
function RecentCard({ book, lastPage, hue, onOpen, onRemove }) {
  return (
    <div style={{ flexShrink: 0, width: 110, position: "relative", cursor: "pointer" }} onClick={onOpen}>
      <div style={{ height: 152, borderRadius: 16,
        background: `linear-gradient(160deg,hsl(${hue},60%,30%),hsl(${hue+30},50%,18%))`,
        border: `1px solid hsl(${hue},40%,38%)`,
        boxShadow: `0 0 20px hsla(${hue},60%,40%,.25), 0 8px 32px rgba(0,0,0,.5)`,
        display: "flex", flexDirection: "column", alignItems: "center",
        justifyContent: "center", padding: "12px 8px", gap: 8, marginBottom: 8,
        transition: "transform .2s, box-shadow .2s" }}
        onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-4px)"; e.currentTarget.style.boxShadow = `0 0 30px hsla(${hue},60%,40%,.4), 0 16px 40px rgba(0,0,0,.6)`; }}
        onMouseLeave={e => { e.currentTarget.style.transform = ""; e.currentTarget.style.boxShadow = `0 0 20px hsla(${hue},60%,40%,.25), 0 8px 32px rgba(0,0,0,.5)`; }}>
        <div style={{ fontSize: 26 }}>📄</div>
        <div dir="auto" style={{ fontSize: 9, color: `hsl(${hue},20%,85%)`, textAlign: "center",
          fontWeight: 700, lineHeight: 1.4, display: "-webkit-box",
          WebkitLineClamp: 4, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
          {book.name}
        </div>
        {lastPage && (
          <div style={{ fontSize: 9, color: `hsl(${hue},40%,70%)`,
            background: "rgba(0,0,0,0.3)", borderRadius: 8, padding: "2px 6px" }}>
            Pg {lastPage}
          </div>
        )}
      </div>
      <div dir="auto" style={{ fontSize: 10, fontWeight: 600, color: C.txM, lineHeight: 1.3,
        display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
        {book.name}
      </div>
      <button onClick={e => { e.stopPropagation(); onRemove(); }}
        style={{ position: "absolute", top: 6, right: 6, background: "rgba(0,0,0,0.6)",
          border: "none", borderRadius: "50%", width: 20, height: 20, cursor: "pointer",
          color: C.txM, fontSize: 11, display: "flex", alignItems: "center", justifyContent: "center" }}>×</button>
    </div>
  );
}
function LibCard({ book, hue, lastPage, bmsCount, onOpen, onDelete }) {
  return (
    <div style={{ position: "relative", animation: "fadeIn .3s ease both" }}>
      <div onClick={onOpen} style={{ cursor: "pointer" }}>
        <div style={{ aspectRatio: "2/3", borderRadius: 14,
          background: `linear-gradient(160deg,hsl(${hue},55%,28%),hsl(${hue+30},45%,16%))`,
          border: `1px solid hsl(${hue},35%,32%)`,
          boxShadow: `0 0 16px hsla(${hue},50%,35%,.2), 0 6px 24px rgba(0,0,0,.5)`,
          display: "flex", flexDirection: "column", alignItems: "center",
          justifyContent: "center", padding: "10px 6px", gap: 6, marginBottom: 6,
          transition: "transform .2s, box-shadow .2s" }}
          onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-3px)"; e.currentTarget.style.boxShadow = `0 0 24px hsla(${hue},50%,35%,.35), 0 12px 32px rgba(0,0,0,.6)`; }}
          onMouseLeave={e => { e.currentTarget.style.transform = ""; e.currentTarget.style.boxShadow = `0 0 16px hsla(${hue},50%,35%,.2), 0 6px 24px rgba(0,0,0,.5)`; }}>
          <div style={{ fontSize: 22 }}>📄</div>
          <div dir="auto" style={{ fontSize: 8, color: `hsl(${hue},15%,88%)`,
            textAlign: "center", fontWeight: 700, lineHeight: 1.3, display: "-webkit-box",
            WebkitLineClamp: 4, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
            {book.name}
          </div>
          {bmsCount > 0 && (
            <div style={{ position: "absolute", top: 5, right: 5, background: "rgba(0,0,0,0.7)",
              borderRadius: 8, padding: "1px 5px", fontSize: 8, color: C.neonL,
              border: `1px solid ${C.border}` }}>🔖{bmsCount}</div>
          )}
        </div>
        <div dir="auto" style={{ fontSize: 9, fontWeight: 700, color: C.txM, lineHeight: 1.3,
          display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
          {book.name}
        </div>
        {lastPage && <div style={{ fontSize: 8, color: C.neon, marginTop: 1 }}>Pg {lastPage}</div>}
      </div>
      <button onClick={onDelete}
        style={{ position: "absolute", top: 4, left: 4, background: "rgba(0,0,0,0.7)",
          border: "none", borderRadius: "50%", width: 18, height: 18, cursor: "pointer",
          color: C.txM, fontSize: 10, display: "flex", alignItems: "center", justifyContent: "center" }}>×</button>
    </div>
  );
}
