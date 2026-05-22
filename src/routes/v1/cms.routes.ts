import { Router } from 'express';
import { loadAuthFromHeader } from '../../middlewares/auth.middleware';
import { requireCmsAuth, requireSuperAdmin } from '../../middlewares/cms-auth.middleware';
import {
  createDestination,
  createTour,
  deleteDestination,
  deleteTour,
  getCmsStaffByUserId,
  getDestination,
  getTour,
  listCmsStaff,
  listDestinations,
  listTours,
  removeCmsStaff,
  setCmsStaffActive,
  updateDestination,
  updateTour,
  upsertCmsStaff,
} from '../../services/cms.service';
import { searchStockImages, uploadCmsMedia } from '../../services/cms-media.service';

export const cmsRouter = Router();

cmsRouter.get('/me', async (req, res, next) => {
  try {
    const base = await loadAuthFromHeader(req);
    if (!base) {
      res.json({ is_staff: false, role: null });
      return;
    }
    const staff = await getCmsStaffByUserId(base.userId);
    if (!staff || !staff.is_active) {
      res.json({ is_staff: false, role: null, email: base.email });
      return;
    }
    res.json({
      is_staff: true,
      role: staff.role,
      email: staff.email,
      full_name: staff.full_name,
      user_id: staff.id,
    });
  } catch (err) {
    next(err);
  }
});

cmsRouter.use(requireCmsAuth);

cmsRouter.get('/destinations', async (_req, res, next) => {
  try {
    res.json({ items: await listDestinations() });
  } catch (err) {
    next(err);
  }
});

cmsRouter.get('/destinations/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const row = await getDestination(id);
    if (!row) {
      res.status(404).json({ message: 'Destination not found.' });
      return;
    }
    res.json(row);
  } catch (err) {
    next(err);
  }
});

cmsRouter.post('/destinations', async (req, res, next) => {
  try {
    const row = await createDestination(req.body || {});
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

cmsRouter.patch('/destinations/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const row = await updateDestination(id, req.body || {});
    res.json(row);
  } catch (err) {
    next(err);
  }
});

cmsRouter.delete('/destinations/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    await deleteDestination(id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

cmsRouter.get('/tours', async (_req, res, next) => {
  try {
    res.json({ items: await listTours() });
  } catch (err) {
    next(err);
  }
});

cmsRouter.get('/tours/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const row = await getTour(id);
    if (!row) {
      res.status(404).json({ message: 'Tour not found.' });
      return;
    }
    res.json(row);
  } catch (err) {
    next(err);
  }
});

cmsRouter.post('/tours', async (req, res, next) => {
  try {
    const row = await createTour(req.body || {});
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

cmsRouter.patch('/tours/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const row = await updateTour(id, req.body || {});
    res.json(row);
  } catch (err) {
    next(err);
  }
});

cmsRouter.delete('/tours/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    await deleteTour(id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

cmsRouter.post('/media/upload', async (req, res, next) => {
  try {
    const { file_base64, mime_type, filename } = req.body || {};
    const result = await uploadCmsMedia({
      base64: file_base64,
      mime_type,
      filename,
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

cmsRouter.get('/stock-images', async (req, res, next) => {
  try {
    const query = String(req.query.q || req.query.query || '').trim();
    const page = Math.max(1, Number(req.query.page || 1));
    const result = await searchStockImages(query, page);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

cmsRouter.get('/staff', requireSuperAdmin, async (_req, res, next) => {
  try {
    res.json({ items: await listCmsStaff() });
  } catch (err) {
    next(err);
  }
});

cmsRouter.post('/staff', requireSuperAdmin, async (req, res, next) => {
  try {
    const { email, full_name, role } = req.body || {};
    if (!email || !role) {
      res.status(400).json({ message: 'email and role are required.' });
      return;
    }
    if (role !== 'staff' && role !== 'super_admin') {
      res.status(400).json({ message: 'role must be staff or super_admin.' });
      return;
    }
    const row = await upsertCmsStaff({ email, full_name, role });
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

cmsRouter.patch('/staff/:id', requireSuperAdmin, async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const { is_active } = req.body || {};
    if (typeof is_active !== 'boolean') {
      res.status(400).json({ message: 'is_active (boolean) is required.' });
      return;
    }
    await setCmsStaffActive(id, is_active);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

cmsRouter.delete('/staff/:id', requireSuperAdmin, async (req, res, next) => {
  try {
    const id = String(req.params.id);
    if (id === req.cmsAuth?.userId) {
      res.status(400).json({ message: 'You cannot remove your own CMS access.' });
      return;
    }
    await removeCmsStaff(id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
