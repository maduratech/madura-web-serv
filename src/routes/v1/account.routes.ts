import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.middleware';
import {
  buildAccountMeForUser,
  fetchBookingsForUser,
  fetchCrmHistoryForProfile,
  fetchEnquiriesForUser,
  updateProfileAndSyncToCrm,
} from '../../services/account.service';

const accountRouter = Router();

/** GET /api/v1/account/me — auth check + profile merged with CRM when configured. */
accountRouter.get('/account/me', requireAuth, async (req, res, next) => {
  try {
    const data = await buildAccountMeForUser(req.auth!);
    return res.status(200).json({ data });
  } catch (err) {
    return next(err);
  }
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

/** GET /api/v1/account/crm-history — leads from CRM: match by phone first, then login email. */
accountRouter.get('/account/crm-history', requireAuth, async (req, res, next) => {
  try {
    const phone = String(req.auth!.phone || '').trim();
    const email = String(req.auth!.email || '').trim();
    const data = await fetchCrmHistoryForProfile(phone, email);
    const message =
      !phone && !data.customer
        ? 'Add a phone on your profile for the strongest match. We also search by your login email.'
        : undefined;
    return res.status(200).json({ data, message });
  } catch (err) {
    return next(err);
  }
});

/** POST /api/v1/account/profile — update local profile and push the change to CRM. */
accountRouter.post('/account/profile', requireAuth, async (req, res, next) => {
  try {
    const patch = req.body || {};
    const pickStr = (k: string) =>
      typeof patch[k] === 'string' ? (patch[k] as string) : undefined;
    const result = await updateProfileAndSyncToCrm(req.auth!, {
      full_name: pickStr('full_name'),
      phone: pickStr('phone'),
      avatar_url: pickStr('avatar_url'),
      salutation: pickStr('salutation'),
      company: pickStr('company'),
      nationality: pickStr('nationality'),
      gst_number: pickStr('gst_number'),
      pan_number: pickStr('pan_number'),
      date_of_birth: pickStr('date_of_birth'),
      passport_number: pickStr('passport_number'),
      passport_expiry_date: pickStr('passport_expiry_date'),
      address_street: pickStr('address_street'),
      address_city: pickStr('address_city'),
      address_state: pickStr('address_state'),
      address_country: pickStr('address_country'),
      address_zip: pickStr('address_zip'),
    });
    return res.status(200).json({ data: result });
  } catch (err) {
    return next(err);
  }
});

export { accountRouter };
