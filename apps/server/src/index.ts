import '../../../packages/shared/src/env.js';
import { createService } from './service.js';
const service = await createService();
service.app.listen(4021, '127.0.0.1', () => console.log('A2A specialist on http://127.0.0.1:4021'));
