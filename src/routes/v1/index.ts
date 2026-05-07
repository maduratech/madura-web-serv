import { Router } from 'express';
import { toursRouter } from './tours.routes';
import { bookingsRouter } from './bookings.routes';
import { healthRouter } from './health.routes';
import { accountRouter } from './account.routes';

const v1Router = Router();
v1Router.use(toursRouter);
v1Router.use(bookingsRouter);
v1Router.use(accountRouter);
v1Router.use(healthRouter);

export { v1Router };
