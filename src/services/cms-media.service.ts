import { supabase } from '../lib/supabase';
import { env } from '../config/env';

const MAX_BYTES = 8 * 1024 * 1024;

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
  if (buffer.length > MAX_BYTES) throw new Error('File is too large (max 8 MB).');

  const mime = String(input.mime_type || 'image/jpeg').trim() || 'image/jpeg';
  if (!/^image\/(jpe?g|png|webp|gif)$/i.test(mime)) {
    throw new Error('Only JPEG, PNG, WebP, and GIF images are allowed.');
  }

  const ext =
    mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : mime.includes('gif') ? 'gif' : 'jpg';
  const bucket = env.CMS_MEDIA_BUCKET || 'cms-media';
  const path = `uploads/${Date.now()}-${sanitizeFilename(input.filename || `image.${ext}`)}`;

  const { error } = await supabase.storage.from(bucket).upload(path, buffer, {
    contentType: mime,
    upsert: false,
  });
  if (error) {
    throw new Error(
      error.message.includes('Bucket not found')
        ? `Storage bucket "${bucket}" not found. Create a public bucket named "${bucket}" in Supabase.`
        : error.message
    );
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

  const url = new URL('https://api.pexels.com/v1/search');
  url.searchParams.set('query', q);
  url.searchParams.set('per_page', '15');
  url.searchParams.set('page', String(Math.max(1, page)));

  const res = await fetch(url.toString(), {
    headers: { Authorization: key },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `Pexels search failed (${res.status})`);
  }

  const body = (await res.json()) as {
    photos?: Array<{
      id: number;
      width: number;
      height: number;
      photographer: string;
      url: string;
      src?: { medium?: string; large?: string; original?: string };
    }>;
    next_page?: string;
  };

  const items: StockImageResult[] = (body.photos || []).map((photo) => ({
    id: String(photo.id),
    preview_url: photo.src?.medium || photo.src?.large || '',
    full_url: photo.src?.large || photo.src?.original || photo.src?.medium || '',
    width: photo.width,
    height: photo.height,
    photographer: photo.photographer,
    source: 'pexels' as const,
    source_url: photo.url,
  }));

  return {
    items: items.filter((i) => i.preview_url && i.full_url),
    page: Math.max(1, page),
    has_more: Boolean(body.next_page),
  };
}
