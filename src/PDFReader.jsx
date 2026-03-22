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
    const r = indexedDB.open("PDFReaderDB", 2);
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

// ── Design tokens ─────────────────────────────────────────────────────────────
const C = {
  bg0:    "#03050f",
  bg1:    "#070d1a",
  bg2:    "#0c1428",
  bg3:    "#101e38",
  glass:  "rgba(12,20,40,0.80)",
  glow:   "#2563eb",
  purple: "#7c3aed",
  neon:   "#3b82f6",
  neonL:  "#60a5fa",
  purpleL:"#a78bfa",
  border: "rgba(59,130,246,0.18)",
  borderG:"rgba(59,130,246,0.50)",
  tx:     "#e2e8f0",
  txM:    "#64748b",
  txD:    "#1e293b",
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
  // Screen state — no tabs, just "home" or "reader"
  const [screen, setScreen] = useState("home");
  const [pdfjsReady, setPdfjsReady] = useState(false);
  const [dark, setDark] = useState(true);

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
  const [plusPressed, setPlusPressed] = useState(false); // weighted press effect

  // Drawer
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerView, setDrawerView] = useState("menu"); // "menu" | "allsaved"

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
  const controlsTimer = useRef(null);
  const utterRef = useRef(null);
  const restoredRef = useRef(false);

  // Refs for back button — always fresh values
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
        const [bm, nt, lr, rb, perm, dk] = await Promise.all([
          dbGetAllBookmarks(), dbGetAllNotes(),
          dbGet("lastRead"), dbGet("recentBooks"),
          dbGet("permState"), dbGet("dark"),
        ]);
        if (bm && Object.keys(bm).length) setBookmarks(bm);
        if (nt && Object.keys(nt).length) setNotes(nt);
        if (lr) setLastRead(lr);
        if (rb) setRecentBooks(rb);
        if (dk !== null) setDark(dk);
        if (perm==="granted"||perm==="skipped") setPermState(perm);
        else setTimeout(() => setShowPerm(true), 900);
      } catch {
        setTimeout(() => setShowPerm(true), 900);
      } finally {
        restoredRef.current = true;
      }
    })();
  }, []);

  // ── BACK BUTTON — Capacitor + browser ───────────────────────────────────────
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

  // ── AUTO-SAVE (after restore only) ──────────────────────────────────────────
  useEffect(() => {
    if (!restoredRef.current) return;
    Object.entries(bookmarks).forEach(([n, p]) => dbSaveBookmarks(n, p).catch(()=>{}));
  }, [bookmarks]);
  useEffect(() => {
    if (!restoredRef.current) return;
    Object.entries(notes).forEach(([n, p]) => dbSaveNotes(n, p).catch(()=>{}));
  }, [notes]);
  useEffect(() => { if (restoredRef.current) dbSet("lastRead", lastRead).catch(()=>{}); }, [lastRead]);
  useEffect(() => { if (restoredRef.current) dbSet("recentBooks", recentBooks).catch(()=>{}); }, [recentBooks]);
  useEffect(() => { if (restoredRef.current) dbSet("dark", dark).catch(()=>{}); }, [dark]);
  useEffect(() => {
    if (currentBook) setNoteInput(notes[currentBook.name]?.[currentPage] || "");
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

  // ── STORAGE PERMISSION ───────────────────────────────────────────────────────
  const grantPermission = async () => {
    setShowPerm(false); setPermState("granted");
    await dbSet("permState","granted").catch(()=>{});
    if ("showDirectoryPicker" in window) {
      try {
        const dir = await window.showDirectoryPicker({ mode:"read" });
        await runFolderScan(dir); return;
      } catch (e) { if (e?.name==="AbortError") return; }
    }
    folderInputRef.current?.click();
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
      try { await dbSavePDF(book.name, await book.file.arrayBuffer(), book.size, book.modified); } catch {}
      setLibrary(prev => prev.find(b=>b.name===book.name) ? prev : [...prev, book]);
    });
    setScanning(false); setScanStatus("");
    if (!count) toast_("No new PDFs found. Select your Internal Storage root.");
    else toast_(`Found ${count} PDF${count>1?"s":""}! Saved to library.`, "success");
  };
  const handleFolderInput = async (e) => {
    const files = Array.from(e.target.files||[]).filter(f=>f.name.toLowerCase().endsWith(".pdf"));
    if (!files.length) { toast_("No PDFs found."); return; }
    setScanning(true); setScanCount(0);
    const seen = new Set(library.map(b=>b.name));
    let count=0;
    for (const f of files) {
      const name = f.name.replace(/\.pdf$/i,"");
      if (seen.has(name)) continue;
      seen.add(name); count++;
      setScanCount(count); setScanStatus(`Found: ${name}`);
      const book = { name, file:f, size:f.size, modified:f.lastModified };
      try { await dbSavePDF(name, await f.arrayBuffer(), f.size, f.lastModified); } catch {}
      setLibrary(prev => prev.find(b=>b.name===name) ? prev : [...prev, book]);
    }
    setScanning(false); setScanStatus(""); e.target.value="";
    if (!count) toast_("No new PDFs found.");
    else toast_(`${count} PDF${count>1?"s":""} added!`, "success");
  };
  const handleFiles = async (files) => {
    if (!files?.length) return;
    const books = Array.from(files).filter(f=>f.name.toLowerCase().endsWith(".pdf"))
      .map(f=>({ name:f.name.replace(/\.pdf$/i,""), file:f, size:f.size, modified:f.lastModified }));
    if (!books.length) return;
    for (const b of books) {
      try { await dbSavePDF(b.name, await b.file.arrayBuffer(), b.size, b.modified); } catch {}
    }
    setLibrary(prev => { const s=new Set(prev.map(x=>x.name)); return [...prev,...books.filter(x=>!s.has(x.name))]; });
    toast_(`${books.length} PDF${books.length>1?"s":""} added!`, "success");
    if (fileInputRef.current) fileInputRef.current.value="";
  };

  // ── OPEN BOOK ────────────────────────────────────────────────────────────────
  const openBook = async (book) => {
    if (!pdfjsReady) { toast_("PDF engine loading…"); return; }
    stopVoice();
    setCurrentBook(book); setToc([]);
    setSearchRes([]); setSearchQ(""); setTextCache({});
    setActivePanel(null); setDrawerOpen(false);
    setRecentBooks(prev=>[book.name,...prev.filter(n=>n!==book.name)].slice(0,6));
    const resumePage = lastRead[book.name] || 1;
    try {
      const buf = await book.file.arrayBuffer();
      const doc = await window.pdfjsLib.getDocument({
        data: buf,
        cMapUrl:`https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PV}/cmaps/`,
        cMapPacked:true,
        standardFontDataUrl:`https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PV}/standard_fonts/`,
      }).promise;
      setCurrentPage(resumePage); setNumPages(doc.numPages); setPdfDoc(doc);
      try { setToc(flattenOutline(await doc.getOutline())); } catch { setToc([]); }
      setScreen("reader"); setShowControls(true);
    } catch { toast_("Could not open this PDF.", "error"); }
  };
  const flattenOutline = (items, d=0) => {
    if (!items) return [];
    return items.flatMap(i=>[{title:i.title,dest:i.dest,depth:d},...flattenOutline(i.items,d+1)]);
  };

  // ── RENDER PAGE (sharp + properly fitted) ────────────────────────────────────
  const renderPage = useCallback(async (doc, pageNum, scaleOvr) => {
    if (!canvasRef.current || !doc) return;
    if (renderTaskRef.current) { try { renderTaskRef.current.cancel(); } catch {} }
    setRendering(true);
    try {
      const page = await doc.getPage(pageNum);
      const ctr = containerRef.current;
      // Fit to container width — leaves zero margin so full page shows
      const availW = ctr ? ctr.clientWidth - 0 : window.innerWidth;
      const fit = availW / page.getViewport({scale:1}).width;
      const scale = scaleOvr !== undefined ? scaleOvr : fit;
      const dpr = window.devicePixelRatio || 1;
      const vp = page.getViewport({ scale });
      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d");
      canvas.width  = Math.floor(vp.width  * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      canvas.style.width  = `${Math.floor(vp.width)}px`;
      canvas.style.height = `${Math.floor(vp.height)}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, vp.width, vp.height);
      const task = page.render({ canvasContext:ctx, viewport:vp, intent:"display" });
      renderTaskRef.current = task;
      await task.promise;
      if (scaleOvr === undefined) setZoom(fit);
    } catch (e) { if (e?.name!=="RenderingCancelledException") console.error(e); }
    finally { setRendering(false); }
  }, []);

  useEffect(() => { if (pdfDoc) renderPage(pdfDoc, currentPage, undefined); }, [pdfDoc, currentPage]);
  const zt = useRef(null);
  useEffect(() => {
    if (!pdfDoc) return;
    clearTimeout(zt.current);
    zt.current = setTimeout(() => renderPage(pdfDoc, currentPage, zoom), 150);
  }, [zoom]);

  // ── PINCH ZOOM ───────────────────────────────────────────────────────────────
  const onTS = e => {
    if (e.touches.length!==2) return;
    const dx=e.touches[0].clientX-e.touches[1].clientX, dy=e.touches[0].clientY-e.touches[1].clientY;
    pinchRef.current={active:true,startDist:Math.hypot(dx,dy),startZoom:zoom};
  };
  const onTM = e => {
    if (!pinchRef.current.active||e.touches.length!==2) return;
    e.preventDefault();
    const dx=e.touches[0].clientX-e.touches[1].clientX, dy=e.touches[0].clientY-e.touches[1].clientY;
    setZoom(parseFloat(Math.max(0.5,Math.min(4,pinchRef.current.startZoom*(Math.hypot(dx,dy)/pinchRef.current.startDist))).toFixed(2)));
  };
  const onTE = () => { pinchRef.current.active=false; };

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
  // All bookmarks across all books
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

  // ── VOICE ────────────────────────────────────────────────────────────────────
  const startVoice = async () => {
    if (!pdfDoc) return;
    try {
      const text=await getPageText(pdfDoc,currentPage);
      if (!text.trim()) { toast_("No readable text on this page."); return; }
      stopVoice();
      const u=new SpeechSynthesisUtterance(text);
      u.rate=voiceSpeed;
      u.onstart=()=>setVoicePlaying(true);
      u.onend=()=>{setVoicePlaying(false);setVoiceProgress(0);};
      u.onboundary=e=>{if(e.name==="word")setVoiceProgress(e.charIndex/text.length);};
      utterRef.current=u;
      window.speechSynthesis.speak(u);
    } catch { toast_("Text-to-speech not available."); }
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
  const acc     = C.neon;
  const accG    = C.borderG;

  // ════════════════════════════════════════════════════════════════════════════
  // RENDER
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

      {/* Hidden file inputs */}
      <input ref={fileInputRef} type="file" accept=".pdf,application/pdf"
        multiple style={{ display:"none" }} onChange={e=>handleFiles(e.target.files)} />
      <input ref={folderInputRef} type="file" accept=".pdf"
        multiple webkitdirectory="" mozdirectory=""
        style={{ display:"none" }} onChange={handleFolderInput} />

      {/* ── SCANNING OVERLAY ── */}
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

      {/* ── PERMISSION POPUP ── */}
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
              {n:"1",t:"Tap the button below"},
              {n:"2",t:'Select "Internal Storage" folder'},
              {n:"3",t:"App scans and adds all PDFs"},
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
              onClick={()=>{ setShowPerm(false); skipPerm(); fileInputRef.current?.click(); }} />
            <button onClick={skipPerm} style={{ background:"none", border:"none", width:"100%",
              color:C.txM, fontSize:12, cursor:"pointer", padding:"12px", fontFamily:"inherit" }}>
              Don't ask again
            </button>
          </div>
        </div>
      )}

      {/* ── DRAWER ── */}
      {drawerOpen && (
        <div style={{ position:"fixed", inset:0, zIndex:80,
          background:"rgba(0,0,0,0.6)", backdropFilter:"blur(4px)" }}
          onClick={()=>{ setDrawerOpen(false); setDrawerView("menu"); }} />
      )}
      <div style={{ position:"fixed", top:0, left:0, bottom:0, width:300, zIndex:90,
        background:d?"linear-gradient(180deg,#070d1a,#0c1428)":"#ffffff",
        borderRight:`1px solid ${border_}`,
        transform:drawerOpen?"translateX(0)":"translateX(-100%)",
        transition:"transform .28s cubic-bezier(.4,0,.2,1)",
        backdropFilter:"blur(20px)", display:"flex", flexDirection:"column",
        boxShadow:drawerOpen?`6px 0 60px rgba(37,99,235,0.15)`:"none" }}>

        {/* Drawer header */}
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

        {/* Drawer content */}
        <div style={{ flex:1, overflowY:"auto", padding:"12px 8px" }}>

          {drawerView==="menu" ? (
            <>
              {/* Library section */}
              <DrawerSection label="Library" />
              <DrawerRow icon="🏠" label="My Library" sub={`${library.length} books`}
                tx={tx} txM={txM} accL={C.borderG}
                onClick={()=>{ setScreen("home"); setPdfDoc(null); stopVoice(); setDrawerOpen(false); }} />
              <DrawerRow icon="➕" label="Add PDF" sub="Pick from device"
                tx={tx} txM={txM} accL={C.borderG}
                onClick={()=>{ setDrawerOpen(false); fileInputRef.current?.click(); }} />
              <DrawerRow icon="📂" label="Scan Storage" sub="Find all PDFs automatically"
                tx={tx} txM={txM} accL={C.borderG}
                onClick={async()=>{ setDrawerOpen(false); await grantPermission(); }} />

              {/* Saved pages across ALL books */}
              <div style={{ height:1, background:border_, margin:"10px 12px" }} />
              <DrawerSection label="Bookmarks" />
              <DrawerRow icon="🔖" label="All Saved Pages"
                sub={`${allBms.length} saved across ${Object.keys(bookmarks).filter(k=>(bookmarks[k]||[]).length>0).length} books`}
                tx={tx} txM={txM} accL={C.borderG}
                onClick={()=>setDrawerView("allsaved")} />

              {/* Current book options */}
              {screen==="reader" && (
                <>
                  <div style={{ height:1, background:border_, margin:"10px 12px" }} />
                  <DrawerSection label="Current Book" />
                  <DrawerRow icon="🔍" label="Search PDF" sub="Full text search with highlights"
                    tx={tx} txM={txM} accL={C.borderG}
                    onClick={()=>{ setActivePanel("search"); setDrawerOpen(false); }} />
                  <DrawerRow icon="✏️" label="Notes" sub={`${Object.keys(bNotes).length} notes`}
                    tx={tx} txM={txM} accL={C.borderG}
                    onClick={()=>{ setActivePanel("notes"); setDrawerOpen(false); }} />
                  <DrawerRow icon="📑" label="Contents" sub={toc.length>0?`${toc.length} sections`:"Not available"}
                    tx={tx} txM={txM} accL={C.borderG}
                    onClick={()=>{ setActivePanel("toc"); setDrawerOpen(false); }} />
                </>
              )}

              {/* Settings */}
              <div style={{ height:1, background:border_, margin:"10px 12px" }} />
              <DrawerSection label="Settings" />
              <DrawerRow icon={d?"☀️":"🌙"} label={d?"Light Mode":"Dark Mode"}
                sub="Switch appearance" tx={tx} txM={txM} accL={C.borderG}
                onClick={()=>setDark(!d)} />
            </>
          ) : (
            /* ALL SAVED PAGES VIEW */
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
                  if (book) { await openBook(book); setTimeout(()=>goToPage(item.page),600); }
                  setDrawerOpen(false); setDrawerView("menu");
                }} style={{ padding:"12px 14px", borderRadius:12, marginBottom:6,
                  cursor:"pointer", transition:"background .15s",
                  border:`1px solid ${border_}`, background:inputBg }}
                  onMouseEnter={e=>e.currentTarget.style.borderColor=C.borderG}
                  onMouseLeave={e=>e.currentTarget.style.borderColor=border_}>
                  <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                    <div style={{ width:36, height:36, borderRadius:10,
                      background:`linear-gradient(135deg,hsl(${coverHue(item.bookName)},50%,30%),hsl(${coverHue(item.bookName)+30},40%,18%))`,
                      display:"flex", alignItems:"center", justifyContent:"center",
                      fontSize:16, flexShrink:0 }}>📄</div>
                    <div style={{ flex:1, overflow:"hidden" }}>
                      <div style={{ fontSize:13, fontWeight:700, color:C.neonL,
                        overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                        Page {item.page}
                      </div>
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

        {/* Reading progress */}
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

      {/* ════════════════════════════════════════════════════════════════════════
          HOME SCREEN — matches sketch exactly
      ════════════════════════════════════════════════════════════════════════ */}
      {screen==="home" && (
        <div style={{ flex:1, display:"flex", flexDirection:"column",
          overflow:"hidden", position:"relative", zIndex:1 }}>

          {/* ── TOP BAR ── */}
          <div style={{ flexShrink:0, padding:"16px 18px 0",
            display:"flex", alignItems:"center", justifyContent:"space-between" }}>
            <button onClick={()=>{ setDrawerOpen(true); setDrawerView("menu"); }}
              style={{ background:inputBg, border:`1px solid ${border_}`,
                borderRadius:12, width:40, height:40, cursor:"pointer", color:tx,
                fontSize:18, display:"flex", alignItems:"center", justifyContent:"center",
                flexShrink:0 }}>☰</button>

            {/* Greeting */}
            <div style={{ flex:1, paddingLeft:12 }}>
              <div style={{ fontSize:13, color:txM }}>{getGreeting()}</div>
            </div>

            {/* Theme toggle */}
            <button onClick={()=>setDark(!d)}
              style={{ background:"none", border:"none", fontSize:20,
                cursor:"pointer", color:acc }}>
              {d?"☀️":"🌙"}
            </button>
          </div>

          {/* ── LIBRARY TITLE ── */}
          <div style={{ padding:"12px 18px 0" }}>
            <div style={{ fontSize:26, fontWeight:800,
              background:`linear-gradient(135deg,${d?"#fff":C.bg0},${C.neonL})`,
              WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" }}>
              Your Library
            </div>
            <div style={{ fontSize:13, color:txM, marginTop:2 }}>
              {library.length} book{library.length!==1?"s":""} · Ready to read
            </div>
          </div>

          {/* ── SEARCH BAR ── */}
          <div style={{ padding:"14px 18px 0" }}>
            <div style={{ position:"relative" }}>
              <span style={{ position:"absolute", left:14, top:"50%",
                transform:"translateY(-50%)", fontSize:15, color:txM }}>🔍</span>
              <input value={libSearch} onChange={e=>setLibSearch(e.target.value)}
                placeholder="Search books…"
                style={{ width:"100%", padding:"11px 14px 11px 40px",
                  borderRadius:14, border:`1.5px solid ${border_}`,
                  background:inputBg, backdropFilter:"blur(10px)",
                  color:tx, fontSize:14, fontFamily:"inherit",
                  outline:"none", boxSizing:"border-box",
                  transition:"border-color .2s" }}
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

          {/* ── SCROLLABLE CONTENT ── */}
          <div style={{ flex:1, overflowY:"auto", padding:"0 18px 120px" }}>

            {library.length===0 ? (
              /* Empty state */
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
                  <div style={{ marginTop:20 }}>
                    <SectionLabel label="Recently Opened" color={txM} />
                    <div style={{ display:"flex", gap:12, overflowX:"auto",
                      paddingBottom:4, scrollbarWidth:"none" }}>
                      {recentList.slice(0,3).map((book,i)=>(
                        <SmallBookCard key={i} book={book}
                          hue={coverHue(book.name)}
                          lastPage={lastRead[book.name]}
                          bms={(bookmarks[book.name]||[]).length}
                          onOpen={()=>openBook(book)}
                          onRemove={()=>setRecentBooks(prev=>prev.filter(n=>n!==book.name))}
                          d={d} />
                      ))}
                    </div>
                  </div>
                )}

                {/* ALL BOOKS */}
                <div style={{ marginTop:recentList.length&&!libSearch?20:20 }}>
                  <SectionLabel
                    label={libSearch?`Results (${filtLib.length})`:`All Books (${library.length})`}
                    color={txM} />
                  {filtLib.length===0 ? (
                    <div style={{ textAlign:"center", padding:"28px 0", color:txM, fontSize:14 }}>
                      No books match "<span style={{color:C.neonL}}>{libSearch}</span>"
                    </div>
                  ) : (
                    <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:12 }}>
                      {filtLib.map((book,i)=>(
                        <BigBookCard key={i} book={book}
                          hue={coverHue(book.name)}
                          lastPage={lastRead[book.name]}
                          bms={(bookmarks[book.name]||[]).length}
                          onOpen={()=>openBook(book)}
                          onDelete={()=>{
                            if (window.confirm(`Remove "${book.name}"?`)) {
                              dbDeletePDF(book.name).catch(()=>{});
                              setLibrary(prev=>prev.filter(b=>b.name!==book.name));
                              setRecentBooks(prev=>prev.filter(n=>n!==book.name));
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

          {/* ── FLOATING + BUTTON with weighted/bending effect ── */}
          <div style={{ position:"fixed", bottom:0, left:0, right:0,
            display:"flex", justifyContent:"center", alignItems:"flex-end",
            pointerEvents:"none", zIndex:20 }}>

            {/* Weighted platform — bends visually toward the button */}
            <div style={{ position:"relative", pointerEvents:"auto" }}>
              {/* Shadow/weight indicator below button */}
              <div style={{ position:"absolute", bottom:-4, left:"50%",
                transform:"translateX(-50%)",
                width:plusPressed?50:70, height:plusPressed?6:10,
                background:`radial-gradient(ellipse,rgba(37,99,235,${plusPressed?0.2:0.4}) 0%,transparent 70%)`,
                borderRadius:"50%", transition:"all .15s" }} />

              {/* The + button */}
              <button
                onMouseDown={()=>setPlusPressed(true)}
                onMouseUp={()=>setPlusPressed(false)}
                onTouchStart={()=>setPlusPressed(true)}
                onTouchEnd={()=>{ setPlusPressed(false); fileInputRef.current?.click(); }}
                onClick={()=>fileInputRef.current?.click()}
                style={{ marginBottom:24,
                  width:plusPressed?58:64, height:plusPressed?58:64,
                  borderRadius:"50%",
                  background:plusPressed
                    ?`linear-gradient(135deg,${C.glowS||"#1d4ed8"},${C.purple})`
                    :`linear-gradient(135deg,${C.glow},${C.purple})`,
                  border:"none", cursor:"pointer",
                  fontSize:plusPressed?28:32, color:"#fff",
                  display:"flex", alignItems:"center", justifyContent:"center",
                  boxShadow:plusPressed
                    ?`0 2px 12px rgba(37,99,235,0.6), 0 0 0 8px rgba(37,99,235,0.08)`
                    :`0 8px 32px rgba(37,99,235,0.6), 0 0 0 12px rgba(37,99,235,0.10)`,
                  transform:plusPressed?"translateY(4px) scale(0.92)":"translateY(0) scale(1)",
                  transition:"all .15s cubic-bezier(.34,1.56,.64,1)",
                  lineHeight:1 }}>
                +
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════════
          READER SCREEN — matches sketch exactly
      ════════════════════════════════════════════════════════════════════════ */}
      {screen==="reader" && (
        <div style={{ flex:1, display:"flex", flexDirection:"column",
          overflow:"hidden", position:"relative", zIndex:1 }}>

          {/* ── TOP BAR (in flow — never overlaps PDF) ── */}
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
            <button onClick={()=>setZoom(z=>Math.max(0.5,+(z-0.2).toFixed(1)))}
              style={glassBtn()}>−</button>
            <span style={{ fontSize:10, color:txM, minWidth:36, textAlign:"center" }}>
              {Math.round(zoom*100)}%
            </span>
            <button onClick={()=>setZoom(z=>Math.min(4,+(z+0.2).toFixed(1)))}
              style={glassBtn()}>+</button>
          </div>

          {/* ── PDF CANVAS — fills all remaining space ── */}
          <div ref={containerRef}
            onTouchStart={onTS} onTouchMove={onTM} onTouchEnd={onTE}
            onClick={()=>{ touchControls(); if(activePanelRef.current) setActivePanel(null); }}
            style={{ flex:1, overflowY:"auto", overflowX:"hidden",
              display:"flex", flexDirection:"column", alignItems:"center",
              background:d?"linear-gradient(180deg,#0f0f1a,#141428)":"#e8edf5",
              WebkitOverflowScrolling:"touch",
              // Small vertical padding so shadow shows nicely
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

            {/* Canvas — width:100% ensures full-width rendering */}
            <div style={{ width:"100%",
              boxShadow:d
                ?"0 0 40px rgba(37,99,235,0.12), 0 8px 40px rgba(0,0,0,0.7)"
                :"0 4px 24px rgba(0,0,0,0.15)" }}>
              <canvas ref={canvasRef} style={{ display:"block", width:"100%" }} />
            </div>

            {/* Note display below PDF */}
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

          {/* ── BOTTOM CONTROLS — matches sketch ── */}
          <div style={{ flexShrink:0,
            background:d?"rgba(7,13,26,0.97)":"rgba(255,255,255,0.97)",
            borderTop:`1px solid ${border_}`,
            opacity:showControls?1:0, transition:"opacity .3s",
            pointerEvents:showControls?"auto":"none" }}>

            {/* Row 1: Prev / Page indicator / Next */}
            <div style={{ display:"flex", alignItems:"center",
              justifyContent:"space-between", padding:"10px 16px 6px", gap:8 }}>
              <button onClick={()=>goToPage(1)} disabled={currentPage===1}
                style={{ ...glassBtn({width:36,height:36,fontSize:13}),
                  opacity:currentPage===1?.3:1 }}>⏮</button>
              <button onClick={()=>goToPage(currentPage-1)} disabled={currentPage===1}
                style={{ ...glassBtn({padding:"0 14px",width:"auto",height:36,fontSize:12,borderRadius:20}),
                  opacity:currentPage===1?.3:1 }}>◀ Prev</button>

              {/* Page pill with progress */}
              <div style={{ flex:1, textAlign:"center" }}>
                <div style={{ fontSize:14, fontWeight:800, color:C.neonL }}>
                  {currentPage} / {numPages}
                </div>
                <div style={{ height:3, background:d?C.bg3:"#e2e8f0",
                  borderRadius:3, marginTop:4 }}>
                  <div style={{ height:"100%", borderRadius:3,
                    background:`linear-gradient(90deg,${C.neon},${C.purple})`,
                    width:`${(currentPage/numPages)*100}%`, transition:"width .3s",
                    boxShadow:`0 0 6px ${C.neon}` }} />
                </div>
              </div>

              <button onClick={()=>goToPage(currentPage+1)} disabled={currentPage===numPages}
                style={{ ...glassBtn({padding:"0 14px",width:"auto",height:36,fontSize:12,borderRadius:20}),
                  opacity:currentPage===numPages?.3:1 }}>Next ▶</button>
              <button onClick={()=>goToPage(numPages)} disabled={currentPage===numPages}
                style={{ ...glassBtn({width:36,height:36,fontSize:13}),
                  opacity:currentPage===numPages?.3:1 }}>⏭</button>
            </div>

            {/* Row 2: 5 icon buttons exactly like sketch */}
            <div style={{ display:"flex", borderTop:`1px solid ${border_}` }}>
              {[
                { icon:"🔍", key:"search",   tip:"Search"   },
                { icon:"🔖", key:"saved",    tip:"Saved"    },
                { icon:"🎧", key:"voice",    tip:"Listen"   },
                { icon:"✏️",  key:"notes",    tip:"Notes"    },
                { icon:"🔢", key:"goto",     tip:"Go to"    },
              ].map(item=>(
                <button key={item.key}
                  onClick={()=>{
                    if (item.key==="saved") { toggleBm(); return; }
                    setActivePanel(activePanel===item.key?null:item.key);
                  }}
                  style={{ flex:1, background:"transparent", border:"none",
                    cursor:"pointer", padding:"10px 2px 12px",
                    borderTop:activePanel===item.key||
                      (item.key==="saved"&&isBm)
                      ?`2px solid ${C.neon}`:"2px solid transparent",
                    color:activePanel===item.key||(item.key==="saved"&&isBm)
                      ?C.neonL:txM,
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

          {/* ── PANELS (slide up) ── */}
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

              {/* Handle */}
              <div style={{ display:"flex", justifyContent:"center", padding:"12px 0 6px" }}>
                <div style={{ width:36, height:4, borderRadius:4, cursor:"pointer",
                  background:`linear-gradient(90deg,${C.neon},${C.purple})` }}
                  onClick={()=>setActivePanel(null)} />
              </div>

              <div style={{ padding:"4px 20px 100px" }}>

                {/* SEARCH PANEL */}
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
                          color:"#fff",fontWeight:700,cursor:"pointer",fontSize:14,
                          boxShadow:`0 4px 20px rgba(37,99,235,0.4)` }}>Go</button>
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

                {/* SAVED PAGES PANEL */}
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
                          color:"#fff",fontWeight:700,cursor:"pointer",fontSize:14,
                          boxShadow:`0 4px 20px rgba(37,99,235,0.4)` }}>Go</button>
                    </div>
                    <div style={{ display:"flex",gap:8,flexWrap:"wrap" }}>
                      {[1,Math.floor(numPages*.25),Math.floor(numPages*.5),Math.floor(numPages*.75),numPages]
                        .filter((v,i,a)=>v>0&&a.indexOf(v)===i)
                        .map(pg=>(
                          <button key={pg} onClick={()=>{goToPage(pg);setActivePanel(null);}}
                            style={{ background:pg===currentPage
                              ?`linear-gradient(135deg,${C.glow},${C.purple})`
                              :inputBg,
                              border:`1px solid ${pg===currentPage?C.neon:border_}`,
                              color:pg===currentPage?"#fff":tx,
                              padding:"9px 16px",borderRadius:12,fontSize:12,
                              cursor:"pointer",fontFamily:"inherit",fontWeight:600 }}>
                            {pg===1?"First":pg===numPages?"Last":`Page ${pg}`}
                          </button>
                        ))}
                    </div>
                  </>
                )}

                {/* VOICE PANEL */}
                {activePanel==="voice" && (
                  <>
                    <PanelTitle title="🎧 Voice Reader" tx={tx} />
                    <div style={{ fontSize:12,color:txM,marginBottom:16 }}>
                      Page {currentPage} — tap play to listen
                    </div>
                    <div style={{ display:"flex",alignItems:"center",
                      justifyContent:"center",gap:3,margin:"16px 0",height:56 }}>
                      {Array.from({length:22}).map((_,i)=>(
                        <div key={i} style={{ width:4,borderRadius:4,
                          background:voicePlaying
                            ?`linear-gradient(180deg,${C.neon},${C.purple})`
                            :"rgba(59,130,246,0.2)",
                          boxShadow:voicePlaying?`0 0 8px ${C.neon}`:"none",
                          height:voicePlaying?`${28+Math.abs(Math.sin(i*.5))*72}%`:"20%",
                          animation:voicePlaying?`wave .7s ease ${i*.04}s infinite alternate`:"none",
                          transition:"height .2s" }} />
                      ))}
                    </div>
                    <div style={{ height:4,background:d?C.bg3:"#e2e8f0",borderRadius:4,marginBottom:22 }}>
                      <div style={{ height:"100%",borderRadius:4,
                        background:`linear-gradient(90deg,${C.neon},${C.purple})`,
                        width:`${voiceProgress*100}%`,transition:"width .3s" }} />
                    </div>
                    <div style={{ display:"flex",justifyContent:"center",gap:20,
                      marginBottom:22,alignItems:"center" }}>
                      <button onClick={()=>goToPage(currentPage-1)} disabled={currentPage===1}
                        style={{ ...glassBtn({width:44,height:44}),opacity:currentPage===1?.3:1 }}>⏮</button>
                      <button onClick={toggleVoice}
                        style={{ width:68,height:68,borderRadius:"50%",
                          background:`linear-gradient(135deg,${C.glow},${C.purple})`,
                          border:"none",cursor:"pointer",fontSize:26,color:"#fff",
                          boxShadow:`0 0 40px rgba(37,99,235,0.5)`,
                          display:"flex",alignItems:"center",justifyContent:"center",
                          transition:"transform .15s" }}
                        onMouseEnter={e=>e.currentTarget.style.transform="scale(1.08)"}
                        onMouseLeave={e=>e.currentTarget.style.transform="scale(1)"}>
                        {voicePlaying?"⏸":"▶"}
                      </button>
                      <button onClick={()=>{stopVoice();goToPage(currentPage+1);}}
                        disabled={currentPage===numPages}
                        style={{ ...glassBtn({width:44,height:44}),opacity:currentPage===numPages?.3:1 }}>⏭</button>
                    </div>
                    <div style={{ textAlign:"center" }}>
                      <div style={{ fontSize:12,color:txM,marginBottom:10 }}>
                        Speed: <span style={{color:C.neonL,fontWeight:700}}>{voiceSpeed}x</span>
                      </div>
                      <input type="range" min="0.5" max="2" step="0.25"
                        value={voiceSpeed}
                        onChange={e=>{
                          setVoiceSpeed(parseFloat(e.target.value));
                          if (voicePlaying){stopVoice();setTimeout(startVoice,100);}
                        }}
                        style={{ width:"80%",accentColor:C.neon }} />
                      <div style={{ display:"flex",justifyContent:"space-between",
                        width:"80%",margin:"5px auto 0",fontSize:10,color:txM }}>
                        <span>0.5x</span><span>1x</span><span>1.5x</span><span>2x</span>
                      </div>
                    </div>
                  </>
                )}

                {/* NOTES PANEL */}
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

                {/* TABLE OF CONTENTS */}
                {activePanel==="toc" && (
                  <>
                    <PanelTitle title="📑 Contents" tx={tx} />
                    {toc.length===0
                      ?<div style={{ textAlign:"center",color:txM,padding:"20px 0",fontSize:14 }}>
                        This PDF has no table of contents.
                      </div>
                      :toc.map((item,i)=>(
                        <div key={i} dir="auto" onClick={()=>navToc(item)}
                          style={{ padding:"10px 12px",
                            paddingLeft:12+item.depth*18,
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

      {/* ── TOAST ── */}
      {toast && (
        <div style={{ position:"fixed", bottom:100, left:"50%",
          transform:"translateX(-50%)",
          background:toast.type==="success"
            ?`linear-gradient(135deg,${C.glow},${C.purple})`
            :d?"rgba(12,20,40,0.95)":"rgba(255,255,255,0.95)",
          backdropFilter:"blur(12px)", color:tx,
          padding:"10px 22px", borderRadius:24, fontSize:13,
          boxShadow:`0 4px 28px rgba(37,99,235,0.35)`,
          border:`1px solid ${C.borderG}`,
          zIndex:500, whiteSpace:"nowrap",
          animation:"fadeUp .2s ease", fontWeight:600,
          color:toast.type==="success"?"#fff":tx }}>
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
function DrawerRow({ icon, label, sub, onClick, tx, txM, accL }) {
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
function SmallBookCard({ book, hue, lastPage, bms, onOpen, onRemove, d }) {
  return (
    <div style={{ flexShrink:0, width:105, position:"relative", cursor:"pointer" }}
      onClick={onOpen}>
      <div style={{ height:145, borderRadius:14,
        background:`linear-gradient(160deg,hsl(${hue},60%,28%),hsl(${hue+30},50%,16%))`,
        border:`1px solid hsl(${hue},40%,35%)`,
        boxShadow:`0 0 18px hsla(${hue},60%,40%,.22),0 6px 28px rgba(0,0,0,.5)`,
        display:"flex", flexDirection:"column", alignItems:"center",
        justifyContent:"center", padding:"10px 6px", gap:6, marginBottom:8,
        transition:"transform .2s, box-shadow .2s" }}
        onMouseEnter={e=>{e.currentTarget.style.transform="translateY(-4px)";e.currentTarget.style.boxShadow=`0 0 28px hsla(${hue},60%,40%,.4),0 14px 36px rgba(0,0,0,.6)`;}}
        onMouseLeave={e=>{e.currentTarget.style.transform="";e.currentTarget.style.boxShadow=`0 0 18px hsla(${hue},60%,40%,.22),0 6px 28px rgba(0,0,0,.5)`;}} >
        <div style={{ fontSize:24 }}>📄</div>
        <div dir="auto" style={{ fontSize:9, color:`hsl(${hue},18%,88%)`,
          textAlign:"center", fontWeight:700, lineHeight:1.4,
          display:"-webkit-box", WebkitLineClamp:4,
          WebkitBoxOrient:"vertical", overflow:"hidden" }}>{book.name}</div>
        {lastPage && (
          <div style={{ fontSize:9, color:`hsl(${hue},40%,72%)`,
            background:"rgba(0,0,0,0.3)", borderRadius:8, padding:"2px 6px" }}>
            Pg {lastPage}
          </div>
        )}
        {bms>0 && (
          <div style={{ position:"absolute", top:5, right:5,
            background:"rgba(0,0,0,0.7)", borderRadius:6,
            padding:"1px 5px", fontSize:8, color:C.neonL }}>
            🔖{bms}
          </div>
        )}
      </div>
      <div dir="auto" style={{ fontSize:10, fontWeight:700, color:d?C.txM:"#334155",
        lineHeight:1.3, display:"-webkit-box", WebkitLineClamp:2,
        WebkitBoxOrient:"vertical", overflow:"hidden" }}>{book.name}</div>
      <button onClick={e=>{e.stopPropagation();onRemove();}}
        style={{ position:"absolute", top:5, left:5, background:"rgba(0,0,0,0.65)",
          border:"none", borderRadius:"50%", width:20, height:20, cursor:"pointer",
          color:"#fff", fontSize:11, display:"flex", alignItems:"center",
          justifyContent:"center" }}>×</button>
    </div>
  );
}
function BigBookCard({ book, hue, lastPage, bms, onOpen, onDelete }) {
  return (
    <div style={{ position:"relative", animation:"fadeIn .3s ease both" }}>
      <div onClick={onOpen} style={{ cursor:"pointer" }}>
        <div style={{ aspectRatio:"2/3", borderRadius:14,
          background:`linear-gradient(160deg,hsl(${hue},55%,26%),hsl(${hue+30},45%,15%))`,
          border:`1px solid hsl(${hue},35%,30%)`,
          boxShadow:`0 0 14px hsla(${hue},50%,32%,.18),0 5px 20px rgba(0,0,0,.5)`,
          display:"flex", flexDirection:"column", alignItems:"center",
          justifyContent:"center", padding:"10px 6px", gap:6, marginBottom:6,
          transition:"transform .2s, box-shadow .2s" }}
          onMouseEnter={e=>{e.currentTarget.style.transform="translateY(-3px)";e.currentTarget.style.boxShadow=`0 0 22px hsla(${hue},50%,32%,.32),0 10px 28px rgba(0,0,0,.6)`;}}
          onMouseLeave={e=>{e.currentTarget.style.transform="";e.currentTarget.style.boxShadow=`0 0 14px hsla(${hue},50%,32%,.18),0 5px 20px rgba(0,0,0,.5)`;}} >
          <div style={{ fontSize:20 }}>📄</div>
          <div dir="auto" style={{ fontSize:8, color:`hsl(${hue},15%,88%)`,
            textAlign:"center", fontWeight:700, lineHeight:1.3,
            display:"-webkit-box", WebkitLineClamp:4,
            WebkitBoxOrient:"vertical", overflow:"hidden" }}>{book.name}</div>
          {bms>0 && (
            <div style={{ position:"absolute", top:4, right:4,
              background:"rgba(0,0,0,0.7)", borderRadius:6,
              padding:"1px 4px", fontSize:8, color:C.neonL }}>🔖{bms}</div>
          )}
        </div>
        <div dir="auto" style={{ fontSize:9, fontWeight:700, color:C.txM,
          lineHeight:1.3, display:"-webkit-box", WebkitLineClamp:2,
          WebkitBoxOrient:"vertical", overflow:"hidden" }}>{book.name}</div>
        {lastPage&&<div style={{ fontSize:8, color:C.neon, marginTop:1 }}>Pg {lastPage}</div>}
      </div>
      <button onClick={onDelete}
        style={{ position:"absolute", top:4, left:4, background:"rgba(0,0,0,0.7)",
          border:"none", borderRadius:"50%", width:18, height:18, cursor:"pointer",
          color:"#fff", fontSize:10, display:"flex", alignItems:"center",
          justifyContent:"center" }}>×</button>
    </div>
  );
}
