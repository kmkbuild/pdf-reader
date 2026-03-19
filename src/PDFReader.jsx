import { useState, useEffect, useRef, useCallback } from "react";

// ── PDF.js ──────────────────────────────────────────────────────────────────
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

// ── IndexedDB persistence ────────────────────────────────────────────────────
const DB_NAME = "PDFReaderDB";
const DB_VERSION = 1;

function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      // Store PDF files as ArrayBuffer
      if (!db.objectStoreNames.contains("pdfs"))
        db.createObjectStore("pdfs", { keyPath: "name" });
      // Store app settings (bookmarks, notes, lastRead)
      if (!db.objectStoreNames.contains("settings"))
        db.createObjectStore("settings", { keyPath: "key" });
    };
    req.onsuccess = e => res(e.target.result);
    req.onerror = e => rej(e.target.error);
  });
}

async function dbSavePDF(name, arrayBuffer, size, modified) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction("pdfs", "readwrite");
    tx.objectStore("pdfs").put({ name, data: arrayBuffer, size, modified });
    tx.oncomplete = () => res();
    tx.onerror = e => rej(e.target.error);
  });
}

async function dbGetAllPDFs() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction("pdfs", "readonly");
    const req = tx.objectStore("pdfs").getAll();
    req.onsuccess = e => res(e.target.result || []);
    req.onerror = e => rej(e.target.error);
  });
}

async function dbDeletePDF(name) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction("pdfs", "readwrite");
    tx.objectStore("pdfs").delete(name);
    tx.oncomplete = () => res();
    tx.onerror = e => rej(e.target.error);
  });
}

async function dbSaveSetting(key, value) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction("settings", "readwrite");
    tx.objectStore("settings").put({ key, value });
    tx.oncomplete = () => res();
    tx.onerror = e => rej(e.target.error);
  });
}

async function dbGetSetting(key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction("settings", "readonly");
    const req = tx.objectStore("settings").get(key);
    req.onsuccess = e => res(e.target.result?.value ?? null);
    req.onerror = e => rej(e.target.error);
  });
}

// ── Cover color per book ─────────────────────────────────────────────────────
function coverColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffffffff;
  const hues = [14, 30, 48, 190, 220, 260, 340];
  const hue = hues[Math.abs(h) % hues.length];
  return { bg: `hsl(${hue},50%,42%)`, spine: `hsl(${hue},50%,28%)`, text: `hsl(${hue},15%,92%)` };
}

// ── Scan folder recursively ──────────────────────────────────────────────────
async function scanDir(dirHandle, depth = 0) {
  const pdfs = [];
  if (depth > 5) return pdfs;
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === "file" && name.toLowerCase().endsWith(".pdf")) {
      const file = await handle.getFile();
      pdfs.push({ name: name.replace(/\.pdf$/i, ""), file, size: file.size, modified: file.lastModified });
    } else if (handle.kind === "directory") {
      pdfs.push(...await scanDir(handle, depth + 1));
    }
  }
  return pdfs;
}

// ════════════════════════════════════════════════════════════════════════════
export default function PDFReader() {
  // ── App state ──
  const [screen, setScreen] = useState("library");
  const [pdfjsReady, setPdfjsReady] = useState(false);
  const [dark, setDark] = useState(false); // LIGHT default

  // ── Library ──
  const [library, setLibrary] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [libSearch, setLibSearch] = useState("");
  const [toast, setToast] = useState(null);

  // ── Reader ──
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
  const [textCache, setTextCache] = useState({});
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);

  // ── Panel state (all closed by default) ──
  const [activePanel, setActivePanel] = useState(null); // null | "saved" | "goto" | "search" | "notes" | "toc"
  const [goInput, setGoInput] = useState("");

  const canvasRef = useRef(null);
  const renderTaskRef = useRef(null);
  const fileInputRef = useRef(null);
  const containerRef = useRef(null);

  // ── Load PDF.js + restore saved library & settings ──
  useEffect(() => {
    // Load PDF.js engine
    loadScript(PDFJS_URL).then(() => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER_URL;
      setPdfjsReady(true);
    });
    // Restore all PDFs saved in IndexedDB
    dbGetAllPDFs().then(rows => {
      if (!rows.length) return;
      const books = rows.map(row => ({
        name: row.name,
        file: new File([row.data], row.name + ".pdf", { type: "application/pdf" }),
        size: row.size,
        modified: row.modified,
      }));
      setLibrary(books);
    }).catch(() => {});
    // Restore settings
    dbGetSetting("bookmarks").then(v => { if (v) setBookmarks(v); }).catch(() => {});
    dbGetSetting("notes").then(v => { if (v) setNotes(v); }).catch(() => {});
    dbGetSetting("lastRead").then(v => { if (v) setLastRead(v); }).catch(() => {});
    dbGetSetting("dark").then(v => { if (v !== null) setDark(v); }).catch(() => {});
  }, []);

  useEffect(() => {
    if (currentBook) setNoteInput(notes[currentBook.name]?.[currentPage] || "");
  }, [currentPage, currentBook]);

  // ── Auto-save settings to IndexedDB whenever they change ──
  useEffect(() => { dbSaveSetting("bookmarks", bookmarks).catch(() => {}); }, [bookmarks]);
  useEffect(() => { dbSaveSetting("notes", notes).catch(() => {}); }, [notes]);
  useEffect(() => { dbSaveSetting("lastRead", lastRead).catch(() => {}); }, [lastRead]);
  useEffect(() => { dbSaveSetting("dark", dark).catch(() => {}); }, [dark]);

  const showToast = (msg, type = "info") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 2500);
  };

  // ── Auto-fit zoom to container width ──
  const calcZoom = useCallback((page) => {
    const container = containerRef.current;
    if (!container) return 1.2;
    const availW = container.clientWidth - 32;
    const vp = page.getViewport({ scale: 1 });
    return Math.max(0.5, availW / vp.width);
  }, []);

  // ── Render page ──
  const renderPage = useCallback(async (doc, pageNum, customZoom) => {
    if (!canvasRef.current || !doc) return;
    if (renderTaskRef.current) {
      try { renderTaskRef.current.cancel(); } catch {}
    }
    setRendering(true);
    try {
      const page = await doc.getPage(pageNum);
      const scale = customZoom || calcZoom(page);
      const vp = page.getViewport({ scale });
      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d");
      canvas.width = vp.width;
      canvas.height = vp.height;
      // Clear canvas first
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      // White background so colour PDFs render correctly
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const task = page.render({
        canvasContext: ctx,
        viewport: vp,
        intent: "display",
      });
      renderTaskRef.current = task;
      await task.promise;
    } catch (e) {
      if (e?.name !== "RenderingCancelledException") console.error("Render error:", e);
    } finally {
      setRendering(false);
    }
  }, [calcZoom]);

  useEffect(() => {
    if (pdfDoc) renderPage(pdfDoc, currentPage, zoom !== 1 ? zoom : null);
  }, [pdfDoc, currentPage, zoom, renderPage]);

  // ── Flatten TOC outline ──
  const flattenOutline = (items, depth = 0) => {
    if (!items) return [];
    return items.flatMap(item => [
      { title: item.title, dest: item.dest, depth },
      ...flattenOutline(item.items, depth + 1),
    ]);
  };

  // ── Open a book ──
  const openBook = async (book) => {
    if (!pdfjsReady) { showToast("Still loading PDF engine…"); return; }
    setCurrentBook(book);
    const resumePage = lastRead[book.name] || 1;
    setCurrentPage(resumePage);
    setToc([]); setSearchResults([]); setSearchQuery("");
    setTextCache({}); setActivePanel(null); setZoom(1);
    try {
      const buf = await book.file.arrayBuffer();
      const loadingTask = window.pdfjsLib.getDocument({
        data: buf,
        cMapUrl: `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PV}/cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PV}/standard_fonts/`,
      });
      const doc = await loadingTask.promise;
      setPdfDoc(doc);
      setNumPages(doc.numPages);
      try {
        const outline = await doc.getOutline();
        setToc(flattenOutline(outline));
      } catch { setToc([]); }
      setScreen("reader");
    } catch (e) {
      console.error("PDF open error:", e);
      showToast("Could not open PDF. File may be corrupted.", "error");
    }
  };

  // ── File upload handlers ──
  const handleFiles = async (files) => {
    if (!files?.length) return;
    const newBooks = Array.from(files)
      .filter(f => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"))
      .map(f => ({ name: f.name.replace(/\.pdf$/i, ""), file: f, size: f.size, modified: f.lastModified }));
    if (!newBooks.length) { showToast("No PDF files found."); return; }

    // Save each PDF's bytes into IndexedDB so it persists after app closes
    for (const book of newBooks) {
      try {
        const buf = await book.file.arrayBuffer();
        await dbSavePDF(book.name, buf, book.size, book.modified);
      } catch (e) { console.warn("Could not save to DB:", e); }
    }

    setLibrary(prev => {
      const names = new Set(prev.map(b => b.name));
      const added = newBooks.filter(b => !names.has(b.name));
      return [...prev, ...added];
    });
    showToast(`Added ${newBooks.length} book${newBooks.length > 1 ? "s" : ""}! It will stay in your library.`, "success");
  };

  const handleScanFolder = async () => {
    if (!("showDirectoryPicker" in window)) {
      fileInputRef.current.click(); return;
    }
    try {
      const dir = await window.showDirectoryPicker({ mode: "read" });
      setScanning(true);
      const found = await scanDir(dir);
      setScanning(false);
      if (!found.length) { showToast("No PDFs found in that folder."); return; }
      // Save all found PDFs to IndexedDB
      for (const book of found) {
        try {
          const buf = await book.file.arrayBuffer();
          await dbSavePDF(book.name, buf, book.size, book.modified);
        } catch (e) { console.warn("Could not save to DB:", e); }
      }
      setLibrary(prev => {
        const names = new Set(prev.map(b => b.name));
        return [...prev, ...found.filter(b => !names.has(b.name))];
      });
      showToast(`Found ${found.length} PDF${found.length > 1 ? "s" : ""}! Saved to library.`, "success");
    } catch (e) {
      setScanning(false);
      if (e?.name !== "AbortError") showToast("Could not access folder.");
    }
  };

  // ── Navigation ──
  const goToPage = (n) => {
    const p = Math.max(1, Math.min(n, numPages));
    setCurrentPage(p);
    if (currentBook) setLastRead(prev => ({ ...prev, [currentBook.name]: p }));
  };

  const navigateToc = async (item) => {
    if (!pdfDoc || !item.dest) return;
    try {
      let dest = item.dest;
      if (typeof dest === "string") dest = await pdfDoc.getDestination(dest);
      if (!dest) return;
      goToPage((await pdfDoc.getPageIndex(dest[0])) + 1);
      setActivePanel(null);
    } catch {}
  };

  // ── Bookmarks ──
  const bookKey = currentBook?.name || "";
  const bookBookmarks = bookmarks[bookKey] || [];
  const isBookmarked = bookBookmarks.includes(currentPage);
  const toggleBookmark = () => {
    if (isBookmarked) {
      setBookmarks(p => ({ ...p, [bookKey]: bookBookmarks.filter(b => b !== currentPage) }));
      showToast(`Removed from saved pages`);
    } else {
      setBookmarks(p => ({ ...p, [bookKey]: [...bookBookmarks, currentPage].sort((a, b) => a - b) }));
      showToast(`Page ${currentPage} saved!`, "success");
    }
  };

  // ── Notes ──
  const bookNotes = notes[bookKey] || {};
  const saveNote = () => {
    const updated = { ...bookNotes };
    if (!noteInput.trim()) delete updated[currentPage];
    else updated[currentPage] = noteInput;
    setNotes(p => ({ ...p, [bookKey]: updated }));
    showToast(noteInput.trim() ? "Note saved!" : "Note deleted", "success");
  };

  // ── Search ──
  const getPageText = async (doc, p) => {
    if (textCache[p]) return textCache[p];
    const page = await doc.getPage(p);
    const c = await page.getTextContent();
    const text = c.items.map(i => i.str).join(" ");
    setTextCache(prev => ({ ...prev, [p]: text }));
    return text;
  };

  const runSearch = async () => {
    if (!pdfDoc || !searchQuery.trim()) return;
    setSearching(true); setSearchResults([]);
    const q = searchQuery.trim().toLowerCase();
    const results = [];
    for (let p = 1; p <= numPages; p++) {
      try {
        const text = await getPageText(pdfDoc, p);
        const lower = text.toLowerCase();
        let idx = lower.indexOf(q);
        const snippets = [];
        while (idx !== -1 && snippets.length < 2) {
          snippets.push(text.slice(Math.max(0, idx - 30), Math.min(text.length, idx + q.length + 30)));
          idx = lower.indexOf(q, idx + 1);
        }
        if (snippets.length) results.push({ page: p, snippets });
      } catch {}
    }
    setSearchResults(results); setSearching(false);
    if (!results.length) showToast("No results found.");
    else showToast(`Found on ${results.length} page${results.length > 1 ? "s" : ""}`, "success");
  };

  // ── Theme ──
  const d = dark;
  const bg       = d ? "#111"     : "#f7f3ee";
  const surface  = d ? "#1c1c1c"  : "#ffffff";
  const panelBg  = d ? "#161616"  : "#fdfaf6";
  const border   = d ? "#2a2a2a"  : "#e0d8cc";
  const tx       = d ? "#e8e0d0"  : "#1a1208";
  const muted    = d ? "#666"     : "#8a7a68";
  const acc      = d ? "#c9a96e"  : "#b5681e";
  const accLight = d ? "#c9a96e22" : "#b5681e14";
  const inputBg  = d ? "#222"     : "#f5f0e8";
  const canvasBg = d ? "#1a1818"  : "#e8e0d4";
  const navBg    = d ? "#181818"  : "#ffffff";

  const filteredLib = library.filter(b =>
    b.name.toLowerCase().includes(libSearch.toLowerCase())
  );

  // ── Shared styles ──
  const btn = (bg2, outline = false) => ({
    background: outline ? "transparent" : bg2,
    border: `2px solid ${outline ? border : bg2}`,
    color: outline ? tx : "#fff",
    padding: "10px 18px", borderRadius: 12,
    fontSize: 13, fontWeight: 700, cursor: "pointer",
    fontFamily: "inherit", transition: "all .15s",
    whiteSpace: "nowrap",
  });

  const iconBtn = (col) => ({
    background: "none", border: "none", cursor: "pointer",
    color: col, fontSize: 20, padding: "6px 8px",
    borderRadius: 8, lineHeight: 1,
  });

  const navBtn = (col, disabled) => ({
    background: disabled ? "transparent" : col,
    border: `2px solid ${disabled ? border : col}`,
    color: disabled ? muted : "#fff",
    padding: "8px 14px", borderRadius: 10,
    fontSize: 12, fontWeight: 700, cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1, fontFamily: "inherit",
  });

  const panelStyle = {
    position: "absolute", bottom: 0, left: 0, right: 0,
    background: panelBg, borderTop: `2px solid ${border}`,
    borderRadius: "18px 18px 0 0",
    padding: "16px 16px 24px",
    maxHeight: "55vh", overflowY: "auto",
    zIndex: 50, boxShadow: "0 -8px 40px #0003",
    animation: "slideUp .25s ease",
  };

  // ════════════ LIBRARY SCREEN ════════════════════════════════════════════════
  if (screen === "library") return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh",
      background: bg, color: tx, fontFamily: "'Georgia','Book Antiqua',serif",
      overflow: "hidden" }}>

      {/* Header */}
      <div style={{ background: surface, borderBottom: `1px solid ${border}`,
        padding: "14px 18px", display: "flex", alignItems: "center", gap: 10,
        flexShrink: 0 }}>
        <span style={{ fontSize: 26 }}>📚</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 800, fontSize: 18, color: acc }}>My Library</div>
          <div style={{ fontSize: 11, color: muted }}>{library.length} book{library.length !== 1 ? "s" : ""}</div>
        </div>
        <button onClick={() => setDark(!d)} style={iconBtn(acc)}>{d ? "☀️" : "🌙"}</button>
      </div>

      {/* Search bar */}
      {library.length > 0 && (
        <div style={{ padding: "12px 16px", background: surface,
          borderBottom: `1px solid ${border}` }}>
          <input value={libSearch} onChange={e => setLibSearch(e.target.value)}
            placeholder="🔍  Search books…"
            style={{ width: "100%", padding: "10px 14px", borderRadius: 12,
              border: `1px solid ${border}`, background: inputBg, color: tx,
              fontSize: 14, fontFamily: "inherit", outline: "none",
              boxSizing: "border-box" }} />
        </div>
      )}

      {/* Book grid */}
      <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
        {library.length === 0 ? (
          /* Empty state */
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center",
            justifyContent: "center", minHeight: "70vh", gap: 16, textAlign: "center",
            padding: 24 }}>
            <div style={{ fontSize: 72 }}>📖</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: acc }}>No books yet</div>
            <div style={{ fontSize: 14, color: muted, maxWidth: 300, lineHeight: 1.8 }}>
              Add PDF books from your device or scan a folder
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center",
              marginTop: 8 }}>
              <button onClick={handleScanFolder} style={btn(acc)}>
                📂 Scan Folder
              </button>
              <button onClick={() => fileInputRef.current.click()} style={btn(acc, true)}>
                + Add PDF
              </button>
            </div>
          </div>
        ) : (
          <>
            <div style={{ display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 16,
              marginBottom: 80 }}>
              {filteredLib.map((book, i) => {
                const c = coverColor(book.name);
                const bms = (bookmarks[book.name] || []).length;
                const pg = lastRead[book.name];
                return (
                  <div key={i} onClick={() => openBook(book)}
                    style={{ cursor: "pointer", animation: `fadeIn .3s ease ${i * .04}s both` }}>
                    {/* Cover */}
                    <div style={{ position: "relative", borderRadius: "4px 10px 10px 4px",
                      overflow: "hidden", marginBottom: 8,
                      boxShadow: "4px 6px 20px #0002",
                      aspectRatio: "2/3", background: c.bg,
                      transition: "transform .2s, box-shadow .2s" }}
                      onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-4px)"; e.currentTarget.style.boxShadow = "6px 12px 28px #0004"; }}
                      onMouseLeave={e => { e.currentTarget.style.transform = ""; e.currentTarget.style.boxShadow = "4px 6px 20px #0002"; }}>
                      {/* Spine */}
                      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0,
                        width: 12, background: c.spine }} />
                      {/* Content */}
                      <div style={{ position: "absolute", left: 12, right: 0, top: 0, bottom: 0,
                        display: "flex", flexDirection: "column", alignItems: "center",
                        justifyContent: "center", padding: "14px 10px", gap: 8 }}>
                        <div style={{ fontSize: 28 }}>📄</div>
                        <div dir="auto" style={{ fontSize: 10, color: c.text, textAlign: "center",
                          fontWeight: 700, lineHeight: 1.4, wordBreak: "break-word",
                          display: "-webkit-box", WebkitLineClamp: 4,
                          WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                          {book.name}
                        </div>
                      </div>
                      {/* Progress */}
                      {pg && (
                        <div style={{ position: "absolute", bottom: 0, left: 12, right: 0,
                          height: 3, background: "#fff2" }}>
                          <div style={{ height: "100%", background: c.text, opacity: .8,
                            width: `${Math.min(100, (pg / Math.max(1, numPages)) * 100)}%` }} />
                        </div>
                      )}
                      {bms > 0 && (
                        <div style={{ position: "absolute", top: 5, right: 5,
                          background: "#000a", borderRadius: 8, padding: "2px 5px",
                          fontSize: 9, color: "#fff" }}>🔖{bms}</div>
                      )}
                      {/* Delete button */}
                      <button
                        onClick={e => {
                          e.stopPropagation();
                          if (window.confirm(`Remove "${book.name}" from library?`)) {
                            dbDeletePDF(book.name).catch(() => {});
                            setLibrary(prev => prev.filter(b => b.name !== book.name));
                            showToast("Removed from library");
                          }
                        }}
                        style={{ position: "absolute", top: 5, left: 16,
                          background: "#000a", border: "none", borderRadius: "50%",
                          width: 22, height: 22, cursor: "pointer", color: "#fff",
                          fontSize: 13, display: "flex", alignItems: "center",
                          justifyContent: "center", lineHeight: 1 }}>
                        ×
                      </button>
                    </div>
                    {/* Title */}
                    <div dir="auto" style={{ fontSize: 11, fontWeight: 700, color: tx,
                      lineHeight: 1.4, marginBottom: 2, wordBreak: "break-word",
                      display: "-webkit-box", WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                      {book.name}
                    </div>
                    {pg && <div style={{ fontSize: 10, color: acc }}>Page {pg}</div>}
                    <div style={{ fontSize: 10, color: muted }}>
                      {(book.size / 1024 / 1024).toFixed(1)} MB
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* Bottom add buttons */}
      {library.length > 0 && (
        <div style={{ position: "fixed", bottom: 0, left: 0, right: 0,
          background: navBg, borderTop: `1px solid ${border}`,
          padding: "12px 16px", display: "flex", gap: 10,
          boxShadow: "0 -4px 20px #0001" }}>
          <button onClick={handleScanFolder} disabled={scanning}
            style={{ ...btn(acc), flex: 1 }}>
            {scanning ? "Scanning…" : "📂 Scan Folder"}
          </button>
          <button onClick={() => fileInputRef.current.click()}
            style={{ ...btn(acc, true), flex: 1 }}>
            + Add PDF
          </button>
        </div>
      )}

      <input ref={fileInputRef} type="file" accept=".pdf,application/pdf"
        multiple style={{ display: "none" }}
        onChange={e => handleFiles(e.target.files)} />

      {toast && <Toast msg={toast.msg} type={toast.type} acc={acc} surface={surface} tx={tx} border={border} />}
      <style>{globalCSS}</style>
    </div>
  );

  // ════════════ READER SCREEN ═════════════════════════════════════════════════
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh",
      background: bg, color: tx, fontFamily: "'Georgia','Book Antiqua',serif",
      overflow: "hidden" }}>

      {/* ── Top bar ── */}
      <div style={{ background: surface, borderBottom: `1px solid ${border}`,
        padding: "10px 14px", display: "flex", alignItems: "center", gap: 8,
        flexShrink: 0 }}>
        {/* Back */}
        <button onClick={() => { setScreen("library"); setPdfDoc(null); setActivePanel(null); }}
          style={{ ...btn(acc, true), padding: "7px 12px", fontSize: 12 }}>
          ← Library
        </button>
        {/* Title */}
        <div style={{ flex: 1, overflow: "hidden" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: acc,
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {currentBook?.name}
          </div>
          <div style={{ fontSize: 11, color: muted }}>
            Page {currentPage} of {numPages}
          </div>
        </div>
        {/* Zoom controls */}
        <button onClick={() => setZoom(z => Math.max(.5, +(z - .2).toFixed(1)))}
          style={iconBtn(muted)}>−</button>
        <span style={{ fontSize: 11, color: muted, minWidth: 36, textAlign: "center" }}>
          {Math.round(zoom * 100)}%
        </span>
        <button onClick={() => setZoom(z => Math.min(3, +(z + .2).toFixed(1)))}
          style={iconBtn(muted)}>+</button>
        <button onClick={() => setDark(!d)} style={iconBtn(acc)}>{d ? "☀️" : "🌙"}</button>
      </div>

      {/* ── Canvas ── */}
      <div ref={containerRef}
        style={{ flex: 1, overflowY: "auto", overflowX: "auto",
          background: canvasBg, display: "flex",
          flexDirection: "column", alignItems: "center",
          padding: "16px 0 120px" }}
        onClick={() => activePanel && setActivePanel(null)}>

        {rendering && (
          <div style={{ position: "fixed", top: 60, left: "50%",
            transform: "translateX(-50%)", background: surface,
            color: acc, padding: "6px 16px", borderRadius: 20, fontSize: 12,
            border: `1px solid ${acc}`, zIndex: 30 }}>
            Rendering…
          </div>
        )}

        <div style={{ boxShadow: "0 4px 32px #0003", display: "inline-block" }}>
          <canvas ref={canvasRef}
            style={{ display: "block", maxWidth: "100%" }} />
        </div>

        {/* Note display */}
        {bookNotes[currentPage] && (
          <div dir="auto" style={{ margin: "14px 16px 0", maxWidth: 600, width: "calc(100% - 32px)",
            background: surface, border: `1px solid ${acc}44`,
            borderRadius: 12, padding: "10px 14px",
            fontSize: 13, color: muted, fontStyle: "italic" }}>
            <span style={{ color: acc, fontWeight: 700, fontStyle: "normal" }}>
              ✏️ Note:&nbsp;
            </span>
            {bookNotes[currentPage]}
          </div>
        )}
      </div>

      {/* ── Bottom navigation ── */}
      <div style={{ position: "fixed", bottom: 0, left: 0, right: 0,
        background: navBg, borderTop: `2px solid ${border}`,
        zIndex: 40, boxShadow: "0 -4px 20px #0002" }}>

        {/* Page prev/next row */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "10px 14px 6px", gap: 8 }}>
          <button onClick={() => goToPage(currentPage - 1)} disabled={currentPage === 1}
            style={navBtn(acc, currentPage === 1)}>
            ◀ Previous
          </button>

          {/* Page indicator */}
          <div style={{ textAlign: "center", flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: acc }}>
              {currentPage} / {numPages}
            </div>
            <div style={{ height: 3, background: border, borderRadius: 3, marginTop: 4 }}>
              <div style={{ height: "100%", background: acc, borderRadius: 3,
                width: `${(currentPage / numPages) * 100}%`, transition: "width .3s" }} />
            </div>
          </div>

          <button onClick={() => goToPage(currentPage + 1)} disabled={currentPage === numPages}
            style={navBtn(acc, currentPage === numPages)}>
            Next ▶
          </button>
        </div>

        {/* Action buttons row */}
        <div style={{ display: "flex", borderTop: `1px solid ${border}` }}>
          {[
            { key: "saved",  icon: "🔖", label: "Saved Pages" },
            { key: "goto",   icon: "🔢", label: "Go to Page" },
            { key: "search", icon: "🔍", label: "Search" },
            { key: "notes",  icon: "✏️",  label: "Notes" },
            { key: "toc",    icon: "📑", label: "Contents" },
          ].map(item => (
            <button key={item.key}
              onClick={() => setActivePanel(activePanel === item.key ? null : item.key)}
              style={{ flex: 1, background: activePanel === item.key ? accLight : "transparent",
                border: "none", cursor: "pointer", padding: "8px 2px",
                borderTop: activePanel === item.key ? `2px solid ${acc}` : "2px solid transparent",
                color: activePanel === item.key ? acc : muted,
                fontFamily: "inherit", transition: "all .15s" }}>
              <div style={{ fontSize: 16 }}>{item.icon}</div>
              <div style={{ fontSize: 9, fontWeight: 600, marginTop: 2,
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {item.label}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* ── Panels (slide up from bottom) ── */}
      {activePanel && (
        <div style={panelStyle}>
          {/* Handle bar */}
          <div style={{ width: 40, height: 4, background: border, borderRadius: 4,
            margin: "0 auto 16px", cursor: "pointer" }}
            onClick={() => setActivePanel(null)} />

          {/* ── SAVED PAGES ── */}
          {activePanel === "saved" && (
            <>
              <div style={{ display: "flex", justifyContent: "space-between",
                alignItems: "center", marginBottom: 14 }}>
                <div style={{ fontSize: 16, fontWeight: 800, color: tx }}>
                  🔖 Saved Pages
                </div>
                <button onClick={toggleBookmark}
                  style={{ ...btn(isBookmarked ? "#b85c1e" : acc), padding: "7px 14px", fontSize: 12 }}>
                  {isBookmarked ? "Remove This Page" : `Save Page ${currentPage}`}
                </button>
              </div>
              {bookBookmarks.length === 0 ? (
                <div style={{ textAlign: "center", color: muted, padding: "20px 0", fontSize: 14 }}>
                  No saved pages yet.<br />
                  <span style={{ fontSize: 12 }}>Press "Save Page" to bookmark the current page.</span>
                </div>
              ) : bookBookmarks.map(pg => (
                <div key={pg}
                  style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
                    padding: "12px 14px", borderRadius: 12, marginBottom: 6, cursor: "pointer",
                    background: pg === currentPage ? accLight : inputBg,
                    border: `1px solid ${pg === currentPage ? acc : border}` }}
                  onClick={() => { goToPage(pg); setActivePanel(null); }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700,
                      color: pg === currentPage ? acc : tx }}>
                      Page {pg}
                    </div>
                    {bookNotes[pg] && (
                      <div style={{ fontSize: 11, color: muted, marginTop: 2 }}>
                        ✏️ Has a note
                      </div>
                    )}
                  </div>
                  <button onClick={e => { e.stopPropagation();
                    setBookmarks(p => ({ ...p, [bookKey]: bookBookmarks.filter(b => b !== pg) })); }}
                    style={{ background: "none", border: "none", cursor: "pointer",
                      color: muted, fontSize: 18 }}>×</button>
                </div>
              ))}
            </>
          )}

          {/* ── GO TO PAGE ── */}
          {activePanel === "goto" && (
            <>
              <div style={{ fontSize: 16, fontWeight: 800, color: tx, marginBottom: 14 }}>
                🔢 Go to Page
              </div>
              <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
                <input type="number" value={goInput}
                  onChange={e => setGoInput(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") { goToPage(parseInt(goInput)); setGoInput(""); setActivePanel(null); } }}
                  placeholder={`Enter page (1 – ${numPages})`}
                  min={1} max={numPages}
                  style={{ flex: 1, padding: "12px 14px", borderRadius: 12,
                    border: `2px solid ${border}`, background: inputBg,
                    color: tx, fontSize: 15, fontFamily: "inherit", outline: "none" }} />
                <button onClick={() => { goToPage(parseInt(goInput)); setGoInput(""); setActivePanel(null); }}
                  style={{ ...btn(acc), padding: "12px 20px" }}>
                  Go
                </button>
              </div>
              {/* Quick jump buttons */}
              <div style={{ fontSize: 12, color: muted, marginBottom: 8 }}>Quick jump:</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {[1, Math.floor(numPages / 4), Math.floor(numPages / 2),
                  Math.floor(numPages * 3 / 4), numPages]
                  .filter((v, i, a) => v > 0 && a.indexOf(v) === i)
                  .map(pg => (
                    <button key={pg} onClick={() => { goToPage(pg); setActivePanel(null); }}
                      style={{ ...btn(pg === currentPage ? acc : inputBg, pg !== currentPage),
                        border: `1px solid ${border}`, color: pg === currentPage ? "#fff" : tx,
                        padding: "8px 14px", fontSize: 12 }}>
                      {pg === 1 ? "First" : pg === numPages ? "Last" : `Page ${pg}`}
                    </button>
                  ))}
              </div>
            </>
          )}

          {/* ── SEARCH ── */}
          {activePanel === "search" && (
            <>
              <div style={{ fontSize: 16, fontWeight: 800, color: tx, marginBottom: 14 }}>
                🔍 Search in PDF
              </div>
              <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
                <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && runSearch()}
                  placeholder="Type to search entire PDF…" dir="auto"
                  style={{ flex: 1, padding: "12px 14px", borderRadius: 12,
                    border: `2px solid ${border}`, background: inputBg,
                    color: tx, fontSize: 14, fontFamily: "inherit", outline: "none" }} />
                <button onClick={runSearch} style={{ ...btn(acc), padding: "12px 18px" }}>
                  Search
                </button>
              </div>
              {searching && (
                <div style={{ textAlign: "center", color: muted, padding: 12 }}>
                  Searching all {numPages} pages…
                </div>
              )}
              {!searching && searchResults.length === 0 && searchQuery && (
                <div style={{ textAlign: "center", color: muted, padding: 12 }}>
                  No results found for "{searchQuery}"
                </div>
              )}
              {searchResults.map((r, i) => (
                <div key={i} onClick={() => { goToPage(r.page); setActivePanel(null); }}
                  style={{ padding: "12px 14px", borderRadius: 12, marginBottom: 8,
                    background: r.page === currentPage ? accLight : inputBg,
                    border: `1px solid ${r.page === currentPage ? acc : border}`,
                    cursor: "pointer" }}>
                  <div style={{ fontSize: 13, fontWeight: 700,
                    color: r.page === currentPage ? acc : tx, marginBottom: 4 }}>
                    Page {r.page}
                  </div>
                  {r.snippets.map((s, j) => (
                    <div key={j} dir="auto"
                      style={{ fontSize: 11, color: muted, lineHeight: 1.5 }}>
                      …{s.trim()}…
                    </div>
                  ))}
                </div>
              ))}
            </>
          )}

          {/* ── NOTES ── */}
          {activePanel === "notes" && (
            <>
              <div style={{ fontSize: 16, fontWeight: 800, color: tx, marginBottom: 6 }}>
                ✏️ Note for Page {currentPage}
              </div>
              <textarea value={noteInput} onChange={e => setNoteInput(e.target.value)}
                dir="auto" placeholder="Write your note here…"
                style={{ width: "100%", minHeight: 100, padding: 12,
                  borderRadius: 12, border: `2px solid ${border}`,
                  background: inputBg, color: tx, fontSize: 14,
                  fontFamily: "inherit", resize: "vertical",
                  boxSizing: "border-box", outline: "none", lineHeight: 1.6,
                  marginBottom: 10 }} />
              <div style={{ display: "flex", gap: 10 }}>
                <button onClick={saveNote} style={{ ...btn(acc), flex: 1 }}>
                  Save Note
                </button>
                {bookNotes[currentPage] && (
                  <button onClick={() => { setNoteInput("");
                    const u = { ...bookNotes }; delete u[currentPage];
                    setNotes(p => ({ ...p, [bookKey]: u }));
                    showToast("Note deleted"); }}
                    style={{ ...btn(acc, true), flex: 1 }}>
                    Delete Note
                  </button>
                )}
              </div>
              {/* All notes list */}
              {Object.keys(bookNotes).length > 0 && (
                <div style={{ marginTop: 16 }}>
                  <div style={{ fontSize: 12, color: muted, marginBottom: 8,
                    fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em" }}>
                    All Notes
                  </div>
                  {Object.entries(bookNotes).sort(([a], [b]) => Number(a) - Number(b)).map(([pg, note]) => (
                    <div key={pg} onClick={() => { goToPage(Number(pg)); setActivePanel(null); }}
                      style={{ padding: "10px 12px", borderRadius: 10, marginBottom: 6,
                        cursor: "pointer", background: Number(pg) === currentPage ? accLight : inputBg,
                        border: `1px solid ${Number(pg) === currentPage ? acc : border}` }}>
                      <div style={{ fontSize: 12, color: acc, fontWeight: 700 }}>
                        Page {pg}
                      </div>
                      <div dir="auto" style={{ fontSize: 12, color: muted, marginTop: 2,
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {note}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {/* ── TABLE OF CONTENTS ── */}
          {activePanel === "toc" && (
            <>
              <div style={{ fontSize: 16, fontWeight: 800, color: tx, marginBottom: 14 }}>
                📑 Table of Contents
              </div>
              {toc.length === 0 ? (
                <div style={{ textAlign: "center", color: muted, padding: "20px 0", fontSize: 14 }}>
                  This PDF has no table of contents.
                </div>
              ) : toc.map((item, i) => (
                <div key={i} dir="auto" onClick={() => navigateToc(item)}
                  style={{ padding: "10px 12px",
                    paddingLeft: 12 + item.depth * 16,
                    borderRadius: 10, cursor: "pointer", marginBottom: 4,
                    fontSize: item.depth === 0 ? 14 : 12,
                    fontWeight: item.depth === 0 ? 700 : 400,
                    color: item.depth === 0 ? acc : tx,
                    background: "transparent",
                    borderLeft: item.depth > 0 ? `2px solid ${border}` : "none",
                    transition: "background .15s" }}
                  onMouseEnter={e => e.currentTarget.style.background = accLight}
                  onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                  {item.title}
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {toast && <Toast msg={toast.msg} type={toast.type} acc={acc} surface={surface} tx={tx} border={border} />}
      <style>{globalCSS}</style>
    </div>
  );
}

// ── Shared components ─────────────────────────────────────────────────────────
function Toast({ msg, type, acc, surface, tx, border }) {
  return (
    <div style={{ position: "fixed", bottom: 130, left: "50%",
      transform: "translateX(-50%)",
      background: type === "success" ? acc : surface,
      color: type === "success" ? "#fff" : tx,
      padding: "10px 22px", borderRadius: 24, fontSize: 13,
      boxShadow: "0 4px 28px #0004", border: `1px solid ${border}`,
      zIndex: 500, whiteSpace: "nowrap",
      animation: "fadeUp .2s ease" }}>
      {msg}
    </div>
  );
}

const globalCSS = `
  @keyframes fadeUp {
    from { opacity:0; transform:translateX(-50%) translateY(10px) }
    to   { opacity:1; transform:translateX(-50%) translateY(0) }
  }
  @keyframes slideUp {
    from { transform:translateY(100%) }
    to   { transform:translateY(0) }
  }
  @keyframes fadeIn {
    from { opacity:0; transform:translateY(8px) }
    to   { opacity:1; transform:translateY(0) }
  }
  ::-webkit-scrollbar { width:4px; height:4px }
  ::-webkit-scrollbar-track { background:transparent }
  ::-webkit-scrollbar-thumb { background:#8885; border-radius:4px }
  input::-webkit-inner-spin-button { opacity:.5 }
  * { box-sizing:border-box }
  input:focus, textarea:focus { outline:none }
`;
