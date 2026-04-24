import { Router } from 'express';
import { v1Router } from './v1';

const apiRouter = Router();

apiRouter.use(v1Router);

export { apiRouter };
