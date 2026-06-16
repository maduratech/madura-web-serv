import { Router } from 'express';
import {
  getDestinationShowcase,
  getDestinationBySlug,
  getDestinations,
  getHeroSearchOptions,
  getTourByKey,
  getTourDepartures,
  getTours,
  getToursListing,
} from '../../services/booking.service';
import { getTourThemePageByLabel } from '../../services/cms-taxonomy.service';
import { splitOverviewWithMeta } from '../../lib/tour-overview-meta';

const toursRouter = Router();

toursRouter.get('/tours', async (_req, res, next) => {
  try {
    const tours = await getTours();
    return res.json({ data: tours });
  } catch (error) {
    return next(error);
  }
});

toursRouter.get('/tours-listing', async (req, res, next) => {
  try {
    const raw = String(req.query.market || 'in').trim().toLowerCase();
    const market = raw.split('-')[0] || 'in';
    const tours = await getToursListing(market);
    return res.json({ data: tours });
  } catch (error) {
    return next(error);
  }
});

toursRouter.get('/destinations', async (_req, res, next) => {
  try {
    const destinations = await getDestinations();
    return res.json({ data: destinations });
  } catch (error) {
    return next(error);
  }
});

toursRouter.get('/destinations/:slug', async (req, res, next) => {
  try {
    const row = await getDestinationBySlug(String(req.params.slug || ''));
    if (!row) return res.status(404).json({ message: 'Destination not found.' });
    return res.json({ data: row });
  } catch (error) {
    return next(error);
  }
});

toursRouter.get('/tour-themes/:label', async (req, res, next) => {
  try {
    const label = decodeURIComponent(String(req.params.label || '')).trim();
    if (!label) return res.status(400).json({ message: 'Invalid theme label.' });
    const rawMarket = String(req.query.market || 'in').trim().toLowerCase();
    const market = (rawMarket.split('-')[0] || 'in') as 'in' | 'au';
    const row = await getTourThemePageByLabel(label, market === 'au' ? 'au' : 'in');
    if (!row) return res.status(404).json({ message: 'Tour theme not found.' });
    return res.json({ data: row });
  } catch (error) {
    return next(error);
  }
});

toursRouter.get('/search-options', async (_req, res, next) => {
  try {
    const options = await getHeroSearchOptions();
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
    return res.json({ data: options });
  } catch (error) {
    return next(error);
  }
});

toursRouter.get('/destination-showcase', async (req, res, next) => {
  try {
    const rawMarket = String(req.query.market || 'in').trim().toLowerCase();
    const market = rawMarket.split('-')[0] || 'in';
    const showcase = await getDestinationShowcase(market);
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
    return res.json({ data: showcase });
  } catch (error) {
    return next(error);
  }
});

toursRouter.get('/tours/:idOrSlug', async (req, res, next) => {
  try {
    const key = String(req.params.idOrSlug || '').trim();
    if (!key) {
      return res.status(400).json({ message: 'Invalid tour reference.' });
    }

    const rawMarket = String(req.query.market || 'in').trim().toLowerCase();
    const market = rawMarket.split('-')[0] || 'in';
    const tour = await getTourByKey(key, market);
    if (!tour) {
      return res.status(404).json({ message: 'Tour not found.' });
    }

    const cmsMeta = splitOverviewWithMeta(
      (tour as { overview?: string | null }).overview
    ).meta;
    if (Number(cmsMeta.crm_itinerary_id) > 0) {
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    }

    return res.json({ data: tour });
  } catch (error) {
    return next(error);
  }
});

toursRouter.get('/tours/:id/departures', async (req, res, next) => {
  try {
    const tourId = Number(req.params.id);
    if (!Number.isFinite(tourId) || tourId <= 0) {
      return res.status(400).json({ message: 'Invalid tour id.' });
    }

    const rawMarket = String(req.query.market || 'in').trim().toLowerCase();
    const market = rawMarket.split('-')[0] || 'in';
    const departures = await getTourDepartures(tourId, market);
    if (departures === null) {
      return res.status(404).json({ message: 'Tour not found.' });
    }
    return res.json({ data: departures });
  } catch (error) {
    return next(error);
  }
});

export { toursRouter };

