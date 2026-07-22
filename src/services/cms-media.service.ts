import { supabase } from '../lib/supabase';
import { env } from '../config/env';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_VIDEO_BYTES = 32 * 1024 * 1024;

function sanitizeFilename(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 120) || 'upload';
}

export async function uploadCmsMedia(input: {
  base64: string;
  mime_type?: string;
  filename?: string;
}): Promise<{ url: string }> {
  const raw = String(input.base64 || '').trim();
  if (!raw) throw new Error('File data is required.');
  const buffer = Buffer.from(raw, 'base64');
  if (!buffer.length) throw new Error('Invalid file data.');

  const mime = String(input.mime_type || 'image/jpeg').trim() || 'image/jpeg';
  const isVideo = /^video\/(mp4|webm|quicktime)$/i.test(mime);
  const isImage = /^image\/(jpe?g|png|webp|gif)$/i.test(mime);
  if (!isVideo && !isImage) {
    throw new Error('Only JPEG, PNG, WebP, GIF images or MP4, WebM, and MOV videos are allowed.');
  }

  const maxBytes = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (buffer.length > maxBytes) {
    throw new Error(`File is too large (max ${isVideo ? '32' : '8'} MB).`);
  }

  const ext = isVideo
    ? mime.includes('webm')
      ? 'webm'
      : mime.includes('quicktime')
        ? 'mov'
        : 'mp4'
    : mime.includes('png')
      ? 'png'
      : mime.includes('webp')
        ? 'webp'
        : mime.includes('gif')
          ? 'gif'
          : 'jpg';
  const bucket = env.CMS_MEDIA_BUCKET || 'cms-media';
  const path = `uploads/${Date.now()}-${sanitizeFilename(input.filename || `image.${ext}`)}`;

  const { error } = await supabase.storage.from(bucket).upload(path, buffer, {
    contentType: mime,
    upsert: false,
  });
  if (error) {
    const msg = error.message || 'Upload failed.';
    if (msg.includes('Bucket not found')) {
      throw new Error(
        `Storage bucket "${bucket}" not found. Create a public bucket named "${bucket}" in Supabase.`
      );
    }
    if (/mime type .+ is not supported/i.test(msg)) {
      throw new Error(
        `This file type (${mime}) is not allowed by the "${bucket}" storage bucket. ` +
          'Ask an admin to add it under Supabase → Storage → cms-media → Allowed MIME types.'
      );
    }
    throw new Error(msg);
  }

  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  const url = data?.publicUrl?.trim();
  if (!url) throw new Error('Upload succeeded but public URL is missing.');
  return { url };
}

export type StockImageResult = {
  id: string;
  preview_url: string;
  full_url: string;
  width: number;
  height: number;
  photographer: string;
  source: 'pexels';
  source_url: string;
};

type StockCacheEntry = { data: { items: StockImageResult[]; page: number; has_more: boolean }; at: number };
const stockSearchCache = new Map<string, StockCacheEntry>();
const STOCK_CACHE_TTL_MS = 15 * 60 * 1000;
const STOCK_CACHE_MAX_ENTRIES = 200;

function trimStockCache<T>(store: Map<string, T>): void {
  if (store.size <= STOCK_CACHE_MAX_ENTRIES) return;
  const excess = store.size - STOCK_CACHE_MAX_ENTRIES;
  const keys = [...store.keys()];
  for (let i = 0; i < excess; i++) {
    store.delete(keys[i]!);
  }
}

export async function searchStockImages(query: string, page = 1): Promise<{
  items: StockImageResult[];
  page: number;
  has_more: boolean;
}> {
  const key = env.PEXELS_API_KEY?.trim();
  if (!key) {
    throw new Error('Stock image search is not configured. Set PEXELS_API_KEY on the API server.');
  }
  const q = String(query || '').trim();
  if (!q) return { items: [], page: 1, has_more: false };

  const cacheKey = `${q}|${page}`;
  const cached = stockSearchCache.get(cacheKey);
  if (cached && Date.now() - cached.at < STOCK_CACHE_TTL_MS) {
    return cached.data;
  }

  const url = new URL('https://api.pexels.com/v1/search');
  url.searchParams.set('query', q);
  url.searchParams.set('per_page', '15');
  url.searchParams.set('page', String(Math.max(1, page)));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: { Authorization: key },
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Pexels search timed out. Try again.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 401) {
      throw new Error('Invalid PEXELS_API_KEY on the API server.');
    }
    throw new Error(text.slice(0, 200) || `Pexels search failed (${res.status})`);
  }

  const body = (await res.json()) as {
    photos?: Array<{
      id: number;
      width: number;
      height: number;
      photographer: string;
      url: string;
      src?: {
        medium?: string;
        large?: string;
        large2x?: string;
        original?: string;
      };
    }>;
    next_page?: string;
  };

  const items: StockImageResult[] = (body.photos || []).map((photo) => ({
    id: String(photo.id),
    preview_url: photo.src?.medium || photo.src?.large || '',
    // Prefer ≥720px sources for heroes/galleries (large2x ~1880, original full, large ~940).
    full_url:
      photo.src?.large2x ||
      photo.src?.original ||
      photo.src?.large ||
      photo.src?.medium ||
      '',
    width: photo.width,
    height: photo.height,
    photographer: photo.photographer,
    source: 'pexels' as const,
    source_url: photo.url,
  }));

  const result = {
    items: items.filter((i) => i.preview_url && i.full_url),
    page: Math.max(1, page),
    has_more: Boolean(body.next_page),
  };
  stockSearchCache.set(cacheKey, { data: result, at: Date.now() });
  trimStockCache(stockSearchCache);
  return result;
}

export type StockVideoResult = {
  id: string;
  preview_url: string;
  full_url: string;
  width: number;
  height: number;
  duration: number;
  photographer: string;
  source: 'pexels';
  source_url: string;
};

type StockVideoCacheEntry = {
  data: { items: StockVideoResult[]; page: number; has_more: boolean };
  at: number;
};
const stockVideoSearchCache = new Map<string, StockVideoCacheEntry>();

export function sweepStockSearchCaches(now = Date.now()): void {
  for (const [key, entry] of stockSearchCache) {
    if (now - entry.at >= STOCK_CACHE_TTL_MS) stockSearchCache.delete(key);
  }
  for (const [key, entry] of stockVideoSearchCache) {
    if (now - entry.at >= STOCK_CACHE_TTL_MS) stockVideoSearchCache.delete(key);
  }
}

function pickPexelsVideoFileUrl(
  files: Array<{ quality?: string; file_type?: string; width?: number | null; height?: number | null; link?: string }>
): string {
  const mp4s = files.filter(
    (file) =>
      file.file_type === 'video/mp4' &&
      file.quality !== 'hls' &&
      typeof file.link === 'string' &&
      file.link.trim()
  );
  if (!mp4s.length) return '';

  const byQuality = (quality: string) =>
    mp4s
      .filter((file) => file.quality === quality)
      .sort((a, b) => Number(b.width || 0) - Number(a.width || 0));

  const hd = byQuality('hd');
  if (hd.length) return hd[0].link!.trim();

  const sd = byQuality('sd');
  if (sd.length) return sd[0].link!.trim();

  return mp4s.sort((a, b) => Number(b.width || 0) - Number(a.width || 0))[0].link!.trim();
}

export async function searchStockVideos(query: string, page = 1): Promise<{
  items: StockVideoResult[];
  page: number;
  has_more: boolean;
}> {
  const key = env.PEXELS_API_KEY?.trim();
  if (!key) {
    throw new Error('Stock video search is not configured. Set PEXELS_API_KEY on the API server.');
  }
  const q = String(query || '').trim();
  if (!q) return { items: [], page: 1, has_more: false };

  const cacheKey = `${q}|${page}`;
  const cached = stockVideoSearchCache.get(cacheKey);
  if (cached && Date.now() - cached.at < STOCK_CACHE_TTL_MS) {
    return cached.data;
  }

  const url = new URL('https://api.pexels.com/v1/videos/search');
  url.searchParams.set('query', q);
  url.searchParams.set('per_page', '12');
  url.searchParams.set('page', String(Math.max(1, page)));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: { Authorization: key },
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Pexels video search timed out. Try again.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 401) {
      throw new Error('Invalid PEXELS_API_KEY on the API server.');
    }
    throw new Error(text.slice(0, 200) || `Pexels video search failed (${res.status})`);
  }

  const body = (await res.json()) as {
    videos?: Array<{
      id: number;
      width: number;
      height: number;
      url: string;
      image: string;
      duration: number;
      user?: { name?: string };
      video_files?: Array<{
        quality?: string;
        file_type?: string;
        width?: number | null;
        height?: number | null;
        link?: string;
      }>;
    }>;
    next_page?: string;
  };

  const items: StockVideoResult[] = (body.videos || [])
    .map((video) => {
      const full_url = pickPexelsVideoFileUrl(video.video_files || []);
      return {
        id: String(video.id),
        preview_url: String(video.image || '').trim(),
        full_url,
        width: video.width,
        height: video.height,
        duration: Number(video.duration) || 0,
        photographer: String(video.user?.name || '').trim(),
        source: 'pexels' as const,
        source_url: video.url,
      };
    })
    .filter((item) => item.preview_url && item.full_url);

  const result = {
    items,
    page: Math.max(1, page),
    has_more: Boolean(body.next_page),
  };
  stockVideoSearchCache.set(cacheKey, { data: result, at: Date.now() });
  trimStockCache(stockVideoSearchCache);
  return result;
}
