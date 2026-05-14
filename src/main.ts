import { RccDaemon } from './services/rccDaemon.js';
import { loadSetupFile } from './services/setupLoader.js';
import dns from 'node:dns';

loadSetupFile();

// Fix common "fetch failed (connect timeout)" issues on networks with broken IPv6 routing.
// Can be disabled by setting RCC_DNS_ORDER=verbatim.
if ((process.env.RCC_DNS_ORDER ?? 'ipv4first').toLowerCase() === 'ipv4first') {
  dns.setDefaultResultOrder('ipv4first');
}

const daemon = new RccDaemon();

const bootstrap = async (): Promise<void> => {
  await daemon.start();

  process.on('SIGINT', () => {
    daemon.stop();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    daemon.stop();
    process.exit(0);
  });

  if (process.env.RCC_SEED_PROJECT_ID && process.env.RCC_SEED_PROJECT_NAME && process.env.RCC_SEED_PROJECT_ROOT) {
    daemon.sessionRegistry.registerProject({
      id: process.env.RCC_SEED_PROJECT_ID,
      name: process.env.RCC_SEED_PROJECT_NAME,
      rootPath: process.env.RCC_SEED_PROJECT_ROOT,
      defaultModel: process.env.RCC_SEED_PROJECT_MODEL,
      defaultEffort: process.env.RCC_SEED_PROJECT_EFFORT as 'low' | 'medium' | 'high' | undefined,
    });
  }
};

void bootstrap();
