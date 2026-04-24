import { Router } from 'express';
import { toursRouter } from './tours.routes';
import { bookingsRouter } from './bookings.routes';

const v1Router = Router();
v1Router.use(toursRouter);
v1Router.use(bookingsRouter);

export { v1Router };
