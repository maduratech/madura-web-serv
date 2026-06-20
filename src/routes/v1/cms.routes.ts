import { Router } from 'express';
import { loadAuthFromHeader } from '../../middlewares/auth.middleware';
import {
  assertStaffMayMutate,
  requireCmsAuth,
  requireSuperAdmin,
} from '../../middlewares/cms-auth.middleware';
import {
  createDestination,
  createTour,
  deleteDestination,
  duplicateDestination,
  duplicateTour,
  deleteTour,
  getCmsStaffByUserId,
  getDestination,
  getTour,
  createManagedUser,
  listWebsiteUsers,
  listDestinations,
  listTours,
  removeCmsStaff,
  setWebsiteUserActive,
  updateDestination,
  updateTour,
  upsertCmsStaff,
  updateManagedUser,
} from '../../services/cms.service';
import {
  addTourTaxonomy,
  deleteTourTaxonomy,
  getTourTaxonomyById,
  listTourTaxonomy,
  parseTourTaxonomyKindParam,
  updateTourTaxonomy,
} from '../../services/cms-taxonomy.service';
import {
  addSidebarBadge,
  deleteSidebarBadge,
  listSidebarBadgesWithUsage,
} from '../../services/cms-sidebar-badge.service';
import {
  createBlogPost,
  deleteBlogPost,
  duplicateBlogPost,
  getBlogPost,
  listBlogPosts,
  updateBlogPost,
} from '../../services/cms-blog.service';
import {
  createVisaPage,
  deleteVisaPage,
  duplicateVisaPage,
  getVisaPage,
  listVisaPages,
  updateVisaPage,
} from '../../services/cms-visa.service';
import {
  createHeaderMarquee,
  deleteHeaderMarquee,
  listHeaderMarqueeAll,
  reorderHeaderMarquee,
  updateHeaderMarquee,
} from '../../services/cms-header-marquee.service';

function clientError(res: import('express').Response, err: unknown) {
  const message = err instanceof Error ? err.message : 'Request failed.';
  res.status(400).json({ message, error: message });
}
import { listCmsOrders } from '../../services/cms-orders.service';
import { searchStockImages, searchStockVideos, uploadCmsMedia } from '../../services/cms-media.service';
import { listTourDepartures, replaceTourDepartures } from '../../services/cms-departures.service';
import { parseTourSupplierContentForCms } from '../../services/cms-ai.service';

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
    const body = (req.body || {}) as Record<string, unknown>;
    assertStaffMayMutate(req.cmsAuth!.role, body, 'destination');
    const row = await createDestination(body);
    res.status(201).json(row);
  } catch (err) {
    clientError(res, err);
  }
});

cmsRouter.patch('/destinations/:id', async (req, res, next) => {
  try {
    const body = (req.body || {}) as Record<string, unknown>;
    const id = Number(req.params.id);
    const existing = await getDestination(id);
    if (!existing) {
      res.status(404).json({ message: 'Destination not found.' });
      return;
    }
    assertStaffMayMutate(req.cmsAuth!.role, body, 'destination', {
      is_active: existing.is_active,
    });
    const row = await updateDestination(id, body);
    res.json(row);
  } catch (err) {
    clientError(res, err);
  }
});

cmsRouter.post('/destinations/:id/duplicate', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      clientError(res, new Error('Invalid destination id.'));
      return;
    }
    const row = await duplicateDestination(id);
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

cmsRouter.delete('/destinations/:id', requireSuperAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      clientError(res, new Error('Invalid destination id.'));
      return;
    }
    await deleteDestination(id);
    res.status(204).send();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to delete destination.';
    if (message.includes('not found')) {
      res.status(404).json({ message, error: message });
      return;
    }
    if (message.includes('Cannot delete') || message.includes('linked')) {
      res.status(409).json({ message, error: message });
      return;
    }
    if (message.includes('Invalid destination')) {
      clientError(res, err);
      return;
    }
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

cmsRouter.get('/orders', requireSuperAdmin, async (_req, res, next) => {
  try {
    res.json(await listCmsOrders());
  } catch (err) {
    next(err);
  }
});

cmsRouter.post('/tours/ai-parse-supplier', async (req, res, next) => {
  try {
    const { pastedText, context } = req.body || {};
    if (!pastedText || typeof pastedText !== 'string') {
      res.status(400).json({ message: 'pastedText is required.' });
      return;
    }
    const trimmed = pastedText.trim();
    if (trimmed.length < 15) {
      res.status(400).json({ message: 'Please paste more content before processing.' });
      return;
    }
    const result = await parseTourSupplierContentForCms({
      pastedText: trimmed,
      context: context && typeof context === 'object' ? context : undefined,
    });
    res.json(result);
  } catch (err) {
    clientError(res, err);
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

cmsRouter.post('/tours/:id/duplicate', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      clientError(res, new Error('Invalid tour id.'));
      return;
    }
    const row = await duplicateTour(id);
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

cmsRouter.delete('/tours/:id', requireSuperAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    await deleteTour(id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

cmsRouter.get('/tours/:id/departures', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    res.json({ items: await listTourDepartures(id) });
  } catch (err) {
    next(err);
  }
});

cmsRouter.put('/tours/:id/departures', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    res.json({ items: await replaceTourDepartures(id, items) });
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

cmsRouter.get('/stock-videos', async (req, res, next) => {
  try {
    const query = String(req.query.q || req.query.query || '').trim();
    const page = Math.max(1, Number(req.query.page || 1));
    const result = await searchStockVideos(query, page);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

cmsRouter.get('/staff', requireSuperAdmin, async (_req, res, next) => {
  try {
    res.json({ items: await listWebsiteUsers() });
  } catch (err) {
    next(err);
  }
});

cmsRouter.get('/users', requireSuperAdmin, async (_req, res, next) => {
  try {
    res.json({ items: await listWebsiteUsers() });
  } catch (err) {
    next(err);
  }
});

cmsRouter.post('/staff', requireSuperAdmin, async (req, res, next) => {
  try {
    const { email, full_name, role, password, account_type } = req.body || {};
    const emailNorm = String(email || '')
      .trim()
      .toLowerCase();
    if (!emailNorm) {
      res.status(400).json({ message: 'email is required.' });
      return;
    }

    const resolvedType =
      account_type === 'traveler' || account_type === 'staff' || account_type === 'super_admin'
        ? account_type
        : role === 'super_admin'
          ? 'super_admin'
          : role === 'staff'
            ? 'staff'
            : null;

    if (!resolvedType) {
      res.status(400).json({
        message: 'account_type must be traveler, staff, or super_admin.',
      });
      return;
    }

    if (resolvedType === 'traveler') {
      const row = await createManagedUser({
        email: emailNorm,
        full_name,
        password,
        account_type: 'traveler',
      });
      res.status(201).json(row);
      return;
    }

    const cmsRole = resolvedType === 'super_admin' ? 'super_admin' : 'staff';
    const row = await upsertCmsStaff({
      email: emailNorm,
      full_name,
      role: cmsRole,
      password,
    });
    res.status(201).json(row);
  } catch (err) {
    clientError(res, err);
  }
});

cmsRouter.patch('/staff/:id', requireSuperAdmin, async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const { is_active, full_name, phone, account_type, password } = req.body || {};

    const hasUpdate =
      typeof is_active === 'boolean' ||
      full_name !== undefined ||
      phone !== undefined ||
      account_type !== undefined ||
      (typeof password === 'string' && password.trim().length > 0);

    if (!hasUpdate) {
      res.status(400).json({
        message:
          'Provide at least one of: is_active, full_name, phone, account_type, password.',
      });
      return;
    }

    if (
      account_type !== undefined &&
      account_type !== 'traveler' &&
      account_type !== 'staff' &&
      account_type !== 'super_admin'
    ) {
      res.status(400).json({
        message: 'account_type must be traveler, staff, or super_admin.',
      });
      return;
    }

    const row = await updateManagedUser(
      id,
      {
        is_active: typeof is_active === 'boolean' ? is_active : undefined,
        full_name: full_name !== undefined ? full_name : undefined,
        phone: phone !== undefined ? phone : undefined,
        account_type:
          account_type === 'traveler' ||
          account_type === 'staff' ||
          account_type === 'super_admin'
            ? account_type
            : undefined,
        password: typeof password === 'string' ? password : undefined,
      },
      req.cmsAuth?.userId
    );
    res.json(row);
  } catch (err) {
    clientError(res, err);
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

cmsRouter.get('/tour-taxonomy/:kind', async (req, res, next) => {
  try {
    const kind = parseTourTaxonomyKindParam(String(req.params.kind));
    res.json({ items: await listTourTaxonomy(kind) });
  } catch (err) {
    clientError(res, err);
  }
});

cmsRouter.post('/tour-taxonomy/:kind', async (req, res, next) => {
  try {
    assertStaffMayMutate(req.cmsAuth!.role, req.body || {}, 'tour');
    const kind = parseTourTaxonomyKindParam(String(req.params.kind));
    const label = String((req.body as { label?: string })?.label || '');
    const row = await addTourTaxonomy(kind, label);
    res.status(201).json(row);
  } catch (err) {
    clientError(res, err);
  }
});

cmsRouter.delete('/tour-taxonomy/:id', async (req, res, next) => {
  try {
    assertStaffMayMutate(req.cmsAuth!.role, {}, 'tour');
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ message: 'Invalid id.' });
      return;
    }
    await deleteTourTaxonomy(id);
    res.status(204).send();
  } catch (err) {
    clientError(res, err);
  }
});

cmsRouter.get('/tour-taxonomy/item/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ message: 'Invalid id.' });
      return;
    }
    const row = await getTourTaxonomyById(id);
    if (!row) {
      res.status(404).json({ message: 'Not found.' });
      return;
    }
    res.json(row);
  } catch (err) {
    clientError(res, err);
  }
});

cmsRouter.patch('/tour-taxonomy/:id', async (req, res, next) => {
  try {
    assertStaffMayMutate(req.cmsAuth!.role, req.body || {}, 'tour');
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ message: 'Invalid id.' });
      return;
    }
    const body = req.body as { meta?: { description_in?: string; description_au?: string; banner_image_url?: string } };
    const row = await updateTourTaxonomy(id, { meta: body.meta });
    res.json(row);
  } catch (err) {
    clientError(res, err);
  }
});

cmsRouter.get('/sidebar-badges', async (_req, res, next) => {
  try {
    res.json({ items: await listSidebarBadgesWithUsage() });
  } catch (err) {
    next(err);
  }
});

cmsRouter.post('/sidebar-badges', async (req, res, next) => {
  try {
    assertStaffMayMutate(req.cmsAuth!.role, req.body || {}, 'tour');
    const label = String((req.body as { label?: string })?.label || '');
    const row = await addSidebarBadge(label);
    res.status(201).json(row);
  } catch (err) {
    clientError(res, err);
  }
});

cmsRouter.delete('/sidebar-badges/:id', async (req, res, next) => {
  try {
    assertStaffMayMutate(req.cmsAuth!.role, {}, 'tour');
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ message: 'Invalid id.' });
      return;
    }
    await deleteSidebarBadge(id);
    res.status(204).send();
  } catch (err) {
    clientError(res, err);
  }
});

cmsRouter.get('/header-marquee', async (_req, res, next) => {
  try {
    res.json({ items: await listHeaderMarqueeAll() });
  } catch (err) {
    next(err);
  }
});

cmsRouter.post('/header-marquee', async (req, res, next) => {
  try {
    assertStaffMayMutate(req.cmsAuth!.role, req.body || {}, 'tour');
    const text = String((req.body as { text?: string })?.text || '');
    const row = await createHeaderMarquee(text);
    res.status(201).json(row);
  } catch (err) {
    clientError(res, err);
  }
});

cmsRouter.patch('/header-marquee/:id', async (req, res, next) => {
  try {
    assertStaffMayMutate(req.cmsAuth!.role, req.body || {}, 'tour');
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ message: 'Invalid id.' });
      return;
    }
    const body = (req.body || {}) as {
      text?: string;
      is_active?: boolean;
      sort_order?: number;
    };
    const row = await updateHeaderMarquee(id, body);
    res.json(row);
  } catch (err) {
    clientError(res, err);
  }
});

cmsRouter.post('/header-marquee/reorder', async (req, res, next) => {
  try {
    assertStaffMayMutate(req.cmsAuth!.role, req.body || {}, 'tour');
    const ids = Array.isArray((req.body as { ids?: unknown })?.ids)
      ? ((req.body as { ids: unknown[] }).ids as unknown[])
      : [];
    const items = await reorderHeaderMarquee(ids.map((id) => Number(id)));
    res.json({ items });
  } catch (err) {
    clientError(res, err);
  }
});

cmsRouter.delete('/header-marquee/:id', async (req, res, next) => {
  try {
    assertStaffMayMutate(req.cmsAuth!.role, {}, 'tour');
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ message: 'Invalid id.' });
      return;
    }
    await deleteHeaderMarquee(id);
    res.status(204).send();
  } catch (err) {
    clientError(res, err);
  }
});

cmsRouter.get('/blogs', async (_req, res, next) => {
  try {
    res.json({ items: await listBlogPosts() });
  } catch (err) {
    next(err);
  }
});

cmsRouter.get('/blogs/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const row = await getBlogPost(id);
    if (!row) {
      res.status(404).json({ message: 'Blog post not found.' });
      return;
    }
    res.json(row);
  } catch (err) {
    next(err);
  }
});

cmsRouter.post('/blogs', async (req, res, next) => {
  try {
    const body = (req.body || {}) as Record<string, unknown>;
    const row = await createBlogPost(body);
    res.status(201).json(row);
  } catch (err) {
    clientError(res, err);
  }
});

cmsRouter.patch('/blogs/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const body = (req.body || {}) as Record<string, unknown>;
    const row = await updateBlogPost(id, body);
    res.json(row);
  } catch (err) {
    clientError(res, err);
  }
});

cmsRouter.post('/blogs/:id/duplicate', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      clientError(res, new Error('Invalid blog post id.'));
      return;
    }
    const row = await duplicateBlogPost(id);
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

cmsRouter.delete('/blogs/:id', requireSuperAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      clientError(res, new Error('Invalid blog post id.'));
      return;
    }
    await deleteBlogPost(id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

cmsRouter.get('/visas', async (_req, res, next) => {
  try {
    res.json({ items: await listVisaPages() });
  } catch (err) {
    next(err);
  }
});

cmsRouter.get('/visas/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const row = await getVisaPage(id);
    if (!row) {
      res.status(404).json({ message: 'Visa page not found.' });
      return;
    }
    res.json(row);
  } catch (err) {
    next(err);
  }
});

cmsRouter.post('/visas', async (req, res, next) => {
  try {
    const body = (req.body || {}) as Record<string, unknown>;
    const row = await createVisaPage(body);
    res.status(201).json(row);
  } catch (err) {
    clientError(res, err);
  }
});

cmsRouter.patch('/visas/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const body = (req.body || {}) as Record<string, unknown>;
    const row = await updateVisaPage(id, body);
    res.json(row);
  } catch (err) {
    clientError(res, err);
  }
});

cmsRouter.post('/visas/:id/duplicate', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      clientError(res, new Error('Invalid visa page id.'));
      return;
    }
    const row = await duplicateVisaPage(id);
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

cmsRouter.delete('/visas/:id', requireSuperAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      clientError(res, new Error('Invalid visa page id.'));
      return;
    }
    await deleteVisaPage(id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
