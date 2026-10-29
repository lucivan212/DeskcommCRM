# Isolated media upgrade audit — 2026-10-29

Scope: local branch HEAD `43791387f`, compared with the eight paths in
`iaos-media-legacy.patch`. No remote refresh: “upstream” here means the code
already in this branch, not a claim about the current remote tip. The patch is
reference only, untouched and untracked; its historical deployment statements
are not evidence of validation of this upgrade.

## Comparison of all eight legacy paths

| Legacy path | Branch before this port | Decision |
| --- | --- | --- |
| `.changes/media-private-delivery.md` | Absent | Add a current release fragment. |
| `app/api/v1/messages/[id]/media/route.test.ts` | Upstream tests for signed redirects and original download names | Adapt to authenticated bytes; retain filename/fallback coverage; add PDF/JPEG, headers, failures, authentication and tenant-filter cases, plus real SDK with synthetic transport. |
| `app/api/v1/messages/[id]/media/route.ts` | Authenticated message lookup and explicit active-organization filter; validated private paths; still redirects persisted files to a signed Storage URL | Port server-side download, no-store/nosniff, safe inline types, forced download, UUID validation after authorization, and fail-closed Storage errors. Preserve upstream guards, adapter selection, retention and AAC conversion/rate limits. |
| `components/inbox/media/ImageMedia.tsx` | Thumbnail/lightbox and error placeholder; no retry or image download link | Add manual cache-busting retry and download using upstream `baixar=1`; preserve alternate note source. |
| `components/inbox/media/media-utils.ts` | Already has `mediaDownloadSrc` using `baixar=1` | Keep helpers; update comments for byte delivery. |
| `docs/iaos/media-20261019.md` | Absent | Do not import historical operational/deployment instructions; this document records the current audit. |
| `tests/unit/retencao-de-midia-aplicada-1534.test.ts` | Already protects 410 retention behavior and no provider recovery; uses a non-UUID fixture | Update fixture to valid UUID so retention assertions exercise the route after input validation. |
| `vitest.media.config.ts` | Absent; upstream has its own Vitest projects and setup | Do not import legacy environment-specific configuration; use existing suite and node environment annotations for byte/Blob route tests. |

## Findings and compatibility

- **Authenticated PDF/JPEG opening:** incomplete upstream for an internal Storage
  hostname. A 302 exposes the SDK origin to the browser. Persisted files now
  return bytes through the authenticated app route with no Location header.
- **Private paths:** upstream already blocks other-organization prefixes,
  traversal, percent escapes (including double encoding), backslashes, query/
  fragment delimiters, control characters, empty segments and trailing spaces.
  Its validator is preserved before both normal download and AAC conversion.
  The legacy conversation-only prefix is deliberately not ported: legitimate
  proposal PDFs also live at `{org}/{proposal}.pdf`.
- **Isolation:** the session client/RLS lookup and explicit organization filter,
  plus the admin Storage namespace guard, already exist and remain in place.
  Channel-session lookup is also filtered by organization. Unit tests simulate
  another tenant's message and a readable row pointing at another tenant's object;
  they do not prove live database RLS.
- **Download/retry:** original download names already exist upstream; the byte
  response reuses its RFC 5987 header helper. `baixar=1` forces attachment even
  without metadata, using the stored basename. No legacy `download=1` API is
  introduced. Image retry was absent and is added. Alternate note-media URLs
  remain alternate URLs; this port does not change that separate route.
- **Failure behavior:** a persisted object returning 404 yields 404; other SDK
  errors, missing data or thrown failures yield 502. None falls through to the
  channel adapter. Retained-media 410 and unpersisted-media adapter fallback
  remain. AAC size checks, per-user/per-org rate limits and busy handling remain.
- **Inline security:** PDF and listed raster/audio/video MIME types can open
  inline; HTML, SVG and unknown types force attachment. MIME comes from the
  downloaded object, with octet-stream fallback, and nosniff is set.

## Files changed beyond the legacy paths

- `tests/unit/inbox-media-image.test.tsx`: retry, loading recovery, download
  while failed, alternate source/query handling.
- `tests/unit/midia-da-mensagem-isolamento.test.ts`: retain the full unsafe-path
  matrix and legitimate proposal paths; expect download instead of signing.
- `tests/unit/midia-formato-aac.test.ts`: UUID fixtures and normal-delivery
  assertions; preserve conversion/rate-limit/error cases.
- This audit document.

## Validation and limits

`git diff --check` passed. Execution is blocked locally: `pnpm` is absent,
`node_modules` is absent, and available Node is v18.20.4 (project requires >=22).
No dependency installation or network access was attempted. Unit tests, lint,
typecheck, build and mutation/sabotage checks therefore have **not passed** or
run here. Browser PDF/JPEG opening, download behavior, retry visualization,
real cross-tenant RLS and integration with actual Storage remain unverified.
Database, Docker, production, credentials, networking and channel operations
were excluded by the task. No commit, push, deployment or external message.

When dependencies are available in an authorized isolated environment, the
targeted suite includes:

```bash
pnpm vitest run 'app/api/v1/messages/[id]/media/route.test.ts' tests/unit/inbox-media-image.test.tsx tests/unit/midia-da-mensagem-isolamento.test.ts tests/unit/midia-formato-aac.test.ts tests/unit/retencao-de-midia-aplicada-1534.test.ts tests/unit/media-upload-validation.test.ts tests/unit/inbox-media-docvideo.test.tsx tests/unit/inbox-documento-nome-original.test.tsx tests/unit/inbox-media-utils.test.ts
pnpm typecheck
pnpm lint
```

The SDK materializes a Blob before `file.stream()`: this is not end-to-end
streaming and large files consume server memory. This port does not implement
HTTP Range forwarding; large-video seeking and large-file behavior need
integration validation. It introduces no schema, configuration or deployment
change.

## Living System Checklist

1. Input: authorized `messages` row and private Storage object.
2. Output: existing `ImageMedia` / `DocumentCard` in Inbox.
3. Record: HTTP status and X-Request-Id; read-only, no audit mutation.
4. Visible feedback: `MediaUnavailable`, image loading state and retry action.
5. Entry: existing Inbox conversation, no new navigation destination.
6. Recovery: explicit retry requests fresh bytes; retained-media 410 stays terminal.
7. Configuration: none added; existing authorization and Storage configuration.
8. AI/human continuity: unchanged message/history access; no agent/send operation.
9. Return loop: image onError exposes retry; onLoad enables enlargement. No
   automated business decision or learning loop is introduced.
10. Architecture map: no new component/service node; existing message → media
    route → Inbox path retained.

Destination: core bug fix. Opening existing attachments is ordinary CRM
operation and must work without activating an extension.
