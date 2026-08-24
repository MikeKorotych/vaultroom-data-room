"use client";

import { SignInButton, useAuth } from "@clerk/nextjs";
import { FileText, Folder, LoaderCircle, LockKeyhole, ShieldCheck, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { API_URL } from "@/lib/api";

type SharedData = {
  share: { mode: "PUBLIC" | "PERMISSIONED"; scope: "ROOM" | "FOLDER" | "DOCUMENT" };
  room: { name: string };
  document?: { id: string; name: string; size: number };
  folders?: Array<{ id: string; name: string; _count: { children: number; documents: number } }>;
  documents?: Array<{ id: string; name: string; size: number }>;
};

export function SharedRoomView({ token }: { token: string }) {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const [data, setData] = useState<SharedData | null>(null);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{ name: string; url: string } | null>(null);

  const load = useCallback(async () => {
    if (!isLoaded) return;
    const sessionToken = await getToken();
    const response = await fetch(`${API_URL}/shared/${token}`, { headers: sessionToken ? { Authorization: `Bearer ${sessionToken}` } : undefined });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { message?: string } | null;
      setError(payload?.message ?? "This share is unavailable");
      return;
    }
    setData(await response.json() as SharedData);
    setError("");
  }, [getToken, isLoaded, token]);

  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);

  async function openDocument(document: { id: string; name: string }) {
    const sessionToken = await getToken();
    const response = await fetch(`${API_URL}/shared/${token}/documents/${document.id}`, { headers: sessionToken ? { Authorization: `Bearer ${sessionToken}` } : undefined });
    if (!response.ok) return setError("The document could not be opened");
    if (preview) URL.revokeObjectURL(preview.url);
    setPreview({ name: document.name, url: URL.createObjectURL(await response.blob()) });
  }

  if (!data && !error) return <main className="sharedLoading"><LoaderCircle className="spin" /> Verifying read-only access</main>;
  if (!data) return <main className="sharedDenied"><LockKeyhole /><p className="eyebrow">RESTRICTED SHARE</p><h1>Access required.</h1><p>{error}</p>{!isSignedIn && <SignInButton mode="modal"><button>Sign in to continue</button></SignInButton>}</main>;

  const documents = data.document ? [data.document] : data.documents ?? [];
  return <main className="sharedPage"><header><div><ShieldCheck /><span>VAULTROOM / SHARED</span></div><p>READ ONLY · {data.share.mode}</p></header><section className="sharedHero"><p className="eyebrow">CONFIDENTIAL DOCUMENT REVIEW</p><h1>{data.room.name}</h1><p>This view cannot upload, rename, move or delete content.</p></section><section className="sharedAssets">{data.folders?.map((folder) => <article key={folder.id}><i><Folder /></i><span><strong>{folder.name}</strong><small>{folder._count.children + folder._count.documents} items</small></span></article>)}{documents.map((document) => <button key={document.id} onClick={() => void openDocument(document)}><i><FileText /></i><span><strong>{document.name}</strong><small>PDF · {(document.size / 1024 / 1024).toFixed(1)} MB</small></span></button>)}</section>{preview && <div className="previewPanel sharedPreview"><header><div><FileText /><strong>{preview.name}</strong></div><button onClick={() => setPreview(null)}><X /></button></header><iframe title={preview.name} src={preview.url} /></div>}</main>;
}
