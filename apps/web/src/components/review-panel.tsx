"use client";

import { Check, Copy, ExternalLink, History, Link2, LoaderCircle, Pencil, ShieldCheck, Trash2, Users, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiRequest } from "@/lib/api";

type TokenGetter = () => Promise<string | null>;
type Share = {
  id: string;
  token: string;
  mode: "PUBLIC" | "PERMISSIONED";
  role: "VIEWER" | "EDITOR";
  email: string | null;
  scope: "ROOM" | "FOLDER" | "DOCUMENT";
  targetName: string;
  createdAt: string;
};
type AuditEvent = {
  id: string;
  action: string;
  actorId: string | null;
  targetName: string | null;
  createdAt: string;
};
type Overview = { room: { id: string; name: string }; shares: Share[]; audit: AuditEvent[] };

const actionCopy: Record<string, string> = {
  ROOM_CREATED: "Created the data room",
  ROOM_RENAMED: "Renamed the data room",
  FOLDER_CREATED: "Created a folder",
  FOLDER_RENAMED: "Renamed a folder",
  FOLDER_DELETED: "Deleted a folder tree",
  DOCUMENT_UPLOADED: "Uploaded a document",
  DOCUMENT_VIEWED: "Viewed a document",
  DOCUMENT_RENAMED: "Renamed a document",
  DOCUMENT_MOVED: "Moved a document",
  DOCUMENT_DELETED: "Deleted a document",
  SHARE_CREATED: "Created read-only access",
  SHARE_REVOKED: "Revoked access",
  SHARE_VIEWED: "Opened a shared view",
  DEMO_CREATED: "Loaded the review example",
};

const relativeTime = (value: string) => {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
};

export function ReviewPanel({
  roomId,
  getToken,
  onClose,
  onRoomChanged,
  onRoomDeleted,
}: {
  roomId: string;
  getToken: TokenGetter;
  onClose: () => void;
  onRoomChanged: () => Promise<void>;
  onRoomDeleted: () => Promise<void>;
}) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [tab, setTab] = useState<"access" | "activity" | "room">("access");
  const [roomName, setRoomName] = useState("");
  const [copiedId, setCopiedId] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const next = await apiRequest<Overview>(getToken, `/rooms/${roomId}/overview`);
      setOverview(next);
      setRoomName(next.room.name);
      setError("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not load room controls");
    }
  }, [getToken, roomId]);

  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load]);

  const participants = useMemo(() => {
    const emails = new Map<string, Share>();
    overview?.shares.filter((share) => share.email).forEach((share) => emails.set(share.email!, share));
    return [...emails.values()];
  }, [overview]);

  async function revoke(shareId: string) {
    await apiRequest(getToken, `/shares/${shareId}/revoke`, { method: "PATCH" });
    await load();
  }

  async function renameRoom() {
    if (!roomName.trim()) return;
    await apiRequest(getToken, `/rooms/${roomId}`, { method: "PATCH", body: JSON.stringify({ name: roomName.trim() }) });
    await Promise.all([load(), onRoomChanged()]);
  }

  async function deleteRoom() {
    if (!window.confirm(`Delete “${overview?.room.name}”, all nested folders, documents and access links? This cannot be undone.`)) return;
    await apiRequest(getToken, `/rooms/${roomId}`, { method: "DELETE" });
    await onRoomDeleted();
  }

  return <aside className="reviewPanel">
    <header><div><ShieldCheck /><span><strong>Review controls</strong><small>{overview?.room.name ?? "Loading room"}</small></span></div><button onClick={onClose} aria-label="Close review controls"><X /></button></header>
    <nav><button data-active={tab === "access"} onClick={() => setTab("access")}><Users /> Access</button><button data-active={tab === "activity"} onClick={() => setTab("activity")}><History /> Activity</button><button data-active={tab === "room"} onClick={() => setTab("room")}><Pencil /> Room</button></nav>
    {error && <p className="panelError">{error}</p>}
    {!overview ? <div className="panelLoading"><LoaderCircle className="spin" /> Loading controls</div> : <div className="reviewPanelBody">
      {tab === "access" && <>
        <section className="panelMetric"><span><strong>{overview.shares.length}</strong><small>active links</small></span><span><strong>{participants.length}</strong><small>invited reviewers</small></span></section>
        <section className="panelSection"><div className="panelSectionTitle"><p>Active access</p><small>Every link is read-only</small></div>{!overview.shares.length && <p className="panelEmpty">No external access. Use Share in the workspace to create a link.</p>}{overview.shares.map((share) => { const url = `${window.location.origin}/share/${share.token}`; return <article className="accessCard" key={share.id}><div className="accessCardTop"><i><Link2 /></i><span><strong>{share.targetName}</strong><small>{share.scope.toLowerCase()} · {share.mode === "PUBLIC" ? "anyone with link" : share.email}</small></span></div><footer><time>{relativeTime(share.createdAt)}</time><a href={url} target="_blank" aria-label="Open shared view"><ExternalLink /></a><button onClick={async () => { await navigator.clipboard.writeText(url); setCopiedId(share.id); }} aria-label="Copy link">{copiedId === share.id ? <Check /> : <Copy />}</button><button className="destructiveIcon" onClick={() => void revoke(share.id)} aria-label="Revoke access"><Trash2 /></button></footer></article>; })}</section>
        {!!participants.length && <section className="panelSection"><div className="panelSectionTitle"><p>Reviewers</p><small>Signed-in email access</small></div>{participants.map((share) => <article className="participantRow" key={share.email}><i>{share.email?.slice(0, 1).toUpperCase()}</i><span><strong>{share.email}</strong><small>Viewer · {share.targetName}</small></span></article>)}</section>}
      </>}
      {tab === "activity" && <section className="panelSection auditSection"><div className="panelSectionTitle"><p>Audit trail</p><small>Latest 50 events</small></div>{overview.audit.map((event) => <article className="auditRow" key={event.id}><i /><span><strong>{actionCopy[event.action] ?? event.action}</strong><small>{event.targetName ?? "Data room"}</small></span><time>{relativeTime(event.createdAt)}</time></article>)}</section>}
      {tab === "room" && <section className="panelSection roomControls"><div className="panelSectionTitle"><p>Room settings</p><small>Owner only</small></div><label>Data room name<input value={roomName} onChange={(event) => setRoomName(event.target.value)} /></label><button className="panelPrimary" onClick={() => void renameRoom()}>Save room name</button><div className="dangerZone"><strong>Delete data room</strong><p>Deletes every folder, PDF, access link and object from storage.</p><button onClick={() => void deleteRoom()}><Trash2 /> Delete permanently</button></div></section>}
    </div>}
  </aside>;
}
