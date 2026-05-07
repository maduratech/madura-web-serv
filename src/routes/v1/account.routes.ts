import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.middleware';
import {
  fetchBookingsForUser,
  fetchCrmHistoryForPhone,
  fetchEnquiriesForUser,
  updateProfileAndSyncToCrm,
} from '../../services/account.service';

const accountRouter = Router();

/** GET /api/v1/account/me — basic auth check + profile snapshot. */
accountRouter.get('/account/me', requireAuth, async (req, res) => {
  return res.status(200).json({
    data: {
      user_id: req.auth!.userId,
      email: req.auth!.email,
      full_name: req.auth!.fullName,
      phone: req.auth!.phone,
      avatar_url: req.auth!.avatarUrl,
      crm_customer_id: req.auth!.crmCustomerId,
    },
  });
});

/** GET /api/v1/account/bookings — paid + pending bookings for the signed-in user. */
accountRouter.get('/account/bookings', requireAuth, async (req, res, next) => {
  try {
    const data = await fetchBookingsForUser(req.auth!.userId);
    return res.status(200).json({ data });
  } catch (err) {
    return next(err);
  }
});

/** GET /api/v1/account/enquiries — website-side enquiries for this user (CRM history is separate). */
accountRouter.get('/account/enquiries', requireAuth, async (req, res, next) => {
  try {
    const data = await fetchEnquiriesForUser(req.auth!.userId);
    return res.status(200).json({ data });
  } catch (err) {
    return next(err);
  }
});

/** GET /api/v1/account/crm-history — leads/queries from the CRM keyed by user's phone. */
accountRouter.get('/account/crm-history', requireAuth, async (req, res, next) => {
  try {
    const phone = String(req.auth!.phone || '').trim();
    if (!phone) {
      return res.status(200).json({
        data: { customer: null, leads: [] },
        message:
          'Phone is missing on your profile. Add it under My Account to see your CRM history.',
      });
    }
    const data = await fetchCrmHistoryForPhone(phone);
    return res.status(200).json({ data });
  } catch (err) {
    return next(err);
  }
});

/** POST /api/v1/account/profile — update local profile and push the change to CRM. */
accountRouter.post('/account/profile', requireAuth, async (req, res, next) => {
  try {
    const patch = req.body || {};
    const result = await updateProfileAndSyncToCrm(req.auth!, {
      full_name: typeof patch.full_name === 'string' ? patch.full_name : undefined,
      phone: typeof patch.phone === 'string' ? patch.phone : undefined,
      avatar_url: typeof patch.avatar_url === 'string' ? patch.avatar_url : undefined,
    });
    return res.status(200).json({ data: result });
  } catch (err) {
    return next(err);
  }
});

export { accountRouter };
