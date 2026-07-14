import { Router } from 'express';
import {
  getPublishedBlogPostBySlug,
  listBlogPosts,
} from '../../services/cms-blog.service';
import { getToursListingByIds } from '../../services/booking.service';

export const blogsRouter = Router();

function parseMarket(raw: unknown): string {
  const value = String(raw || 'in').trim().toLowerCase();
  return value.split('-')[0] || 'in';
}

function mapPublicBlogListItem(row: Awaited<ReturnType<typeof listBlogPosts>>[number]) {
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    content_type: row.content_type,
    author_name: row.author_name,
    hero_image_url: row.hero_image_url,
    published_at: row.published_at,
    excerpt: excerptFromHtml(row.body_html),
    storefronts: row.storefronts,
  };
}

blogsRouter.get('/blogs', async (req, res, next) => {
  try {
    const market = parseMarket(req.query.market);
    const items = await listBlogPosts({ publishedOnly: true, contentType: 'blog', market });
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=120');
    res.json({
      items: items.map((row) => mapPublicBlogListItem(row)),
    });
  } catch (err) {
    next(err);
  }
});

blogsRouter.get('/guides', async (req, res, next) => {
  try {
    const market = parseMarket(req.query.market);
    const items = await listBlogPosts({ publishedOnly: true, contentType: 'guide', market });
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=120');
    res.json({
      items: items.map((row) => mapPublicBlogListItem(row)),
    });
  } catch (err) {
    next(err);
  }
});

blogsRouter.get('/blogs/:slug', async (req, res, next) => {
  try {
    const market = parseMarket(req.query.market);
    const row = await getPublishedBlogPostBySlug(String(req.params.slug || ''), 'blog', market);
    if (!row) {
      res.status(404).json({ message: 'Blog post not found.' });
      return;
    }
    const related_tours = await getToursListingByIds(row.related_tour_ids, market);
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=120');
    res.json({ ...row, related_tours });
  } catch (err) {
    next(err);
  }
});

blogsRouter.get('/guide/:slug', async (req, res, next) => {
  try {
    const market = parseMarket(req.query.market);
    const row = await getPublishedBlogPostBySlug(String(req.params.slug || ''), 'guide', market);
    if (!row) {
      res.status(404).json({ message: 'Guide not found.' });
      return;
    }
    const related_tours = await getToursListingByIds(row.related_tour_ids, market);
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=120');
    res.json({ ...row, related_tours });
  } catch (err) {
    next(err);
  }
});

function excerptFromHtml(html: string | null | undefined, max = 180): string {
  const text = String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max).trim()}…`;
}
