import { Router } from 'express';
import { requireCrmIntegrationSecret } from '../../middlewares/crm-integration.middleware';
import {
  getPublishedTourLink,
  publishItineraryToTour,
} from '../../services/itinerary-publish.service';
import { searchStockImages } from '../../services/cms-media.service';

export const integrationRouter = Router();

const webPublicBase =
  process.env.MADURA_WEB_PUBLIC_URL ||
  process.env.WEB_PUBLIC_BASE_URL ||
  'https://web.maduratravel.com';

integrationRouter.use(requireCrmIntegrationSecret);

integrationRouter.post('/itinerary/publish', async (req, res, next) => {
  try {
    const body = req.body || {};
    const itineraryId = Number(body.itineraryId);
    if (!itineraryId) {
      res.status(400).json({ message: 'itineraryId is required.' });
      return;
    }
    const result = await publishItineraryToTour(
      {
        itineraryId,
        creative_title: body.creative_title,
        destination: body.destination,
        duration: body.duration,
        starting_point: body.starting_point,
        cover_image_url: body.cover_image_url,
        gallery_image_urls: body.gallery_image_urls,
        itinerary_status: body.itinerary_status,
        lead_status: body.lead_status,
        day_wise_plan: body.day_wise_plan,
        overview: body.overview,
        inclusions: body.inclusions,
        exclusions: body.exclusions,
        detailed_hotels: body.detailed_hotels,
        detailed_flights: body.detailed_flights,
        costing_options: body.costing_options,
        adults: body.adults,
        children: body.children,
        infants: body.infants,
        grand_total: body.grand_total,
        lead_requirements: body.lead_requirements,
        display_currency: body.display_currency,
      },
      webPublicBase
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

integrationRouter.get('/stock-images', async (req, res, next) => {
  try {
    const query = String(req.query.q || req.query.query || '').trim();
    if (!query) {
      res.status(400).json({ message: 'Query q is required.' });
      return;
    }
    const page = Math.max(1, Number(req.query.page || 1));
    const result = await searchStockImages(query, page);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

integrationRouter.get('/itinerary/:itineraryId/public-link', async (req, res, next) => {
  try {
    const itineraryId = Number(req.params.itineraryId);
    if (!itineraryId) {
      res.status(400).json({ message: 'Invalid itinerary id.' });
      return;
    }
    const result = await getPublishedTourLink(itineraryId, webPublicBase);
    res.json(result);
  } catch (err) {
    next(err);
  }
});
