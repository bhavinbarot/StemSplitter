# Stem Splitter API v1

This app now exposes stable backend endpoints under `/api/v1` so web and mobile clients can use the same API.

## Auth

- `GET /api/v1/auth/session`
  - Returns current auth state and current user.

If `REQUIRE_GOOGLE_LOGIN=true`, unauthenticated API calls return `401` JSON.

## Jobs

- `POST /api/v1/jobs`
  - Multipart form, same fields as existing web form:
    - `audio_file` (file upload) OR `source_url` (video URL)
    - `separation_mode` (`full` or `vocals`)
    - `output_format` (`mp3` or `wav`)
    - `quality_level` (`0-100`)
  - Returns:
    - `{ "ok": true, "job_id": "..." }`

- `GET /api/v1/jobs/<job_id>`
  - Returns job status payload:
    - `status`, `progress`, `message`
    - `stem_urls`, `stem_download_urls`
    - `download_url` (zip)
    - `source_download_url` (original downloaded source mp3, if URL workflow)

## Downloads

- `GET /api/v1/jobs/<job_id>/download` (zip of stems)
- `GET /api/v1/jobs/<job_id>/source` (original downloaded source file)
- `GET /api/v1/jobs/<job_id>/stems/<stem_key>/stream` (stream stem; supports `?pitch=-12..12`)
- `GET /api/v1/jobs/<job_id>/stems/<stem_key>/download` (download single stem)
- `GET /api/v1/jobs/<job_id>/stems/<stem_key>/loop?start=<sec>&end=<sec>` (download loop clip)

## CORS

Set `API_CORS_ORIGIN` to allow cross-origin API clients (for mobile/web frontends on different origins).
Example:

```bash
export API_CORS_ORIGIN="https://your-frontend.example.com"
```

