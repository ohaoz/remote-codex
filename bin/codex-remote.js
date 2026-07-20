#!/usr/bin/env node
'use strict';

/**
 * codex-remote — one-command launcher for the phone remote-control gateway.
 *
 *   codex-remote            start the gateway (prints pairing QR on first run)
 *   codex-remote start      same as above
 *   codex-remote qr         re-print the pairing QR of a not-yet-paired gateway
 *   codex-remote --help     usage
 *
 * Designed for `npm install -g` / `npx`: no repository checkout required.
 * Device trust state lives in ~/.codex-remote (or CODEX_REMOTE_DATA_DIR).
 */

const fs = require('node:fs');
const path = require('node:path');
const { defaultDataDir, main, printStartup } = require('../server/index');
const { lanAddresses } = require('../server/gateway');

function usage() {
  console.log(`
codex-remote — 手机远程控制本机 Codex CLI

用法:
  codex-remote [start]        启动网关（默认端口 7860），终端打印配对二维码
  codex-remote qr             服务未配对时，重新打印 Owner 配对二维码
  codex-remote --help         显示本帮助

常用环境变量:
  PORT                    监听端口（默认 7860）
  HOST                    监听地址（默认 0.0.0.0）
  CODEX_REMOTE_DATA_DIR   设备信任状态目录（默认 ~/.codex-remote）

首次启动会打印「一次性 Owner 配对码」二维码；第一台扫码的手机成为
Owner 设备，之后给其他设备授权请在手机「状态 → 分享接入」里创建邀请。
`.trim());
}

async function reprintQr() {
  const dataDir = defaultDataDir();
  const tokenFile = path.join(dataDir, 'token');
  let token = '';
  try {
    token = fs.readFileSync(tokenFile, 'utf8').trim();
  } catch {}
  if (!token) {
    console.log('没有待使用的 Owner 配对码：要么尚未启动过（先运行 codex-remote），');
    console.log('要么 Owner 已配对（请在 Owner 手机「状态 → 分享接入」创建邀请，');
    console.log('或在所有会话失效后重启服务获取 5 分钟恢复码）。');
    process.exitCode = 1;
    return;
  }
  await printStartup({
    token,
    port: Number(process.env.PORT || 7860),
    dataDir,
    addresses: lanAddresses(),
  });
}

async function run() {
  const [command = 'start'] = process.argv.slice(2);
  if (command === '--help' || command === '-h' || command === 'help') {
    usage();
    return;
  }
  if (command === 'qr') {
    await reprintQr();
    return;
  }
  if (command !== 'start') {
    console.error(`未知命令: ${command}\n`);
    usage();
    process.exitCode = 1;
    return;
  }
  await main();
}

run().catch((error) => {
  console.error('codex-remote 启动失败：', error.message || error);
  process.exitCode = 1;
});
