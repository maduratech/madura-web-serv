import express from 'express';
import cors from 'cors';
import { apiRouter } from './routes';
import { errorMiddleware } from './middlewares/error.middleware';
import { loggerMiddleware } from './middlewares/logger.middleware';

const app = express();

app.use(cors());
app.use(express.json());
app.use(loggerMiddleware);

app.use('/api/v1', apiRouter);

app.use(errorMiddleware);

export { app };
