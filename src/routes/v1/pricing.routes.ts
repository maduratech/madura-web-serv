import { Router } from 'express';
import { getForexDisplayRates } from '../../lib/forex-display-rates';
import { getFxRatesPayload } from '../../lib/fx-rates';
import { getStorefrontFxRates } from '../../lib/storefront-fx-rates';
import { audDisplayFromInr, globalUsdDisplayFromInr, suggestedUsdFromInr } from '../../lib/tour-market-audience';

/** CMS + storefront helpers (INR → USD/AUD at daily cached FX). */
export const pricingRouter = Router();

pricingRouter.get('/pricing/forex-rates', async (_req, res, next) => {
  try {
    const payload = await getForexDisplayRates();
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400');
    return res.json(payload);
  } catch (error) {
    return next(error);
  }
});

pricingRouter.get('/pricing/fx', async (_req, res, next) => {
  try {
    const storefront = await getStorefrontFxRates();
    const usdLive = await getFxRatesPayload();
    const payload = {
      base: 'INR' as const,
      rates: {
        INR: 1,
        USD: storefront.rates.USD ?? usdLive.rates.USD,
        AUD: storefront.rates.AUD,
      },
      asOf: Math.max(storefront.asOf, usdLive.asOf),
      source: `${storefront.source};usd:${usdLive.source}`,
    };
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400');
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
      formula: 'INR ÷ daily FX rate (no markup)',
    });
  } catch (error) {
    return next(error);
  }
});

pricingRouter.post('/pricing/convert-markets', async (req, res, next) => {
  try {
    const amounts = Array.isArray(req.body?.amounts) ? req.body.amounts : [];
    const inrList = amounts
      .map((v: unknown) => Number(v))
      .filter((n: number) => Number.isFinite(n) && n > 0);
    const fx = await getStorefrontFxRates();
    const converted: Record<string, { usd: number; aud: number }> = {};
    for (const inr of inrList) {
      const key = String(Math.round(inr));
      converted[key] = {
        usd: globalUsdDisplayFromInr(inr, fx.rates.USD),
        aud: audDisplayFromInr(inr, fx.rates.AUD),
      };
    }
    return res.json({ rates: fx.rates, converted });
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
