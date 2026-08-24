"use client";

import { useAuth, UserButton } from "@clerk/nextjs";
import { ArrowLeft, Check, ChevronRight, Copy, Eye, FileText, Folder, FolderInput, FolderPlus, Globe2, History, Link2, LoaderCircle, LockKeyhole, MoreHorizontal, Pencil, Search, Share2, ShieldCheck, Trash2, Upload, X } from "lucide-react";
import { DragEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_URL, apiRequest } from "@/lib/api";
import { ReviewPanel } from "@/components/review-panel";

type Room = { id: string; name: string; updatedAt: string; _count?: { folders: number; documents: number } };
type FolderItem = { id: string; name: string; updatedAt: string; _count: { children: number; documents: number } };
type DocumentItem = { id: string; name: string; mimeType: string; size: number; updatedAt: string };
type Contents = { room: Room; folderId: string | null; breadcrumbs: Array<{ id: string; name: string }>; folders: FolderItem[]; documents: DocumentItem[] };
type UploadState = { name: string; progress: number; state: "uploading" | "done" | "error" };
type FolderOption = { id: string; parentId: string | null; name: string };
type SelectedAsset = { kind: "folder" | "document"; id: string; name: string };

const formatBytes = (value: number) => value < 1024 * 1024 ? `${Math.max(1, Math.round(value / 1024))} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`;
const formatDate = (value: string) => new Intl.DateTimeFormat("en", { month: "short", day: "2-digit", year: "numeric" }).format(new Date(value));

export function DataRoomApp() {
  const { getToken } = useAuth();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [contents, setContents] = useState<Contents | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [newRoomName, setNewRoomName] = useState("");
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [dragging, setDragging] = useState(false);
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [preview, setPreview] = useState<{ name: string; url: string } | null>(null);
  const [selectedAsset, setSelectedAsset] = useState<SelectedAsset | null>(null);
  const [assetName, setAssetName] = useState("");
  const [folderOptions, setFolderOptions] = useState<FolderOption[]>([]);
  const [targetFolderId, setTargetFolderId] = useState("");
  const [shareTarget, setShareTarget] = useState<{ scope: "ROOM" | "FOLDER" | "DOCUMENT"; id: string; name: string } | null>(null);
  const [shareMode, setShareMode] = useState<"PUBLIC" | "PERMISSIONED">("PUBLIC");
  const [shareEmail, setShareEmail] = useState("");
  const [shareLink, setShareLink] = useState("");
  const [shareId, setShareId] = useState("");
  const [copied, setCopied] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [demoLoading, setDemoLoading] = useState(false);
  const [draggedDocument, setDraggedDocument] = useState<{ id: string; name: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadRooms = useCallback(async () => {
    try {
      const nextRooms = await apiRequest<Room[]>(getToken, "/rooms");
      setRooms(nextRooms);
      setActiveRoomId((current) => current && nextRooms.some((room) => room.id === current) ? current : nextRooms[0]?.id ?? null);
      setError("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not load data rooms");
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  const loadContents = useCallback(async (roomId: string, folderId?: string | null) => {
    setLoading(true);
    try {
      const suffix = folderId ? `?folderId=${encodeURIComponent(folderId)}` : "";
      setContents(await apiRequest<Contents>(getToken, `/rooms/${roomId}/contents${suffix}`));
      setError("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not load this folder");
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => {
    const task = window.setTimeout(() => void loadRooms(), 0);
    return () => window.clearTimeout(task);
  }, [loadRooms]);
  useEffect(() => {
    if (!activeRoomId) return;
    const task = window.setTimeout(() => void loadContents(activeRoomId), 0);
    return () => window.clearTimeout(task);
  }, [activeRoomId, loadContents]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);

  const needle = query.toLowerCase();
  const visibleFolders = useMemo(() => contents?.folders.filter((item) => item.name.toLowerCase().includes(needle)) ?? [], [contents, needle]);
  const visibleDocuments = useMemo(() => contents?.documents.filter((item) => item.name.toLowerCase().includes(needle)) ?? [], [contents, needle]);
  const currentRoom = rooms.find((room) => room.id === activeRoomId) ?? null;

  async function createRoom(event: FormEvent) {
    event.preventDefault();
    if (!newRoomName.trim()) return;
    const room = await apiRequest<Room>(getToken, "/rooms", { method: "POST", body: JSON.stringify({ name: newRoomName.trim() }) });
    setRooms((current) => [room, ...current]);
    setActiveRoomId(room.id);
    setNewRoomName("");
  }

  async function createDemoRoom() {
    setDemoLoading(true);
    try {
      const room = await apiRequest<Room>(getToken, "/rooms/demo", { method: "POST" });
      await loadRooms();
      setActiveRoomId(room.id);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not create the example room");
    } finally {
      setDemoLoading(false);
    }
  }

  async function createFolder(event: FormEvent) {
    event.preventDefault();
    if (!activeRoomId || !folderName.trim()) return;
    await apiRequest(getToken, `/rooms/${activeRoomId}/folders`, { method: "POST", body: JSON.stringify({ name: folderName.trim(), parentId: contents?.folderId ?? undefined }) });
    setFolderDialogOpen(false);
    setFolderName("");
    await loadContents(activeRoomId, contents?.folderId);
  }

  async function uploadFiles(files: File[]) {
    if (!activeRoomId) return;
    const pdfs = files.filter((file) => file.type === "application/pdf");
    setUploads(pdfs.map((file) => ({ name: file.name, progress: 0, state: "uploading" })));
    const token = await getToken();
    await Promise.all(pdfs.map((file, index) => new Promise<void>((resolve) => {
      const form = new FormData();
      form.append("file", file);
      const folderQuery = contents?.folderId ? `?folderId=${encodeURIComponent(contents.folderId)}` : "";
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${API_URL}/rooms/${activeRoomId}/documents${folderQuery}`);
      if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      xhr.upload.onprogress = (event) => event.lengthComputable && setUploads((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, progress: Math.round((event.loaded / event.total) * 100) } : item));
      xhr.onload = () => { setUploads((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, progress: 100, state: xhr.status < 400 ? "done" : "error" } : item)); resolve(); };
      xhr.onerror = () => { setUploads((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, state: "error" } : item)); resolve(); };
      xhr.send(form);
    })));
    await loadContents(activeRoomId, contents?.folderId);
    window.setTimeout(() => setUploads([]), 1800);
  }

  async function openDocument(document: DocumentItem) {
    const token = await getToken();
    const response = await fetch(`${API_URL}/documents/${document.id}/content`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
    if (!response.ok) return setError("Could not open the document");
    if (preview) URL.revokeObjectURL(preview.url);
    setPreview({ name: document.name, url: URL.createObjectURL(await response.blob()) });
  }

  async function openAssetActions(asset: SelectedAsset) {
    setSelectedAsset(asset);
    setAssetName(asset.name);
    setTargetFolderId("");
    if (asset.kind === "document" && activeRoomId) {
      setFolderOptions(await apiRequest<FolderOption[]>(getToken, `/rooms/${activeRoomId}/folders`));
    }
  }

  async function renameAsset() {
    if (!selectedAsset || !assetName.trim() || !activeRoomId) return;
    await apiRequest(getToken, `/${selectedAsset.kind === "folder" ? "folders" : "documents"}/${selectedAsset.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: assetName.trim() }),
    });
    setSelectedAsset(null);
    await loadContents(activeRoomId, contents?.folderId);
  }

  async function moveDocument() {
    if (!selectedAsset || selectedAsset.kind !== "document" || !activeRoomId) return;
    await apiRequest(getToken, `/documents/${selectedAsset.id}`, {
      method: "PATCH",
      body: JSON.stringify({ folderId: targetFolderId || null }),
    });
    setSelectedAsset(null);
    await loadContents(activeRoomId, contents?.folderId);
  }

  async function moveDroppedDocument(folderId: string | null) {
    if (!draggedDocument || !activeRoomId) return;
    await apiRequest(getToken, `/documents/${draggedDocument.id}`, {
      method: "PATCH",
      body: JSON.stringify({ folderId }),
    });
    setDraggedDocument(null);
    await loadContents(activeRoomId, contents?.folderId);
  }

  async function deleteAsset() {
    if (!selectedAsset || !activeRoomId) return;
    const warning = selectedAsset.kind === "folder"
      ? `Delete “${selectedAsset.name}” and every nested file and folder? This cannot be undone.`
      : `Delete “${selectedAsset.name}”? This cannot be undone.`;
    if (!window.confirm(warning)) return;
    await apiRequest(getToken, `/${selectedAsset.kind === "folder" ? "folders" : "documents"}/${selectedAsset.id}`, { method: "DELETE" });
    setSelectedAsset(null);
    await loadContents(activeRoomId, contents?.folderId);
  }

  function beginShare(target?: SelectedAsset) {
    if (!activeRoomId) return;
    const next = target
      ? { scope: target.kind === "folder" ? "FOLDER" as const : "DOCUMENT" as const, id: target.id, name: target.name }
      : contents?.folderId
        ? { scope: "FOLDER" as const, id: contents.folderId, name: contents.breadcrumbs.at(-1)?.name ?? "Folder" }
        : { scope: "ROOM" as const, id: activeRoomId, name: currentRoom?.name ?? "Data room" };
    setSelectedAsset(null);
    setShareTarget(next);
    setShareLink("");
    setShareId("");
    setShareMode("PUBLIC");
    setShareEmail("");
  }

  async function createShare(event: FormEvent) {
    event.preventDefault();
    if (!shareTarget) return;
    const share = await apiRequest<{ id: string; token: string }>(getToken, "/shares", {
      method: "POST",
      body: JSON.stringify({ scope: shareTarget.scope, targetId: shareTarget.id, mode: shareMode, email: shareMode === "PERMISSIONED" ? shareEmail : undefined }),
    });
    setShareId(share.id);
    setShareLink(`${window.location.origin}/share/${share.token}`);
  }

  async function revokeCurrentShare() {
    if (!shareId) return;
    await apiRequest(getToken, `/shares/${shareId}/revoke`, { method: "PATCH" });
    setShareLink("");
    setShareId("");
    setShareTarget(null);
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length) void uploadFiles(Array.from(event.dataTransfer.files));
  }

  if (loading && !rooms.length) return <div className="loadingScreen"><LoaderCircle className="spin" /><span>Opening secure workspace</span></div>;

  if (!rooms.length) return (
    <main className="emptyWorkspace">
      <div className="emptyBrand"><ShieldCheck /><span>VAULTROOM / 01</span></div>
      <section><p className="eyebrow">PRIVATE DUE DILIGENCE</p><h1>Create the room<br />before the deal.</h1><p>One secure workspace for every document, reviewer and decision.</p><form onSubmit={createRoom}><input value={newRoomName} onChange={(event) => setNewRoomName(event.target.value)} placeholder="Acme acquisition" autoFocus /><button>Create data room <ChevronRight /></button></form><button className="demoRoomButton" onClick={() => void createDemoRoom()} disabled={demoLoading}>{demoLoading ? <LoaderCircle className="spin" /> : <Eye />} Explore a prepared review room</button>{error && <small>{error}</small>}</section>
    </main>
  );

  return (
    <main className="vaultShell">
      <aside className="vaultRail">
        <div className="vaultBrand"><ShieldCheck /><span>VAULTROOM</span></div><p className="railLabel">Data rooms</p>
        <nav>{rooms.map((room, index) => <button key={room.id} data-active={room.id === activeRoomId} onClick={() => setActiveRoomId(room.id)}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{room.name}</strong><small>{room._count?.documents ?? 0} documents</small></div></button>)}</nav>
        <div className="railIdentity"><UserButton /><div><strong>Room owner</strong><small>Authenticated</small></div></div>
      </aside>

      <section className="vaultWorkspace" onDragEnter={(event) => { if (Array.from(event.dataTransfer.types).includes("Files")) setDragging(true); }}>
        <header className="vaultTopbar"><div className="breadcrumbs"><button onClick={() => activeRoomId && void loadContents(activeRoomId)} onDragOver={(event) => draggedDocument && event.preventDefault()} onDrop={(event) => { event.preventDefault(); void moveDroppedDocument(null); }}>{currentRoom?.name}</button>{contents?.breadcrumbs.map((crumb) => <span key={crumb.id}><ChevronRight /><button onClick={() => activeRoomId && void loadContents(activeRoomId, crumb.id)}>{crumb.name}</button></span>)}</div><div className="topbarActions"><label className="searchBox"><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search this folder" /></label><button className="quietButton" onClick={() => setReviewOpen(true)}><History /> Review</button><button className="quietButton" onClick={() => beginShare()}><Share2 /> Share</button></div></header>
        <div className="workspaceHeading"><div><p className="eyebrow">CONFIDENTIAL / OWNER ACCESS</p><h1>{contents?.breadcrumbs.at(-1)?.name ?? currentRoom?.name}</h1></div><div className="workspaceActions"><button className="quietButton" onClick={() => setFolderDialogOpen(true)}><FolderPlus /> New folder</button><button className="primaryButton" onClick={() => fileInputRef.current?.click()}><Upload /> Upload PDF</button><input ref={fileInputRef} type="file" accept="application/pdf" multiple hidden onChange={(event) => void uploadFiles(Array.from(event.target.files ?? []))} /></div></div>
        {contents?.folderId && <button className="backButton" onClick={() => { const parent = contents.breadcrumbs.at(-2)?.id; if (activeRoomId) void loadContents(activeRoomId, parent); }}><ArrowLeft /> Parent folder</button>}
        {error && <p className="errorBanner">{error}</p>}
        <section className="assetTable"><header><span>Name</span><span>Kind</span><span>Modified</span><span>Size</span><span /></header>
          {visibleFolders.map((folder) => <div className="assetRow folderDropTarget" key={folder.id} role="button" tabIndex={0} onClick={() => activeRoomId && void loadContents(activeRoomId, folder.id)} onKeyDown={(event) => { if (event.key === "Enter" && activeRoomId) void loadContents(activeRoomId, folder.id); }} onDragOver={(event) => { if (draggedDocument) event.preventDefault(); }} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); void moveDroppedDocument(folder.id); }}><span className="assetName"><i className="folderIcon"><Folder /></i><strong>{folder.name}</strong></span><span>Folder · {folder._count.children + folder._count.documents} items</span><span>{formatDate(folder.updatedAt)}</span><span>—</span><span className="assetActions"><button onClick={(event) => { event.stopPropagation(); beginShare({ kind: "folder", id: folder.id, name: folder.name }); }} aria-label={`Share ${folder.name}`}><Share2 /></button><button onClick={(event) => { event.stopPropagation(); void openAssetActions({ kind: "folder", id: folder.id, name: folder.name }); }} aria-label={`Actions for ${folder.name}`}><MoreHorizontal /></button></span></div>)}
          {visibleDocuments.map((document) => <div className="assetRow documentRow" key={document.id} role="button" tabIndex={0} draggable onDragStart={(event) => { setDraggedDocument({ id: document.id, name: document.name }); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-vaultroom-document", document.id); }} onDragEnd={() => setDraggedDocument(null)} onClick={() => void openDocument(document)} onKeyDown={(event) => { if (event.key === "Enter") void openDocument(document); }}><span className="assetName"><i className="pdfIcon"><FileText /></i><strong>{document.name}</strong></span><span>PDF document</span><span>{formatDate(document.updatedAt)}</span><span>{formatBytes(document.size)}</span><span className="assetActions"><button onClick={(event) => { event.stopPropagation(); void openDocument(document); }} aria-label={`Preview ${document.name}`}><Eye /></button><button onClick={(event) => { event.stopPropagation(); beginShare({ kind: "document", id: document.id, name: document.name }); }} aria-label={`Share ${document.name}`}><Share2 /></button><button onClick={(event) => { event.stopPropagation(); void openAssetActions({ kind: "document", id: document.id, name: document.name }); }} aria-label={`Actions for ${document.name}`}><MoreHorizontal /></button></span></div>)}
          {!visibleFolders.length && !visibleDocuments.length && <div className="folderEmpty"><FileText /><strong>This folder is empty</strong><p>Drop PDF files here or create a folder to organise the review.</p></div>}
        </section>
        {dragging && <div className="dropOverlay" onDragOver={(event) => event.preventDefault()} onDragLeave={() => setDragging(false)} onDrop={onDrop}><Upload /><strong>Drop PDFs into this folder</strong><span>Up to 25 MB per file</span></div>}
        {!!uploads.length && <div className="uploadStack">{uploads.map((upload) => <article key={upload.name}><div><FileText /><span><strong>{upload.name}</strong><small>{upload.state === "error" ? "Upload failed" : upload.state === "done" ? "Stored securely" : `${upload.progress}% uploaded`}</small></span></div><i><b style={{ width: `${upload.progress}%` }} /></i></article>)}</div>}
      </section>
      {folderDialogOpen && <div className="modalBackdrop" onMouseDown={() => setFolderDialogOpen(false)}><form className="vaultModal" onMouseDown={(event) => event.stopPropagation()} onSubmit={createFolder}><button type="button" className="modalClose" onClick={() => setFolderDialogOpen(false)}><X /></button><p className="eyebrow">NEW CONTAINER</p><h2>Create folder</h2><label>Folder name<input value={folderName} onChange={(event) => setFolderName(event.target.value)} autoFocus placeholder="Financial statements" /></label><div><button type="button" className="quietButton" onClick={() => setFolderDialogOpen(false)}>Cancel</button><button className="primaryButton">Create folder</button></div></form></div>}
      {selectedAsset && <div className="modalBackdrop" onMouseDown={() => setSelectedAsset(null)}><section className="vaultModal assetModal" onMouseDown={(event) => event.stopPropagation()}><button type="button" className="modalClose" onClick={() => setSelectedAsset(null)}><X /></button><p className="eyebrow">{selectedAsset.kind.toUpperCase()} ACTIONS</p><h2>{selectedAsset.name}</h2><label>Rename<input value={assetName} onChange={(event) => setAssetName(event.target.value)} /></label><button className="actionLine" onClick={() => void renameAsset()}><Pencil /> Save new name</button>{selectedAsset.kind === "document" && <><label>Move to<select value={targetFolderId} onChange={(event) => setTargetFolderId(event.target.value)}><option value="">Data room root</option>{folderOptions.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label><button className="actionLine" onClick={() => void moveDocument()}><FolderInput /> Move document</button></>}<button className="actionLine" onClick={() => beginShare(selectedAsset)}><Share2 /> Share {selectedAsset.kind}</button><button className="actionLine dangerAction" onClick={() => void deleteAsset()}><Trash2 /> Delete {selectedAsset.kind}</button></section></div>}
      {shareTarget && <div className="modalBackdrop" onMouseDown={() => setShareTarget(null)}><form className="vaultModal shareModal" onMouseDown={(event) => event.stopPropagation()} onSubmit={createShare}><button type="button" className="modalClose" onClick={() => setShareTarget(null)}><X /></button><p className="eyebrow">READ-ONLY ACCESS</p><h2>Share {shareTarget.name}</h2>{!shareLink ? <><div className="shareModes"><button type="button" data-active={shareMode === "PUBLIC"} onClick={() => setShareMode("PUBLIC")}><Globe2 /><span><strong>Public link</strong><small>Anyone with the link can view</small></span></button><button type="button" data-active={shareMode === "PERMISSIONED"} onClick={() => setShareMode("PERMISSIONED")}><LockKeyhole /><span><strong>Invited person</strong><small>Clerk sign-in and matching email required</small></span></button></div>{shareMode === "PERMISSIONED" && <label>Recipient email<input type="email" required value={shareEmail} onChange={(event) => setShareEmail(event.target.value)} placeholder="reviewer@company.com" /></label>}<div><button type="button" className="quietButton" onClick={() => setShareTarget(null)}>Cancel</button><button className="primaryButton"><Link2 /> Create link</button></div></> : <div className="shareResult"><Check /><strong>Read-only link created</strong><p>The link is active now and never grants edit access.</p><button type="button" onClick={async () => { await navigator.clipboard.writeText(shareLink); setCopied(true); }}>{copied ? <Check /> : <Copy />}{copied ? "Copied" : "Copy link"}</button><a href={shareLink} target="_blank">Open shared view</a><button type="button" className="revokeLink" onClick={() => void revokeCurrentShare()}><Trash2 /> Revoke access</button></div>}</form></div>}
      {preview && <div className="previewPanel"><header><div><FileText /><strong>{preview.name}</strong></div><button onClick={() => setPreview(null)}><X /></button></header><iframe title={preview.name} src={preview.url} /></div>}
      {reviewOpen && activeRoomId && <ReviewPanel roomId={activeRoomId} getToken={getToken} onClose={() => setReviewOpen(false)} onRoomChanged={async () => { await loadRooms(); await loadContents(activeRoomId, contents?.folderId); }} onRoomDeleted={async () => { setReviewOpen(false); setContents(null); await loadRooms(); }} />}
    </main>
  );
}
