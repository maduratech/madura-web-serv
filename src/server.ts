import 'dotenv/config';
import { app as expressApp } from './app';

const port = parseInt(process.env.PORT || '4000', 10);

expressApp.listen(port, () => {
  console.log(`travel-api ready on http://localhost:${port}`);
});
