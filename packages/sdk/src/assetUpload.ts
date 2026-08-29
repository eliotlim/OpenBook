import {ASSET_IMAGE_MIMES, DEFAULT_MAX_ASSET_BYTES} from './importAssets';

export const AGENT_ASSET_MIMES: ReadonlySet<string> = new Set([
  ...ASSET_IMAGE_MIMES,
  'application/octet-stream',
]);

export type AssetUploadErrorCode = 'mime-not-allowed' | 'too-large' | 'malformed-base64' | 'page-not-found' | 'read-only';

export class AssetUploadError extends Error {
  constructor(readonly code: AssetUploadErrorCode, message: string) {
    super(message);
    this.name = 'AssetUploadError';
  }
}

export interface AgentAssetUploadInput {
  pageId: string;
  mime: string;
  filename?: string;
  base64: string;
}

export interface AgentAssetUploadResult {
  assetId: string;
  url?: string;
  bytes: number;
  mime: string;
}

export interface AgentAssetUploader {
  pageExists(pageId: string): Promise<boolean>;
  canWrite(pageId: string): Promise<boolean>;
  put(bytes: Uint8Array, mime: string, pageId: string, filename?: string): Promise<{id: string; url?: string}>;
}

/** Shared upload implementation used by both the MCP and in-app agent tools. */
export async function uploadAgentAsset(
  input: AgentAssetUploadInput,
  uploader: AgentAssetUploader,
  decode: (base64: string) => Uint8Array = decodeStrictBase64,
): Promise<AgentAssetUploadResult> {
  const mime = input.mime.trim().toLowerCase();
  if (!AGENT_ASSET_MIMES.has(mime)) {
    throw new AssetUploadError('mime-not-allowed', `Asset MIME type "${input.mime}" is not allowed.`);
  }
  // Deliberately conservative and performed before decode/allocation. Padding can
  // only reduce the real size by two bytes, which is immaterial at the cap.
  if (Math.ceil(input.base64.length * 3 / 4) > DEFAULT_MAX_ASSET_BYTES) {
    throw new AssetUploadError('too-large', `Asset exceeds the ${DEFAULT_MAX_ASSET_BYTES}-byte limit.`);
  }
  if (!(await uploader.pageExists(input.pageId))) {
    throw new AssetUploadError('page-not-found', 'Page not found.');
  }
  if (!(await uploader.canWrite(input.pageId))) {
    throw new AssetUploadError('read-only', 'This page or instance is read-only.');
  }
  const bytes = decode(input.base64);
  if (bytes.byteLength === 0) throw new AssetUploadError('malformed-base64', 'Base64 payload is empty or malformed.');
  if (bytes.byteLength > DEFAULT_MAX_ASSET_BYTES) {
    throw new AssetUploadError('too-large', `Asset exceeds the ${DEFAULT_MAX_ASSET_BYTES}-byte limit.`);
  }
  const stored = await uploader.put(bytes, mime, input.pageId, input.filename);
  return {assetId: stored.id, ...(stored.url ? {url: stored.url} : {}), bytes: bytes.byteLength, mime};
}

export function decodeStrictBase64(raw: string): Uint8Array {
  if (!raw || raw.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw)) {
    throw new AssetUploadError('malformed-base64', 'Base64 payload is malformed.');
  }
  try {
    const binary = atob(raw);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    throw new AssetUploadError('malformed-base64', 'Base64 payload is malformed.');
  }
}
