# QA record

## Automated checks

Run from the repository root:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

The API suite covers name sanitisation, invalid uploads, room rename, room object cleanup, permissioned-share validation, folder cascade deletion and share ownership. The web package runs a strict TypeScript check in the test step. Both applications also build from a clean production command.

## Production smoke test

Checked against <https://vaultroom-ruby.vercel.app> and the Railway API:

- web document returns HTTP 200;
- API health route returns HTTP 200;
- owner routes without a Clerk token return HTTP 401;
- an unknown share hits PostgreSQL and returns the expected HTTP 404 response;
- Railway reports a successful deployment after `prisma db push`;
- Playwright loads the production page with the expected title and no console errors.

## Authenticated acceptance path

1. Sign in and create a blank room or load the prepared Northstar room.
2. Open each folder and preview a generated PDF.
3. Drag a PDF onto another folder, then drag it onto the room breadcrumb.
4. Rename the PDF and verify the audit event in Review → Activity.
5. Create a public room link, open it in a private browser and navigate into a nested folder.
6. Create an email-restricted folder link and verify that another email cannot open it.
7. Revoke both links in Review → Access and verify that they return 404.
8. Rename the room in Review → Room.
9. Delete a disposable room and verify that it disappears from the rail.

The production browser currently uses development Clerk keys. Replace them after completing `clerk deploy` for the dedicated Vaultroom application. The CLI-created app id is `app_3IMi6bNajA2G0YxJyQ1P86wDgOO`.
