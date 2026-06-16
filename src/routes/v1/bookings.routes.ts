import { Router } from 'express';
import {
  createBooking,
  createBookingBalancePaymentOrder,
  createBookingPaymentOrder,
  createEnquiry,
  createPlannerLead,
  createWebsiteLead,
  getBookingActivity,
  getBookingPaymentSummary,
  handleRazorpayWebhook,
  updateBookingPaymentStatus,
  verifyBookingPayment
} from '../../services/booking.service';
import { requireBookingAccess } from '../../middlewares/booking-access.middleware';
import { attachAuthIfPresent, requireAuth } from '../../middlewares/auth.middleware';
import { bookingCreateRateLimit, paymentRateLimit } from '../../middlewares/rate-limit.middleware';

const bookingsRouter = Router();

bookingsRouter.post('/bookings', attachAuthIfPresent, bookingCreateRateLimit, async (req, res, next) => {
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

bookingsRouter.post(
  '/bookings/:bookingId/payment-order',
  requireAuth,
  paymentRateLimit,
  requireBookingAccess,
  async (req, res, next) => {
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

bookingsRouter.get(
  '/bookings/:bookingId/payment-summary',
  requireAuth,
  requireBookingAccess,
  async (req, res, next) => {
  try {
    const bookingId = Number(req.params.bookingId || 0);
    const result = await getBookingPaymentSummary({ booking_id: bookingId });
    return res.status(200).json({
      message: 'Payment summary loaded.',
      data: result,
    });
  } catch (error) {
    return next(error);
  }
});

bookingsRouter.get(
  '/bookings/:bookingId/activity',
  requireAuth,
  requireBookingAccess,
  async (req, res, next) => {
  try {
    const bookingId = Number(req.params.bookingId || 0);
    const result = await getBookingActivity({ booking_id: bookingId });
    return res.status(200).json({
      message: 'Activity loaded.',
      data: result,
    });
  } catch (error) {
    return next(error);
  }
});

bookingsRouter.post(
  '/bookings/:bookingId/balance-payment-order',
  requireAuth,
  paymentRateLimit,
  requireBookingAccess,
  async (req, res, next) => {
  try {
    const bookingId = Number(req.params.bookingId || req.body.booking_id || 0);
    const result = await createBookingBalancePaymentOrder({ booking_id: bookingId });
    return res.status(201).json({
      message: 'Balance payment order created successfully.',
      data: result,
    });
  } catch (error) {
    return next(error);
  }
});

bookingsRouter.post(
  '/bookings/:bookingId/payment-verify',
  requireAuth,
  paymentRateLimit,
  requireBookingAccess,
  async (req, res, next) => {
  try {
    const bookingId = Number(req.params.bookingId || req.body.booking_id || 0);
    const result = await verifyBookingPayment({
      booking_id: bookingId,
      gateway: req.body.gateway === 'square' ? 'square' : req.body.gateway === 'razorpay' ? 'razorpay' : undefined,
      razorpay_order_id: String(req.body.razorpay_order_id || ''),
      razorpay_payment_id: String(req.body.razorpay_payment_id || ''),
      razorpay_signature: String(req.body.razorpay_signature || ''),
      square_payment_token: String(req.body.square_payment_token || ''),
      square_idempotency_key: String(req.body.square_idempotency_key || ''),
      purpose: req.body.purpose === 'balance' ? 'balance' : undefined,
    });
    return res.status(200).json({
      message: 'Payment verified successfully.',
      data: result,
    });
  } catch (error) {
    return next(error);
  }
});

bookingsRouter.post(
  '/bookings/:bookingId/payment-status',
  requireAuth,
  paymentRateLimit,
  requireBookingAccess,
  async (req, res, next) => {
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

/** Holiday planner handoff — requires sign-in; never shown as a form submit in the UI. */
bookingsRouter.post('/planner/enquiry', requireAuth, async (req, res, next) => {
  try {
    const result = await createPlannerLead({
      ...req.body,
      user_id: req.auth!.userId,
      name: req.body?.name ?? req.auth!.fullName,
      phone: req.body?.phone ?? req.auth!.phone,
      email: req.body?.email ?? req.auth!.email,
      ip_address: req.ip,
      user_agent: req.get('user-agent') || '',
    });
    return res.status(201).json({
      message: 'Planner enquiry recorded.',
      data: result,
    });
  } catch (error) {
    return next(error);
  }
});

export { bookingsRouter };

