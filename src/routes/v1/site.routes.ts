import { Router } from 'express';
import { listHeaderMarqueePublic } from '../../services/cms-header-marquee.service';

export const siteRouter = Router();

siteRouter.get('/site/header-marquee', async (_req, res, next) => {
  try {
    const items = await listHeaderMarqueePublic();
    res.json({ items });
  } catch (err) {
    next(err);
  }
});
