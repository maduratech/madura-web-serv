import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.middleware';
import {
  buildAccountMeForUser,
  CUSTOMER_DOCUMENT_TYPES,
  deleteAccountDocument,
  fetchAccountDocumentFile,
  fetchAccountDocuments,
  fetchBookingsForUser,
  fetchCrmHistoryForProfile,
  fetchEnquiriesForUser,
  updateProfileAndSyncToCrm,
  uploadAccountDocument,
  type CustomerDocumentType,
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

/** GET /api/v1/account/documents — CRM customer documents (metadata only). */
accountRouter.get('/account/documents', requireAuth, async (req, res, next) => {
  try {
    const data = await fetchAccountDocuments(req.auth!);
    return res.status(200).json({ data });
  } catch (err) {
    return next(err);
  }
});

/** POST /api/v1/account/documents — upload a document to the linked CRM customer. */
accountRouter.post('/account/documents', requireAuth, async (req, res, next) => {
  try {
    const body = req.body || {};
    const docType = String(body.doc_type || '').trim() as CustomerDocumentType;
    if (!CUSTOMER_DOCUMENT_TYPES.includes(docType)) {
      return res.status(400).json({ message: 'Invalid document type.' });
    }
    const file = body.file || {};
    const name = typeof file.name === 'string' ? file.name.trim() : '';
    const type = typeof file.type === 'string' ? file.type.trim() : '';
    const size = Number(file.size) || 0;
    const content = typeof file.content === 'string' ? file.content.trim() : '';
    if (!name || !content) {
      return res.status(400).json({ message: 'File name and content are required.' });
    }
    const data = await uploadAccountDocument(req.auth!, {
      doc_type: docType,
      file: { name, type, size, content },
      label: typeof body.label === 'string' ? body.label.trim() : undefined,
      notes: typeof body.notes === 'string' ? body.notes.trim() : undefined,
    });
    return res.status(201).json({ data });
  } catch (err) {
    return next(err);
  }
});

/** GET /api/v1/account/documents/:docType/:docId/view — stream document for in-app preview. */
accountRouter.get('/account/documents/:docType/:docId/view', requireAuth, async (req, res, next) => {
  try {
    const docType = String(req.params.docType || '').trim() as CustomerDocumentType;
    const docId = String(req.params.docId || '').trim();
    if (!CUSTOMER_DOCUMENT_TYPES.includes(docType) || !docId) {
      return res.status(400).json({ message: 'Invalid document reference.' });
    }
    const file = await fetchAccountDocumentFile(req.auth!, docType, docId);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(file.fileName)}"`
    );
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).send(file.buffer);
  } catch (err) {
    return next(err);
  }
});

/** DELETE /api/v1/account/documents/:docType/:docId — remove a website-uploaded document. */
accountRouter.delete('/account/documents/:docType/:docId', requireAuth, async (req, res, next) => {
  try {
    const docType = String(req.params.docType || '').trim() as CustomerDocumentType;
    const docId = String(req.params.docId || '').trim();
    if (!CUSTOMER_DOCUMENT_TYPES.includes(docType) || !docId) {
      return res.status(400).json({ message: 'Invalid document reference.' });
    }
    await deleteAccountDocument(req.auth!, docType, docId);
    return res.status(200).json({ ok: true });
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
