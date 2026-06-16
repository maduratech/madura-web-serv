import { Router } from 'express';
import {
  getPublishedBlogPostBySlug,
  listBlogPosts,
} from '../../services/cms-blog.service';
import { getToursListingByIds } from '../../services/booking.service';

export const blogsRouter = Router();

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
  };
}

blogsRouter.get('/blogs', async (_req, res, next) => {
  try {
    const items = await listBlogPosts({ publishedOnly: true, contentType: 'blog' });
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=120');
    res.json({
      items: items.map((row) => mapPublicBlogListItem(row)),
    });
  } catch (err) {
    next(err);
  }
});

blogsRouter.get('/guides', async (_req, res, next) => {
  try {
    const items = await listBlogPosts({ publishedOnly: true, contentType: 'guide' });
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
    const row = await getPublishedBlogPostBySlug(String(req.params.slug || ''), 'blog');
    if (!row) {
      res.status(404).json({ message: 'Blog post not found.' });
      return;
    }
    const rawMarket = String(req.query.market || 'in').trim().toLowerCase();
    const market = rawMarket.split('-')[0] || 'in';
    const related_tours = await getToursListingByIds(row.related_tour_ids, market);
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=120');
    res.json({ ...row, related_tours });
  } catch (err) {
    next(err);
  }
});

blogsRouter.get('/guide/:slug', async (req, res, next) => {
  try {
    const row = await getPublishedBlogPostBySlug(String(req.params.slug || ''), 'guide');
    if (!row) {
      res.status(404).json({ message: 'Guide not found.' });
      return;
    }
    const rawMarket = String(req.query.market || 'in').trim().toLowerCase();
    const market = rawMarket.split('-')[0] || 'in';
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
