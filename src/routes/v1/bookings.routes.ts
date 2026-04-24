import { Router } from 'express';
import { createBooking } from '../../services/booking.service';

const bookingsRouter = Router();

bookingsRouter.post('/bookings', async (req, res, next) => {
  try {
    const result = await createBooking(req.body);
    return res.status(201).json({
      message: 'Booking created successfully.',
      data: result,
    });
  } catch (error) {
    return next(error);
  }
});

export { bookingsRouter };

