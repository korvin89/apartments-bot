#!/usr/bin/env node
// Turns a VLESS share link (vless://...) into an Xray client config with a local
// SOCKS5 proxy on 127.0.0.1:1080, the address HALOOGLASI_PROXY points to.
// The link holds the VPN credentials: the config is written with mode 600 and nothing
// secret is printed.
// Usage: node scripts/xray-config.mjs <file with the vless:// link> [out, default data/xray.json]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const [keyFile, outFile = 'data/xray.json'] = process.argv.slice(2);
if (!keyFile) {
  console.error('Usage: node scripts/xray-config.mjs <file with the vless:// link> [out]');
  process.exit(1);
}

const link = new URL(readFileSync(keyFile, 'utf8').trim());
const q = link.searchParams;
const security = q.get('security') ?? 'none';
const network = q.get('type') ?? 'tcp';
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};
if (link.protocol !== 'vless:') fail(`Only vless:// links are supported, got ${link.protocol}`);
if (network !== 'tcp') fail(`Only type=tcp is supported, got ${network}`);
if (!['reality', 'tls', 'none'].includes(security)) fail(`Unsupported security=${security}`);

const streamSettings = { network, security };
if (security === 'reality') {
  streamSettings.realitySettings = {
    serverName: q.get('sni') ?? '',
    fingerprint: q.get('fp') ?? 'chrome',
    publicKey: q.get('pbk') ?? '',
    shortId: q.get('sid') ?? '',
    spiderX: q.get('spx') ?? '',
  };
} else if (security === 'tls') {
  streamSettings.tlsSettings = { serverName: q.get('sni') ?? link.hostname, fingerprint: q.get('fp') ?? 'chrome' };
}

const config = {
  log: { loglevel: 'warning' },
  inbounds: [{ listen: '127.0.0.1', port: 1080, protocol: 'socks', settings: { udp: false } }],
  outbounds: [
    {
      protocol: 'vless',
      settings: {
        vnext: [
          {
            address: link.hostname,
            port: Number(link.port || 443),
            users: [{ id: decodeURIComponent(link.username), encryption: q.get('encryption') ?? 'none', flow: q.get('flow') ?? '' }],
          },
        ],
      },
      streamSettings,
    },
  ],
};

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
console.log(`Wrote ${outFile}: ${link.hostname}:${link.port || 443}, ${security}/${network} (${decodeURIComponent(link.hash.slice(1))})`);
