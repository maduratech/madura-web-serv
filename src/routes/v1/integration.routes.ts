import { Router } from 'express';
import { requireCrmIntegrationSecret } from '../../middlewares/crm-integration.middleware';
import {
  getPublishedTourLink,
  publishItineraryToTour,
} from '../../services/itinerary-publish.service';

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
      },
      webPublicBase
    );
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
