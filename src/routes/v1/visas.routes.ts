import { Router } from 'express';
import {
  getPublishedVisaPageBySlug,
  listPublishedVisas,
  type VisaFilterDeliveryBucket,
  type VisaFilterDocumentLevel,
  type VisaFilterVisaType,
  type VisaListingFilters,
} from '../../services/cms-visa.service';

export const visasRouter = Router();

function parseMarket(raw: unknown): string {
  const v = String(raw || 'in').trim().toLowerCase();
  return v.split('-')[0] || 'in';
}

function parseListingFilters(query: Record<string, unknown>): VisaListingFilters {
  const filters: VisaListingFilters = {};
  const type = String(query.type || query.filter_visa_type || 'all').trim();
  const documents = String(query.documents || query.filter_document_level || 'all').trim();
  const delivery = String(query.delivery || query.filter_delivery_bucket || 'all').trim();
  if (type && type !== 'all') filters.filter_visa_type = type as VisaFilterVisaType;
  if (documents && documents !== 'all') {
    filters.filter_document_level = documents as VisaFilterDocumentLevel;
  }
  if (delivery && delivery !== 'all') {
    filters.filter_delivery_bucket = delivery as VisaFilterDeliveryBucket;
  }
  return filters;
}

visasRouter.get('/visas', async (req, res, next) => {
  try {
    const market = parseMarket(req.query.market);
    const filters = parseListingFilters(req.query as Record<string, unknown>);
    const { items, facets } = await listPublishedVisas(market, filters);
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=120');
    res.json({
      items: items.map((row) => ({
        id: row.id,
        slug: row.slug,
        title: row.title,
        country_name: row.country_name,
        flag_iso: row.flag_iso,
        hero_images: row.hero_images,
        delivery_promise_text: row.delivery_promise_text,
        starting_price_inr: row.starting_price_inr,
        validity_label: row.validity_label,
        visa_type_label: row.visa_type_label,
        filter_visa_type: row.filter_visa_type,
        filter_document_level: row.filter_document_level,
        filter_delivery_bucket: row.filter_delivery_bucket,
      })),
      facets,
    });
  } catch (err) {
    next(err);
  }
});

visasRouter.get('/visas/:slug', async (req, res, next) => {
  try {
    const market = parseMarket(req.query.market);
    const row = await getPublishedVisaPageBySlug(String(req.params.slug || ''), market);
    if (!row) {
      res.status(404).json({ message: 'Visa page not found.' });
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=120');
    res.json(row);
  } catch (err) {
    next(err);
  }
});
