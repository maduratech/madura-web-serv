import { Router } from 'express';
import { proxyStellaMarisCampaign } from '../../services/stella-maris-campaign.service';

const campaignsRouter = Router();

/**
 * Stella Maris SPIN Wheel — browser talks to web-serv; web-serv forwards to CRM.
 *
 * POST /api/v1/campaigns/stella-maris/otp/send
 * POST /api/v1/campaigns/stella-maris/otp/verify
 * POST /api/v1/campaigns/stella-maris/logged-in-session
 * POST /api/v1/campaigns/stella-maris/spin
 */

campaignsRouter.post('/campaigns/stella-maris/otp/send', async (req, res, next) => {
  try {
    const result = await proxyStellaMarisCampaign('/api/campaign/stella-maris/otp/send', req.body || {});
    return res.status(result.status).json(result.data);
  } catch (err) {
    return next(err);
  }
});

campaignsRouter.post('/campaigns/stella-maris/otp/verify', async (req, res, next) => {
  try {
    const result = await proxyStellaMarisCampaign('/api/campaign/stella-maris/otp/verify', req.body || {});
    return res.status(result.status).json(result.data);
  } catch (err) {
    return next(err);
  }
});

campaignsRouter.post('/campaigns/stella-maris/logged-in-session', async (req, res, next) => {
  try {
    const result = await proxyStellaMarisCampaign(
      '/api/campaign/stella-maris/logged-in-session',
      req.body || {}
    );
    return res.status(result.status).json(result.data);
  } catch (err) {
    return next(err);
  }
});

campaignsRouter.post('/campaigns/stella-maris/spin', async (req, res, next) => {
  try {
    const result = await proxyStellaMarisCampaign('/api/campaign/stella-maris/spin', req.body || {});
    return res.status(result.status).json(result.data);
  } catch (err) {
    return next(err);
  }
});

export { campaignsRouter };
