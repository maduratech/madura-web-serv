import { Router } from 'express';
import { getFxRatesPayload } from '../../lib/fx-rates';
import { globalUsdDisplayFromInr, suggestedUsdFromInr } from '../../lib/tour-market-audience';

export const pricingRouter = Router();

pricingRouter.get('/pricing/fx', async (_req, res, next) => {
  try {
    const payload = await getFxRatesPayload();
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=3600');
    return res.json(payload);
  } catch (error) {
    return next(error);
  }
});

pricingRouter.get('/pricing/suggest-usd', async (req, res, next) => {
  try {
    const inr = Number(req.query.inr);
    if (!Number.isFinite(inr) || inr <= 0) {
      return res.status(400).json({ message: 'inr query must be a positive number.' });
    }
    const fx = await getFxRatesPayload();
    const usd = suggestedUsdFromInr(inr, fx.rates.USD);
    return res.json({
      inr,
      usd,
      inr_per_usd: fx.rates.USD,
      formula: 'INR ÷ FX × 1.5, rounded up to nearest USD 50 (under 1000)',
    });
  } catch (error) {
    return next(error);
  }
});

pricingRouter.post('/pricing/convert-batch', async (req, res, next) => {
  try {
    const amounts = Array.isArray(req.body?.amounts) ? req.body.amounts : [];
    const inrList = amounts
      .map((v: unknown) => Number(v))
      .filter((n: number) => Number.isFinite(n) && n > 0);
    const fx = await getFxRatesPayload();
    const converted: Record<string, number> = {};
    for (const inr of inrList) {
      const key = String(Math.round(inr));
      converted[key] = globalUsdDisplayFromInr(inr, fx.rates.USD);
    }
    return res.json({ inr_per_usd: fx.rates.USD, converted });
  } catch (error) {
    return next(error);
  }
});

pricingRouter.get('/pricing/convert', async (req, res, next) => {
  try {
    const inr = Number(req.query.inr);
    if (!Number.isFinite(inr) || inr <= 0) {
      return res.status(400).json({ message: 'inr query must be a positive number.' });
    }
    const fx = await getFxRatesPayload();
    const usd = globalUsdDisplayFromInr(inr, fx.rates.USD);
    return res.json({
      inr,
      usd,
      inr_per_usd: fx.rates.USD,
    });
  } catch (error) {
    return next(error);
  }
});
