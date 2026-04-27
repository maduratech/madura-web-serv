import { Router } from 'express';
import { createBooking, createEnquiry } from '../../services/booking.service';

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

bookingsRouter.post('/enquiries', async (req, res, next) => {
  try {
    const result = await createEnquiry(req.body);
    return res.status(201).json({
      message: 'Enquiry submitted successfully.',
      data: result,
    });
  } catch (error) {
    return next(error);
  }
});

export { bookingsRouter };

