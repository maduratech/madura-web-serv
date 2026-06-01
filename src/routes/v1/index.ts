import { Router } from 'express';
import { toursRouter } from './tours.routes';
import { bookingsRouter } from './bookings.routes';
import { healthRouter } from './health.routes';
import { accountRouter } from './account.routes';
import { cmsRouter } from './cms.routes';
import { blogsRouter } from './blogs.routes';
import { integrationRouter } from './integration.routes';
import { pricingRouter } from './pricing.routes';
import { siteRouter } from './site.routes';

const v1Router = Router();
v1Router.use(pricingRouter);
v1Router.use(siteRouter);
v1Router.use(toursRouter);
v1Router.use(blogsRouter);
v1Router.use(bookingsRouter);
v1Router.use(accountRouter);
v1Router.use('/cms', cmsRouter);
v1Router.use('/integration', integrationRouter);
v1Router.use(healthRouter);

export { v1Router };
