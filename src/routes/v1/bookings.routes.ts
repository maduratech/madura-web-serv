import { Router } from 'express';
import {
  createBooking,
  createBookingPaymentOrder,
  createEnquiry,
  createWebsiteLead,
  handleRazorpayWebhook,
  updateBookingPaymentStatus,
  verifyBookingPayment
} from '../../services/booking.service';
import { attachAuthIfPresent } from '../../middlewares/auth.middleware';

const bookingsRouter = Router();

bookingsRouter.post('/bookings', attachAuthIfPresent, async (req, res, next) => {
  try {
    const result = await createBooking({
      ...req.body,
      user_id: req.auth?.userId,
    });
    return res.status(201).json({
      message: 'Booking created successfully.',
      data: result,
    });
  } catch (error) {
    return next(error);
  }
});

bookingsRouter.post('/bookings/:bookingId/payment-order', async (req, res, next) => {
  try {
    const bookingId = Number(req.params.bookingId || req.body.booking_id || 0);
    const result = await createBookingPaymentOrder({ booking_id: bookingId });
    return res.status(201).json({
      message: 'Payment order created successfully.',
      data: result,
    });
  } catch (error) {
    return next(error);
  }
});

bookingsRouter.post('/bookings/:bookingId/payment-verify', async (req, res, next) => {
  try {
    const bookingId = Number(req.params.bookingId || req.body.booking_id || 0);
    const result = await verifyBookingPayment({
      booking_id: bookingId,
      razorpay_order_id: String(req.body.razorpay_order_id || ''),
      razorpay_payment_id: String(req.body.razorpay_payment_id || ''),
      razorpay_signature: String(req.body.razorpay_signature || ''),
    });
    return res.status(200).json({
      message: 'Payment verified successfully.',
      data: result,
    });
  } catch (error) {
    return next(error);
  }
});

bookingsRouter.post('/bookings/:bookingId/payment-status', async (req, res, next) => {
  try {
    const bookingId = Number(req.params.bookingId || req.body.booking_id || 0);
    const result = await updateBookingPaymentStatus({
      booking_id: bookingId,
      payment_status: req.body.payment_status as 'cancelled' | 'failed' | 'pending',
      reason: req.body.reason,
      razorpay_order_id: req.body.razorpay_order_id,
      razorpay_payment_id: req.body.razorpay_payment_id,
    });
    return res.status(200).json({
      message: 'Payment status updated.',
      data: result,
    });
  } catch (error) {
    return next(error);
  }
});

bookingsRouter.post('/payments/razorpay/webhook', async (req, res, next) => {
  try {
    const signature = req.get('x-razorpay-signature');
    const rawBody = JSON.stringify(req.body || {});
    const result = await handleRazorpayWebhook(rawBody, signature);
    return res.status(200).json({
      message: 'Webhook processed.',
      data: result,
    });
  } catch (error) {
    return next(error);
  }
});

bookingsRouter.post('/enquiries', attachAuthIfPresent, async (req, res, next) => {
  try {
    const result = await createEnquiry({
      ...req.body,
      ip_address: req.ip,
      user_agent: req.get('user-agent') || '',
      user_id: req.auth?.userId,
    });
    return res.status(201).json({
      message: 'Enquiry submitted successfully.',
      data: result,
    });
  } catch (error) {
    return next(error);
  }
});

bookingsRouter.post('/leads/website', async (req, res, next) => {
  try {
    const result = await createWebsiteLead({
      ...req.body,
      ip_address: req.ip,
      user_agent: req.get('user-agent') || '',
    });
    return res.status(201).json({
      message: 'Lead submitted successfully.',
      data: result,
    });
  } catch (error) {
    return next(error);
  }
});

export { bookingsRouter };

