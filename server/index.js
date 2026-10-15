import 'dotenv/config';
import { createApp } from './app.js';

const app = await createApp();
const port = Number(process.env.PORT || 3001);
app.listen(port, '127.0.0.1', () => console.log(`ResearchLens API: http://127.0.0.1:${port}`));
