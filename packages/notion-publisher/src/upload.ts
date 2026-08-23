/**
 * Notion File Upload API (raw fetch — not yet stable across SDK versions).
 * Single-part up to 20 MiB; multi-part above that, 10 MiB parts, 5 GiB cap on
 * paid workspaces (§5.0 plan caveat: free workspaces cap at 5 MiB, which no
 * real condensed video fits — the video must then be hosted externally).
 */
import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { basename } from 'node:path';

const API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const SINGLE_PART_MAX = 20 * 1024 * 1024;
const PART_SIZE = 10 * 1024 * 1024;
const HARD_CAP = 5 * 1024 * 1024 * 1024;
const MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 1000;

interface FileUploadObject {
  id: string;
  status: string;
  upload_url?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function retryDelayMs(res: Response | null, attempt: number): number {
  const retryAfter = res?.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  }
  return RETRY_BASE_MS * 2 ** attempt;
}

/**
 * Fetch with retries on 429 (honoring Retry-After), 5xx, and network errors —
 * one blip at part N of a multi-GB upload must not discard all progress.
 * 4xx other than 429 fails immediately (retrying won't change the answer).
 */
async function notionFetch(token: string, path: string, init: RequestInit): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let res: Response | null = null;
    try {
      res = await fetch(`${API}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          'Notion-Version': NOTION_VERSION,
          ...(init.headers ?? {}),
        },
      });
      if (res.ok) return res;
      const body = await res.text();
      lastError = new Error(`Notion API ${path} failed (${res.status}): ${body.slice(0, 500)}`);
      if (res.status !== 429 && res.status < 500) throw lastError;
    } catch (err) {
      if (err === lastError) throw err; // non-retryable status from above
      lastError = err; // network-level failure; retry
    }
    if (attempt < MAX_ATTEMPTS - 1) await sleep(retryDelayMs(res, attempt));
  }
  throw lastError;
}

function readChunk(fd: number, position: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  const bytes = readSync(fd, buf, 0, length, position);
  return bytes === length ? buf : buf.subarray(0, bytes);
}

/** Upload a local file; returns the file_upload id to attach to a video block. */
export async function uploadFile(token: string, filePath: string): Promise<string> {
  const size = statSync(filePath).size;
  const filename = basename(filePath);
  if (size > HARD_CAP) {
    throw new Error(
      `${filename} is ${(size / 1e9).toFixed(1)} GB — over Notion's 5 GiB cap. ` +
        'Host the video externally and use --embed-url instead.',
    );
  }

  const multiPart = size > SINGLE_PART_MAX;
  const numberOfParts = multiPart ? Math.ceil(size / PART_SIZE) : 1;
  const createRes = await notionFetch(token, '/file_uploads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      multiPart
        ? { mode: 'multi_part', number_of_parts: numberOfParts, filename }
        : { mode: 'single_part', filename },
    ),
  });
  const upload = (await createRes.json()) as FileUploadObject;

  const fd = openSync(filePath, 'r');
  try {
    for (let part = 0; part < numberOfParts; part++) {
      const position = part * PART_SIZE;
      const length = Math.min(multiPart ? PART_SIZE : size, size - position);
      const chunk = readChunk(fd, position, length);
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(chunk)], { type: 'video/mp4' }), filename);
      if (multiPart) form.append('part_number', String(part + 1));
      await notionFetch(token, `/file_uploads/${upload.id}/send`, { method: 'POST', body: form });
      if (multiPart) {
        process.stdout.write(`\r  uploading: part ${part + 1}/${numberOfParts}   `);
      }
    }
    if (multiPart) {
      process.stdout.write('\n');
      await notionFetch(token, `/file_uploads/${upload.id}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
    }
  } finally {
    closeSync(fd);
  }
  return upload.id;
}
