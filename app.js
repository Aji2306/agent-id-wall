// Agent ID Wall — frontend (ethers v6, no build step).
// Reads the wall from BNB Chain (public RPC) and lets an Agent ID holder post
// through their own wallet. Nothing is ever signed automatically: the user
// confirms every transaction in their wallet.
//
// Name resolution (how a poster's Agent ID name is shown):
//   1. A local cache of names the user has verified on this device.
//   2. The SPACE ID Web3 Name API (reverse resolution, BNB Chain):
//        GET https://nameapi.space.id/getName?chainid=56&address=<addr>
//      Note (verified 2026-11-18): this API currently returns no name for
//      Agent ID (.ai) holders — it only returns a primary name when one is
//      set for a supported TLD. It is kept as the first network source
//      because it is the official reverse-resolution path and may start
//      returning .ai names as Agent ID indexing improves.
//   3. A label the poster verified on-chain themselves (see verifyLabel):
//      tokenId = keccak256(label); the registry must return ownerOf(tokenId)
//      == the poster's address, and tokenURI(tokenId) metadata must name the
//      same label. The contract never stores a name (it would be spoofable);
//      this is display-only and always verified against the registry.
//   4. Fallback: the truncated address (0x1234…abcd).
'use strict';

const CONFIG = {
  // Filled in after deployment. Until then the wall shows "not deployed yet"
  // and posting is disabled; reading still works once an address is set.
  WALL_ADDRESS: '0x8c83aa6854b20f8d90485275f32e62fb4751ec7f',
  REGISTRY_ADDRESS: '0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F',
  CHAIN_ID: 56,
  CHAIN_NAME: 'BNB Chain',
  RPC_URL: 'https://bsc-dataseed.bnbchain.org',
  PAGE_SIZE: 50,
  NAME_API: 'https://nameapi.space.id/getName?chainid=56&address=',
};

const WALL_ABI = [
  'function post(string calldata message) external',
  'function messageCount() external view returns (uint256)',
  'function getMessage(uint256 index) external view returns (address sender, string message, uint256 timestamp)',
  'function getMessages(uint256 start, uint256 count) external view returns (tuple(address sender, string message, uint256 timestamp)[])',
  'event MessagePosted(address indexed sender, string message, uint256 timestamp)',
];
const REGISTRY_ABI = [
  'function balanceOf(address owner) external view returns (uint256)',
  'function ownerOf(uint256 tokenId) external view returns (address)',
  'function tokenURI(uint256 tokenId) external view returns (string)',
];

const $ = (id) => document.getElementById(id);
const readProvider = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
let browserProvider = null;
let signer = null;
let account = null;
let wallRead = null;
let registryRead = null;

function shortAddr(a) {
  return a ? a.slice(0, 6) + '…' + a.slice(-4) : '';
}
function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function fmtTime(ts) {
  try { return new Date(Number(ts) * 1000).toLocaleString(); } catch { return ''; }
}

// ---- name resolution ----
const NAME_CACHE_KEY = 'agent-id-wall:names:v1';
function loadNameCache() {
  try { return JSON.parse(localStorage.getItem(NAME_CACHE_KEY) || '{}'); } catch { return {}; }
}
function saveNameCache(c) {
  try { localStorage.setItem(NAME_CACHE_KEY, JSON.stringify(c)); } catch { /* ignore */ }
}
async function resolveName(address) {
  const addr = address.toLowerCase();
  const cache = loadNameCache();
  if (cache[addr]) return cache[addr];
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(CONFIG.NAME_API + address, { signal: ctrl.signal });
    clearTimeout(t);
    const data = await res.json();
    const name = data && data.data && data.data.name;
    if (data && data.code === 0 && name) {
      cache[addr] = name;
      saveNameCache(cache);
      return name;
    }
  } catch { /* API unavailable: fall through to the address */ }
  return null;
}

// Verify that `label` (e.g. "mizzu") is really this address's Agent ID:
// tokenId = keccak256(label); registry.ownerOf(tokenId) must be the address,
// and tokenURI(tokenId) metadata must name the same label. Returns the
// display name ("mizzu.ai") or null.
async function verifyLabel(label, address) {
  const clean = (label || '').trim().toLowerCase().replace(/\.ai$/, '');
  if (!clean || !/^[a-z0-9-]{1,63}$/.test(clean)) return { ok: false, reason: 'Use your Agent ID label, e.g. mizzu (letters, digits, dashes).' };
  try {
    const tokenId = ethers.keccak256(ethers.toUtf8Bytes(clean));
    const owner = await registryRead.ownerOf(tokenId);
    if (owner.toLowerCase() !== address.toLowerCase()) {
      return { ok: false, reason: `The name ${clean}.ai is not owned by this address.` };
    }
    try {
      const uri = await registryRead.tokenURI(tokenId);
      const meta = await (await fetch(uri)).json();
      if (meta && meta.name && String(meta.name).toLowerCase() === clean) {
        return { ok: true, name: clean + '.ai' };
      }
    } catch { /* metadata fetch failed: the ownerOf check already proves it */ }
    return { ok: true, name: clean + '.ai' };
  } catch {
    return { ok: false, reason: `Could not verify ${clean}.ai on-chain (is it your Agent ID?).` };
  }
}

// ---- wall ----
async function loadWall() {
  const wallEl = $('wall');
  if (!CONFIG.WALL_ADDRESS) {
    wallEl.innerHTML = '<div class="empty">The wall contract is not deployed yet. Once it is, messages will appear here.</div>';
    $('countLabel').textContent = '';
    return;
  }
  try {
    const count = Number(await wallRead.messageCount());
    $('countLabel').textContent = count ? `· ${count} message${count === 1 ? '' : 's'}` : '';
    if (count === 0) {
      wallEl.innerHTML = '<div class="empty">No messages yet — be the first Agent ID holder to sign the wall.</div>';
      return;
    }
    const start = Math.max(0, count - CONFIG.PAGE_SIZE);
    const msgs = await wallRead.getMessages(start, count - start);
    const rows = [...msgs].reverse(); // newest first
    const parts = [];
    for (const m of rows) {
      const name = await resolveName(m.sender);
      const who = name ? esc(name) + ' <span class="verified">✓ Agent ID</span>' : esc(shortAddr(m.sender));
      parts.push(
        `<div class="msg"><div><span class="who">${who}</span><span class="when">${esc(fmtTime(m.timestamp))}</span></div>` +
        `<div class="body">${esc(m.message)}</div>` +
        `<div class="addr mono">${esc(m.sender)}</div></div>`
      );
    }
    wallEl.innerHTML = parts.join('');
  } catch (e) {
    wallEl.innerHTML = `<div class="empty">Could not load the wall (${esc(e.message || e)}). Try Refresh.</div>`;
  }
}

// ---- wallet ----
async function connectWallet() {
  if (!window.ethereum) {
    $('walletStatus').textContent = 'No wallet found. Install Binance Wallet or MetaMask, then try again.';
    return;
  }
  try {
    browserProvider = new ethers.BrowserProvider(window.ethereum);
    const accounts = await browserProvider.send('eth_requestAccounts', []);
    account = accounts[0];
    const net = await browserProvider.getNetwork();
    if (Number(net.chainId) !== CONFIG.CHAIN_ID) {
      try {
        await browserProvider.send('wallet_switchEthereumChain', [{ chainId: '0x38' }]);
      } catch {
        $('walletStatus').textContent = `Please switch your wallet to ${CONFIG.CHAIN_NAME} (chain 56).`;
        return;
      }
    }
    signer = await browserProvider.getSigner();
    $('walletStatus').innerHTML = `Connected: <span class="mono">${esc(shortAddr(account))}</span> · ${esc(CONFIG.CHAIN_NAME)}`;
    $('connectBtn').textContent = 'Connected';
    await checkHolder();
  } catch (e) {
    $('walletStatus').textContent = 'Connection cancelled or failed.';
  }
}

async function checkHolder() {
  if (!account) return;
  try {
    const bal = await registryRead.balanceOf(account);
    if (bal > 0n) {
      $('holderStatus').innerHTML = '<span class="ok">✓ This address holds an Agent ID — you can sign the wall.</span>';
      $('postCard').hidden = false;
      $('postBtn').disabled = !CONFIG.WALL_ADDRESS;
      if (!CONFIG.WALL_ADDRESS) $('postStatus').textContent = 'Posting opens once the wall contract is deployed.';
    } else {
      $('holderStatus').innerHTML = '<span class="bad">This address does not hold an Agent ID, so it cannot post. Only Agent ID holders can sign the wall.</span>';
      $('postCard').hidden = true;
    }
  } catch (e) {
    $('holderStatus').textContent = 'Could not check Agent ID holding: ' + (e.message || e);
  }
}

async function postMessage() {
  if (!signer || !account || !CONFIG.WALL_ADDRESS) return;
  const msg = $('message').value.trim();
  if (!msg) { $('postStatus').textContent = 'Write a message first.'; return; }
  if (new TextEncoder().encode(msg).length > 280) {
    $('postStatus').textContent = 'Message is over 280 bytes — please shorten it.';
    return;
  }
  const label = $('agentName').value.trim();
  let displayName = null;
  if (label) {
    $('nameCheck').textContent = 'Verifying your Agent ID name on-chain…';
    const v = await verifyLabel(label, account);
    if (!v.ok) { $('nameCheck').innerHTML = `<span class="bad">${esc(v.reason)}</span>`; return; }
    displayName = v.name;
    $('nameCheck').innerHTML = `<span class="ok">✓ Verified: ${esc(displayName)}</span>`;
    const cache = loadNameCache();
    cache[account.toLowerCase()] = displayName;
    saveNameCache(cache);
  }
  $('postBtn').disabled = true;
  $('postStatus').textContent = 'Confirm the transaction in your wallet…';
  try {
    const wallWrite = new ethers.Contract(CONFIG.WALL_ADDRESS, WALL_ABI, signer);
    const tx = await wallWrite.post(msg);
    $('postStatus').textContent = `Transaction sent (${shortAddr(tx.hash)}…). Waiting for confirmation…`;
    const rc = await tx.wait();
    $('postStatus').innerHTML = `<span class="ok">✓ Posted in block ${rc.blockNumber}.</span>`;
    $('message').value = '';
    $('charCount').textContent = '0';
    await loadWall();
  } catch (e) {
    $('postStatus').innerHTML = `<span class="bad">Post failed: ${esc(e.shortMessage || e.message || e)}</span>`;
  } finally {
    $('postBtn').disabled = false;
  }
}

function init() {
  registryRead = new ethers.Contract(CONFIG.REGISTRY_ADDRESS, REGISTRY_ABI, readProvider);
  if (CONFIG.WALL_ADDRESS) {
    wallRead = new ethers.Contract(CONFIG.WALL_ADDRESS, WALL_ABI, readProvider);
    $('wallAddr').innerHTML = `<a href="https://bscscan.com/address/${CONFIG.WALL_ADDRESS}" target="_blank" rel="noopener">${esc(CONFIG.WALL_ADDRESS)}</a>`;
  } else {
    $('wallAddr').textContent = 'not deployed yet — the address will be added here after deployment';
  }
  $('connectBtn').addEventListener('click', connectWallet);
  $('refreshBtn').addEventListener('click', loadWall);
  $('postBtn').addEventListener('click', postMessage);
  $('message').addEventListener('input', (e) => { $('charCount').textContent = String(e.target.value.length); });
  if (window.ethereum) {
    window.ethereum.on('accountsChanged', () => location.reload());
    window.ethereum.on('chainChanged', () => location.reload());
  }
  loadWall();
  setInterval(loadWall, 30000); // refresh the wall every 30s
}

init();
