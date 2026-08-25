# Vaultroom

Vaultroom is a full-stack data-room MVP for confidential due diligence. Authenticated owners create rooms, organise nested folders, upload and preview PDFs, resolve duplicate names, move or delete documents, and create revocable read-only shares.

- Live web: <https://vaultroom-ruby.vercel.app>
- API service: <https://vaultroom-api-production.up.railway.app>
- API health: <https://vaultroom-api-production.up.railway.app/health>

## Live architecture

- `apps/web`: Next.js 16, React 19, Clerk, TypeScript
- `apps/api`: NestJS 11, Prisma 7, PostgreSQL, Clerk token verification
- Object storage: S3-compatible bucket (Railway in production)
- Monorepo: pnpm workspaces

The browser talks directly to the Nest API with a short-lived Clerk session token. The API is the sole authority for ownership, hierarchy and share scope. File bytes never enter PostgreSQL: the database stores metadata and an opaque object key, while S3-compatible storage holds the PDF.

## Product scope

- Multiple data rooms per authenticated owner
- Arbitrarily nested folders with breadcrumbs
- Folder create, rename and cascade delete
- Multi-file PDF upload via drag/drop or picker, with per-file progress
- Inline PDF preview
- Conflict-safe naming (`report.pdf`, `report (1).pdf`, ...)
- Document rename, move to any folder/root and delete
- Drag a PDF onto a folder or root breadcrumb to move it
- Public or email-restricted, read-only links for a room, folder or individual PDF
- Review controls with active links, invited reviewers and immediate revocation
- Owner-only room rename and permanent room deletion
- Audit trail for uploads, views, moves, deletes and access changes
- One-click demo room with three generated PDFs for a fast product walkthrough
- Revocable shares; shared document endpoints re-check scope on every request
- Responsive, keyboard-friendly interface with reduced-motion support

## Entity relationship diagram

```mermaid
erDiagram
  DATA_ROOM ||--o{ FOLDER : contains
  DATA_ROOM ||--o{ DOCUMENT : contains
  DATA_ROOM ||--o{ SHARE : exposes
  FOLDER ||--o{ FOLDER : parent_of
  FOLDER ||--o{ DOCUMENT : contains
  FOLDER ||--o{ SHARE : exposes
  DOCUMENT ||--o{ SHARE : exposes

  DATA_ROOM {
    string id PK
    string ownerId
    string name
    datetime updatedAt
  }
  FOLDER {
    string id PK
    string dataRoomId FK
    string parentId FK
    string parentKey
    string name
  }
  DOCUMENT {
    string id PK
    string dataRoomId FK
    string folderId FK
    string parentKey
    string storageKey
    bigint size
    int version
  }
  SHARE {
    string id PK
    string token UK
    enum mode
    enum role
    string email
    datetime revokedAt
  }
```

`parentKey` deliberately converts a nullable root into the sentinel `root`. PostgreSQL unique constraints can therefore enforce sibling name uniqueness at the room root as well as within folders.

## Local setup

Requirements: Node 22+, pnpm 11, PostgreSQL, an S3-compatible bucket and a Clerk application.

```bash
pnpm install
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
pnpm --filter api exec prisma generate
pnpm --filter api db:push
pnpm dev
```

The web app uses `http://localhost:3000`; the API uses `http://localhost:4000`. Populate all values documented in the two example environment files. `AUTH_BYPASS_USER_ID` is a local-only convenience and is ignored when `NODE_ENV=production`.

## Commands

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm --filter api exec prisma format
pnpm --filter api db:push
```

## API summary

Authenticated owner endpoints:

- `GET/POST /rooms`
- `POST /rooms/demo`, `PATCH/DELETE /rooms/:roomId`
- `GET /rooms/:roomId/overview`
- `GET /rooms/:roomId/contents?folderId=`
- `POST /rooms/:roomId/folders`
- `PATCH/DELETE /folders/:folderId`
- `POST /rooms/:roomId/documents?folderId=`
- `PATCH/DELETE /documents/:documentId`
- `GET /documents/:documentId/content`
- `POST /shares`, `PATCH /shares/:shareId/revoke`

Viewer endpoints use the unguessable share token and are always read-only:

- `GET /shared/:token`
- `GET /shared/:token/documents/:documentId`

Permissioned links additionally validate the signed-in Clerk user's email against the invitation. A room/folder share does not make arbitrary object keys accessible: the requested document must still be a descendant of the shared target.

## Design decisions and trade-offs

1. **Adjacency list for folders.** It is simple, transactional and easy to mutate. Breadcrumbs walk parents, and destructive deletion uses database cascades after object keys are collected. At very deep or read-heavy scale I would add a materialised path or PostgreSQL `ltree` alongside it.
2. **Object storage outside the database.** This keeps backups and queries small, supports CDN/range delivery later and avoids holding large blobs in database connections.
3. **API-mediated downloads.** The MVP streams through Nest so every read has one obvious authorization boundary. At scale the API would issue short-lived signed URLs after the same authorization check.
4. **Conflict resolution on the server.** Every client gets identical semantics. The composite unique constraints remain the final race-condition guard; production retry logic should catch a unique violation and allocate the next suffix.
5. **Read-only shares only.** The schema has a role for future evolution, but the current API never accepts viewer writes.

## Scaling to millions of files

### How do you compute a folder's recursive size and item count?

For the current MVP, use a PostgreSQL recursive CTE starting at the requested folder, collect every descendant folder id, then aggregate `COUNT(*)` and `SUM(size)` from `Document` where `folderId` is in that set. The same query must run behind the owner/share scope check; an empty subtree returns zero for both values.

At sustained scale, that read becomes too expensive to repeat. I would store denormalised direct and recursive counters per folder and update them asynchronously from an idempotent outbox event on upload, move and delete. The database remains the source of truth, so a scheduled reconciliation can detect and repair drift.

### What changes at 100,000 files in one Data Room?

- Replace offset-style listing with indexed cursor pagination on `(folderId, name, id)`.
- Never load the whole tree for a picker: fetch children on demand and search through a dedicated indexed endpoint.
- Upload directly to multipart object storage with presigned URLs; finalise metadata asynchronously after checksum and malware scanning.
- Serve PDF ranges through a CDN using short-lived signed URLs.
- Store denormalised aggregate counts and process them with an outbox/queue rather than counting descendants during reads.
- Add `ltree`/materialised paths for one-query subtree checks, while retaining the adjacency relation as the canonical mutation model.
- Keep the existing sibling uniqueness constraint and add covering indexes for the actual list/sort paths, for example `(dataRoomId, parentKey, name, id)`.
- Partition document and audit-event tables by tenant/room hash, use read replicas for listing and isolate search in OpenSearch.
- Add immutable audit events for view/download/share/revoke, tenant quotas, retention policies and KMS-backed per-tenant encryption keys.
- Make deletion a durable job: mark tombstones transactionally, remove objects idempotently, then purge metadata after retention.

### How does sharing extend to viewer/editor roles without remodeling?

`Share` already stores `role`, `granteeUserId`, `email` and exactly one room/folder/document scope. Adding editor access therefore does not require a new relationship model. I would introduce an authorization policy that resolves the effective grant for the signed-in user and requested resource, then maps `VIEWER` to read actions and `EDITOR` to read plus create/rename/move/delete actions inside that scope. Public links remain viewer-only. The current MVP intentionally exposes only read-only shares because that is the assignment's functional requirement.

## What I would add next

- Download analytics and exportable audit reports
- Direct multipart uploads, checksums and virus scanning
- Playwright end-to-end tests against disposable Postgres and MinIO
- Optimistic locking for concurrent rename/move operations

## Product direction beyond the assignment

I would evolve this into a zero-knowledge deal vault rather than a general password-manager clone. The browser would encrypt each file before upload, the server would store only ciphertext, and identified reviewers would receive wrapped room or file keys. That creates useful protection against a compromised database, bucket or curious infrastructure operator while preserving the data-room workflow already built here.

I would not start by adding cryptography to the current upload handler. The next artifact should be a written threat model covering recovery, device enrollment, metadata leakage, revocation limits and organisation-admin access. Only then would I implement an isolated client-side crypto package using audited primitives and test vectors, followed by an external security review.

## AI usage

AI was used as an implementation partner for initial scaffolding, API/UI drafting and review. Every generated change was inspected, compiled and covered by local type checks/tests. Architecture, security boundaries, data modelling, design direction and trade-offs were decided explicitly for this assignment rather than copied from a generic template.
