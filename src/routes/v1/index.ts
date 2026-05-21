import { Router } from 'express';
import { toursRouter } from './tours.routes';
import { bookingsRouter } from './bookings.routes';
import { healthRouter } from './health.routes';
import { accountRouter } from './account.routes';
import { cmsRouter } from './cms.routes';

const v1Router = Router();
v1Router.use(toursRouter);
v1Router.use(bookingsRouter);
v1Router.use(accountRouter);
v1Router.use('/cms', cmsRouter);
v1Router.use(healthRouter);

export { v1Router };
