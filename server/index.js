'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const QRCode = require('qrcode');
const { createGateway, createTokenAuth, lanAddresses } = require('./gateway');
const { AuthStore } = require('./auth-store');
const { AuditLog } = require('./audit-log');
const { PairingService } = require('./pairing');

const ROOT = path.join(__dirname, '..');

/**
 * Where device trust, audit log and the pairing QR live.
 * - Development checkout (has .git or an existing .data): keep `<repo>/.data`
 *   so existing setups keep their paired devices.
 * - Global npm install: the package directory is disposable (wiped on
 *   upgrade), so persist under the user profile instead.
 * - CODEX_REMOTE_DATA_DIR always wins.
 */
function defaultDataDir({
  env = process.env,
  rootDir = ROOT,
  homedir = os.homedir,
} = {}) {
  if (env.CODEX_REMOTE_DATA_DIR) return path.resolve(env.CODEX_REMOTE_DATA_DIR);
  if (fs.existsSync(path.join(rootDir, '.data')) || fs.existsSync(path.join(rootDir, '.git'))) {
    return path.join(rootDir, '.data');
  }
  return path.join(homedir(), '.codex-remote');
}

const DATA_DIR = defaultDataDir();

function loadOrCreateToken({ env = process.env, dataDir = DATA_DIR } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const tokenFile = path.join(dataDir, 'token');
  let token = env.CODEX_REMOTE_TOKEN || '';
  if (!token) {
    try {
      token = fs.readFileSync(tokenFile, 'utf8').trim();
    } catch {}
  }
  if (!token) {
    token = crypto.randomBytes(24).toString('base64url');
    fs.writeFileSync(tokenFile, token);
  }
  return token;
}

function createProductionSecurity({
  env = process.env,
  dataDir = DATA_DIR,
  clock = Date.now,
  randomBytes = crypto.randomBytes,
  bootstrapToken: bootstrapTokenOverride = '',
} = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const authStore = new AuthStore({
    filePath: path.join(dataDir, 'auth.json'),
    clock,
    randomBytes,
  });
  const audit = new AuditLog({
    filePath: path.join(dataDir, 'audit.jsonl'),
    clock,
  });
  const tokenFile = path.join(dataDir, 'token');
  const pairFile = path.join(dataDir, 'pair.png');
  let bootstrapToken = '';
  if (!authStore.hasOwner() && !authStore.isBootstrapMigrated()) {
    bootstrapToken = bootstrapTokenOverride || loadOrCreateToken({ env, dataDir });
  } else if (authStore.hasOwner() && !authStore.hasActiveOwnerSession()) {
    const recoveryAt = Number(typeof clock === 'function' ? clock() : clock.now());
    audit.record({
      actorDeviceId: 'local-console',
      action: 'device.owner-recovery',
      resource: 'owner',
      result: 'issued',
      correlationId: `recovery_${recoveryAt}`,
      risk: 'high',
    }, { critical: true });
    bootstrapToken = authStore.createRecoveryInvite({ ttlMs: 5 * 60_000 }).code;
    try { fs.unlinkSync(tokenFile); } catch {}
    try { fs.unlinkSync(pairFile); } catch {}
  } else {
    try { fs.unlinkSync(tokenFile); } catch {}
    try { fs.unlinkSync(pairFile); } catch {}
  }
  const deviceAuth = new PairingService({
    store: authStore,
    legacyToken: bootstrapToken,
    audit,
    clock,
    randomBytes,
    onLegacyConsumed() {
      try { fs.unlinkSync(tokenFile); } catch {}
      try { fs.unlinkSync(pairFile); } catch {}
    },
  });
  return {
    audit,
    authStore,
    bootstrapToken,
    deviceAuth,
  };
}

async function printStartup({
  token,
  port,
  dataDir = DATA_DIR,
  addresses = lanAddresses(),
  qrCode = QRCode,
  logger = console,
} = {}) {
  const lines = [
    '',
    '  ██████╗ ██████╗ ██████╗ ███████╗██╗  ██╗    Codex Remote',
    '  ██╔═══╝ ██╔══██╗██╔══██╗██╔════╝╚██╗██╔╝    手机远程控制 Codex CLI',
    '  ██║     ██║  ██║██║  ██║█████╗   ╚███╔╝ ',
    '  ██║     ██║  ██║██║  ██║██╔══╝   ██╔██╗ ',
    `  ╚██████╗╚██████╔╝██████╔╝███████╗██╔╝╚██╗   http://localhost:${port}`,
    '   ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝',
    '',
  ];
  logger.log(lines.join('\n'));
  if (token) {
    logger.log('  一次性 Owner 配对 / 恢复码:', token);
    logger.log('');
  } else {
    logger.log('  Owner 设备已配对；请从设备管理创建新的短时邀请。');
    logger.log('');
  }

  for (const ip of token ? addresses : []) {
    const url = `http://${ip}:${port}/#token=${token}`;
    logger.log(`  手机扫码直连  ${url}`);
    try {
      logger.log(await qrCode.toString(url, { type: 'terminal', small: true }));
    } catch {}
  }

  if (token && addresses.length) {
    const output = path.join(dataDir, 'pair.png');
    try {
      await qrCode.toFile(
        output,
        `http://${addresses[0]}:${port}/#token=${token}`,
        { type: 'png', width: 480, margin: 2 },
      );
      logger.log(`  二维码图片已保存：${output}`);
    } catch {}
  } else {
    logger.log('  未检测到局域网 IPv4 地址，请检查网络。');
  }
  logger.log('  （手机与电脑需在同一局域网；外网访问请配合 Tailscale / frp 等，详见 README）');
}

async function main(options = {}) {
  const env = options.env || process.env;
  const port = Number(options.port ?? env.PORT ?? 7860);
  const host = options.host || env.HOST || '0.0.0.0';
  const dataDir = options.dataDir || defaultDataDir({ env });
  const security = options.deviceAuth
    ? {
        deviceAuth: options.deviceAuth,
        bootstrapToken: options.token || '',
      }
    : createProductionSecurity({
        env,
        dataDir,
        clock: options.authClock || (() => Date.now()),
        randomBytes: options.randomBytes || crypto.randomBytes,
        bootstrapToken: options.token || '',
      });
  const token = security.bootstrapToken;
  const ownsBridge = !options.bridge;
  const ownsTerminals = !options.terminals;
  const bridge = options.bridge
    || (options.createBridge
      ? options.createBridge()
      : new (require('./codex').CodexBridge)(options.bridgeOptions));
  const terminals = options.terminals
    || (options.createTerminals
      ? options.createTerminals()
      : new (require('./terminals').TerminalManager)(options.terminalOptions));
  const getAddresses = options.lanAddresses || lanAddresses;
  const gatewayFactory = options.gatewayFactory || createGateway;
  const printStartupFn = options.printStartupFn || printStartup;
  let gateway = null;

  try {
    gateway = gatewayFactory({
      ...(options.gatewayOptions || {}),
      rootDir: options.rootDir || ROOT,
      port,
      host,
      bridge,
      terminals,
      ownsBridge,
      ownsTerminals,
      auth: options.auth || createTokenAuth(token),
      deviceAuth: security.deviceAuth,
      policy: options.policy,
      clock: options.clock,
      lanAddresses: getAddresses,
    });
    if (options.startBridge !== false) Promise.resolve(bridge.start()).catch(() => {});
    await gateway.listen({ port, host });
    const address = gateway.server.address();
    const listeningPort = address && typeof address === 'object' ? address.port : port;
    if (options.printBanner !== false) {
      await printStartupFn({
        token,
        port: listeningPort,
        dataDir,
        addresses: getAddresses(),
        qrCode: options.qrCode || QRCode,
        logger: options.logger || console,
      });
    }
    return gateway;
  } catch (error) {
    if (gateway?.close) {
      try { await gateway.close(); } catch {}
    } else {
      if (ownsBridge) {
        const disposeBridge = bridge.dispose || bridge.stop;
        if (typeof disposeBridge === 'function') {
          try { await disposeBridge.call(bridge); } catch {}
        }
      }
      if (ownsTerminals) {
        const disposeTerminals = terminals.dispose || terminals.stop;
        if (typeof disposeTerminals === 'function') {
          try { await disposeTerminals.call(terminals); } catch {}
        }
      }
    }
    throw error;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Codex Remote 启动失败：', error);
    process.exitCode = 1;
  });
}

module.exports = {
  DATA_DIR,
  ROOT,
  createProductionSecurity,
  defaultDataDir,
  loadOrCreateToken,
  main,
  printStartup,
};
