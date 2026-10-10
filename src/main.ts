import { registerConfiguredProjects, skipAutoDiscoveryWhenConfigured } from './services/configuredProjects.js';
import { RccDaemon } from './services/rccDaemon.js';
import { loadSetupFile } from './services/setupLoader.js';
import dns from 'node:dns';

loadSetupFile();

// Prefer IPv4 addresses. Networks with broken IPv6 routing otherwise cause fetch connect timeouts.
// Set RCC_DNS_ORDER=verbatim to keep the system order.
if ((process.env.RCC_DNS_ORDER ?? 'ipv4first').toLowerCase() === 'ipv4first') {
  dns.setDefaultResultOrder('ipv4first');
}

// The config reads the discovery limit when the daemon is created, so this must run first.
skipAutoDiscoveryWhenConfigured(process.env);

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

  const configured = registerConfiguredProjects(daemon.sessionRegistry, process.env.RCC_PROJECT_ROOTS);
  for (const entry of configured.skipped) {
    console.warn(`RCC_PROJECT_ROOTS: skipped ${entry} because it is not a folder.`);
  }
};

void bootstrap();
