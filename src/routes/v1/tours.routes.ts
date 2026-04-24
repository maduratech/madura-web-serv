import { Router } from 'express';
import { getDestinationShowcase, getDestinations, getHeroSearchOptions, getTourDepartures, getTours } from '../../services/booking.service';

const toursRouter = Router();

toursRouter.get('/tours', async (_req, res, next) => {
  try {
    const tours = await getTours();
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

toursRouter.get('/search-options', async (_req, res, next) => {
  try {
    const options = await getHeroSearchOptions();
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
    return res.json({ data: options });
  } catch (error) {
    return next(error);
  }
});

toursRouter.get('/destination-showcase', async (_req, res, next) => {
  try {
    const showcase = await getDestinationShowcase();
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
    return res.json({ data: showcase });
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

    const departures = await getTourDepartures(tourId);
    return res.json({ data: departures });
  } catch (error) {
    return next(error);
  }
});

export { toursRouter };

