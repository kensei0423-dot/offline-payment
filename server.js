require('dotenv').config({ path: '.env.local' });
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ─── PayPal Config ──────────────────────────────────────────
const BASE = process.env.PAYPAL_ENV === 'sandbox'
  ? 'https://api.sandbox.paypal.com'
  : 'https://api.paypal.com';

const BN_CODE = process.env.PAYPAL_BN_CODE || '';
const PARTNER_ID = process.env.PAYPAL_PARTNER_ID || '';

let _token = null, _expiry = 0;

async function getToken() {
  if (_token && Date.now() < _expiry - 60_000) return _token;
  const creds = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
  ).toString('base64');
  const r = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await r.json();
  _token = data.access_token;
  _expiry = Date.now() + data.expires_in * 1000;
  console.log('[Token] refreshed');
  return _token;
}

// ─── Auth-Assertion (代商户操作) ─────────────────────────────
function getAuthAssertion(sellerMerchantId) {
  const header = Buffer.from('{"alg":"none"}').toString('base64').replace(/=+$/g, '');
  const payload = Buffer.from(JSON.stringify({
    iss: process.env.PAYPAL_CLIENT_ID,
    payer_id: sellerMerchantId,
  })).toString('base64').replace(/=+$/g, '');
  return `${header}.${payload}.`;
}

function partnerHeaders(merchantId) {
  const h = {};
  if (merchantId) h['PayPal-Auth-Assertion'] = getAuthAssertion(merchantId);
  if (BN_CODE) h['PayPal-Partner-Attribution-Id'] = BN_CODE;
  return h;
}

// ─── Merchants DB (JSON file) ───────────────────────────────
const MERCHANTS_FILE = path.join(__dirname, 'merchants.json');

function loadMerchants() {
  try {
    return JSON.parse(fs.readFileSync(MERCHANTS_FILE, 'utf8'));
  } catch { return { merchants: [] }; }
}

function saveMerchants(data) {
  fs.writeFileSync(MERCHANTS_FILE, JSON.stringify(data, null, 2));
}

function findMerchant(merchantId) {
  return loadMerchants().merchants.find(m => m.merchantId === merchantId);
}

// ─── Direct Merchant Token Cache ────────────────────────────
const directTokenCache = {}; // merchantId → { token, expiry }

async function getDirectToken(merchant) {
  const cached = directTokenCache[merchant.merchantId];
  if (cached && Date.now() < cached.expiry - 60_000) return cached;

  const base = merchant.env === 'live'
    ? 'https://api.paypal.com'
    : 'https://api.sandbox.paypal.com';
  const creds = Buffer.from(`${merchant.clientId}:${merchant.clientSecret}`).toString('base64');
  const r = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await r.json();
  const result = {
    token: data.access_token,
    expiry: Date.now() + data.expires_in * 1000,
    base,
  };
  directTokenCache[merchant.merchantId] = result;
  return result;
}

// Helper: get token + base URL + headers for any merchant type
async function getMerchantAuth(merchantId) {
  if (!merchantId) {
    return { token: await getToken(), base: BASE, headers: {} };
  }
  const merchant = findMerchant(merchantId);
  if (merchant?.type === 'direct') {
    const dt = await getDirectToken(merchant);
    return { token: dt.token, base: dt.base, headers: {} };
  }
  // Partner mode
  return { token: await getToken(), base: BASE, headers: partnerHeaders(merchantId) };
}

// ─── Order State (持久化到文件) ──────────────────────────────
const cancelledOrders = new Set();
const ORDER_STATE_FILE = path.join(__dirname, 'order-state.json');

function loadOrderState() {
  try {
    return JSON.parse(fs.readFileSync(ORDER_STATE_FILE, 'utf8'));
  } catch { return { pickupCodes: {}, orderMerchantMap: {} }; }
}

function saveOrderState(state) {
  fs.writeFileSync(ORDER_STATE_FILE, JSON.stringify(state));
}

// 启动时从文件恢复
const _orderState = loadOrderState();
const pickupCodes = _orderState.pickupCodes;
const orderMerchantMap = _orderState.orderMerchantMap;

function persistOrderState() {
  saveOrderState({ pickupCodes, orderMerchantMap });
}

function getPickupCode(orderId) {
  if (!pickupCodes[orderId]) {
    pickupCodes[orderId] = String(Math.floor(1000 + Math.random() * 9000));
    persistOrderState();
  }
  return pickupCodes[orderId];
}

// ─── 查询商户详情（获取名称等信息）──────────────────────────
async function queryMerchantInfo(merchantId) {
  const token = await getToken();
  const partnerId = process.env.PAYPAL_PARTNER_ID;
  if (!partnerId) return null;
  const r = await fetch(`${BASE}/v1/customer/partners/${partnerId}/merchant-integrations/${merchantId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  return r.json();
}

// ─── Tracking API: 查询商户入驻状态 ─────────────────────────
async function queryMerchantByTracking(trackingId) {
  const token = await getToken();
  const partnerId = process.env.PAYPAL_PARTNER_ID;
  if (!partnerId) return null;
  const r = await fetch(`${BASE}/v1/customer/partners/${partnerId}/merchant-integrations?tracking_id=${trackingId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  return r.json();
}

// 自动补全 pending 商户的 merchantId
async function syncPendingMerchants() {
  const db = loadMerchants();
  let changed = false;

  // 补全已有 merchantId 但缺名称的商户
  for (const m of db.merchants) {
    if (m.merchantId && !m.name) {
      try {
        const info = await queryMerchantInfo(m.merchantId);
        if (info?.legal_name) { m.name = info.legal_name; changed = true; }
        if (info?.primary_email) { m.email = info.primary_email; changed = true; }
      } catch (_) {}
    }
  }

  // 补全 pending 商户的 merchantId
  for (const m of db.merchants) {
    if (m.merchantId || !m.trackingId) continue;
    try {
      const result = await queryMerchantByTracking(m.trackingId);
      if (result?.merchant_id) {
        // 检查是否已有相同 merchantId 的记录
        const dup = db.merchants.find(x => x.merchantId === result.merchant_id && x !== m);
        if (dup) {
          // 标记当前记录为重复，稍后清理
          m._remove = true;
        } else {
          m.merchantId = result.merchant_id;
          m.status = 'active';
          m.permissionsGranted = true;
          // 获取商户名称
          try {
            const info = await queryMerchantInfo(result.merchant_id);
            if (info?.legal_name) m.name = info.legal_name;
            if (info?.primary_email) m.email = info.primary_email;
          } catch (_) {}
        }
        changed = true;
        console.log(`[Sync] ${m.trackingId} → ${result.merchant_id}`);
      }
    } catch (err) {
      console.error(`[Sync Error] ${m.trackingId}:`, err.message);
    }
  }
  if (changed) {
    db.merchants = db.merchants.filter(m => !m._remove);
    saveMerchants(db);
  }
  return db.merchants;
}

// ═══════════════════════════════════════════════════════════
//  商户入驻 (Partner Referrals API)
// ═══════════════════════════════════════════════════════════

// 发起入驻 → 跳转 PayPal 授权
app.get('/onboard', async (req, res) => {
  try {
    const token = await getToken();
    const host = `${req.protocol}://${req.get('host')}`;
    const trackingId = `m_${crypto.randomBytes(6).toString('hex')}`;

    const body = {
      tracking_id: trackingId,
      preferred_language_code: 'zh-CN',
      business_entity: {
        addresses: [{ country_code: 'C2' }],
      },
      operations: [{
        operation: 'API_INTEGRATION',
        api_integration_preference: {
          rest_api_integration: {
            integration_method: 'PAYPAL',
            integration_type: 'THIRD_PARTY',
            third_party_details: {
              features: [
                'PAYMENT',
                'REFUND',
                'PARTNER_FEE',
                'DELAY_FUNDS_DISBURSEMENT',
                'READ_SELLER_DISPUTE',
                'UPDATE_SELLER_DISPUTE',
                'DISPUTE_READ_BUYER',
                'UPDATE_CUSTOMER_DISPUTES',
                'ACCESS_MERCHANT_INFORMATION',
              ],
            },
          },
        },
      }],
      products: ['EXPRESS_CHECKOUT'],
      legal_consents: [{
        type: 'SHARE_DATA_CONSENT',
        granted: true,
      }],
      partner_config_override: {
        return_url: `${host}/onboard/return`,
        return_url_description: 'the url to return the merchant after the paypal onboarding process.',
      },
    };

    const r = await fetch(`${BASE}/v2/customer/partner-referrals`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const result = await r.json();
    if (!r.ok) {
      console.error('[Onboard Error]', JSON.stringify(result, null, 2));
      return res.status(r.status).json({ error: result });
    }

    const actionUrl = result.links?.find(l => l.rel === 'action_url')?.href;
    if (!actionUrl) {
      return res.status(500).json({ error: 'No action_url returned' });
    }

    const db = loadMerchants();
    db.merchants.push({
      trackingId,
      merchantId: null,
      name: '',
      status: 'pending',
      onboardedAt: new Date().toISOString(),
    });
    saveMerchants(db);

    console.log(`[Onboard] trackingId=${trackingId} → redirecting to PayPal`);
    res.json({ actionUrl });
  } catch (err) {
    console.error('[Onboard]', err);
    res.status(500).json({ error: err.message });
  }
});

// PayPal 授权完成回调
app.get('/onboard/return', async (req, res) => {
  const {
    merchantId: trackingId,
    merchantIdInPayPal,
    permissionsGranted,
    accountStatus,
    isEmailConfirmed,
  } = req.query;

  if (!merchantIdInPayPal) {
    return res.status(400).send('Missing merchantIdInPayPal');
  }

  // Save merchant — merge with pending record from /onboard
  const db = loadMerchants();
  const pending = db.merchants.find(m => m.trackingId === trackingId && !m.merchantId);
  const existing = db.merchants.find(m => m.merchantId === merchantIdInPayPal);
  if (existing) {
    // Already onboarded, update status
    existing.status = permissionsGranted === 'true' ? 'active' : 'pending';
    existing.permissionsGranted = permissionsGranted === 'true';
  } else if (pending) {
    // Update pending record with PayPal merchant ID
    pending.merchantId = merchantIdInPayPal;
    pending.status = permissionsGranted === 'true' ? 'active' : 'pending';
    pending.accountStatus = accountStatus || '';
    pending.permissionsGranted = permissionsGranted === 'true';
    pending.isEmailConfirmed = isEmailConfirmed === 'true';
  } else {
    db.merchants.push({
      trackingId: trackingId || '',
      merchantId: merchantIdInPayPal,
      name: '',
      email: '',
      status: permissionsGranted === 'true' ? 'active' : 'pending',
      accountStatus: accountStatus || '',
      permissionsGranted: permissionsGranted === 'true',
      isEmailConfirmed: isEmailConfirmed === 'true',
      onboardedAt: new Date().toISOString(),
    });
  }
  // 从 PayPal 获取商户名称
  let merchantName = '';
  try {
    const info = await queryMerchantInfo(merchantIdInPayPal);
    if (info?.legal_name) {
      merchantName = info.legal_name;
      const target = pending || existing || db.merchants.find(m => m.merchantId === merchantIdInPayPal);
      if (target) {
        target.name = info.legal_name;
        if (info.primary_email) target.email = info.primary_email;
      }
    }
  } catch (_) {}

  saveMerchants(db);
  console.log(`[Onboard Complete] ${merchantIdInPayPal} (tracking: ${trackingId}) name: ${merchantName}`);

  const host = `${req.protocol}://${req.get('host')}`;
  const merchantUrl = `${host}/merchant.html?id=${merchantIdInPayPal}`;

  res.send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>入驻成功</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f7fa; display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 16px; }
    .card { background: #fff; border-radius: 16px; padding: 40px 32px; max-width: 480px; width: 100%; text-align: center; box-shadow: 0 2px 16px rgba(0,0,0,.08); }
    .checkmark { width: 72px; height: 72px; border-radius: 50%; background: #d4edda; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; }
    .checkmark svg { width: 36px; height: 36px; stroke: #155724; stroke-width: 3; fill: none; }
    h2 { color: #155724; margin-bottom: 16px; }
    .link-box { background: #f0f4ff; border: 1px solid #c5d5ff; border-radius: 8px; padding: 16px; margin: 20px 0; word-break: break-all; font-size: 14px; color: #0070ba; }
    .btn { display: inline-block; padding: 14px 32px; background: #0070ba; color: #fff; border: none; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; text-decoration: none; margin-top: 8px; }
    .btn:hover { background: #005ea6; }
    p { color: #666; font-size: 14px; margin-top: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="checkmark">
      <svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg>
    </div>
    <h2>商户入驻成功</h2>${merchantName ? `\n    <p style="font-size:18px;font-weight:600;color:#333;margin-bottom:8px;">${merchantName}</p>` : ''}
    <p>您的 PayPal 商户 ID：<strong>${merchantIdInPayPal}</strong></p>
    <p>您的专属收款链接：</p>
    <div class="link-box">${merchantUrl}</div>
    <a class="btn" href="${merchantUrl}">立即开始收款</a>
    <p style="margin-top: 20px; color: #aaa; font-size: 12px;">请收藏此链接，每次收款时打开即可</p>
  </div>
</body>
</html>`);
});

// ─── Direct Onboard（商户输入 Client ID/Secret）─────────────
app.post('/onboard/direct', async (req, res) => {
  const { name, clientId, clientSecret, env = 'sandbox' } = req.body;
  if (!name || !clientId || !clientSecret) {
    return res.status(400).json({ error: '请填写所有字段' });
  }

  // Verify credentials by fetching a token
  const base = env === 'live'
    ? 'https://api.paypal.com'
    : 'https://api.sandbox.paypal.com';
  try {
    const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const r = await fetch(`${base}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${creds}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    const tokenData = await r.json();
    if (!r.ok || !tokenData.access_token) {
      return res.status(400).json({ error: 'Client ID 或 Secret 无效' });
    }

    // Get merchant ID from userinfo
    const infoRes = await fetch(`${base}/v1/oauth2/token/userinfo?schema=openid`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    let merchantPayPalId = clientId; // fallback
    if (infoRes.ok) {
      const info = await infoRes.json();
      if (info.payer_id) merchantPayPalId = info.payer_id;
    }

    // Save merchant
    const db = loadMerchants();
    const existing = db.merchants.find(m => m.merchantId === merchantPayPalId);
    if (existing) {
      existing.name = name;
      existing.clientId = clientId;
      existing.clientSecret = clientSecret;
      existing.env = env;
      existing.type = 'direct';
      existing.status = 'active';
    } else {
      db.merchants.push({
        trackingId: `d_${crypto.randomBytes(6).toString('hex')}`,
        merchantId: merchantPayPalId,
        name,
        clientId,
        clientSecret,
        env,
        type: 'direct',
        status: 'active',
        onboardedAt: new Date().toISOString(),
      });
    }
    saveMerchants(db);
    console.log(`[Direct Onboard] ${name} → ${merchantPayPalId}`);

    res.json({ success: true, merchantId: merchantPayPalId });
  } catch (err) {
    console.error('[Direct Onboard Error]', err);
    res.status(500).json({ error: err.message });
  }
});

// 获取所有商户列表（隐藏敏感字段）
function sanitizeMerchants(merchants) {
  return merchants.map(({ clientSecret, clientId, ...rest }) => ({
    ...rest,
    type: rest.type || 'partner',
  }));
}

app.get('/merchants', async (req, res) => {
  const db = loadMerchants();
  const hasPending = db.merchants.some(m => !m.merchantId);
  if (hasPending) {
    const merchants = await syncPendingMerchants();
    return res.json(sanitizeMerchants(merchants));
  }
  res.json(sanitizeMerchants(db.merchants));
});

// 手动触发同步
app.post('/sync-merchants', async (req, res) => {
  const merchants = await syncPendingMerchants();
  res.json({ synced: true, merchants });
});

// ═══════════════════════════════════════════════════════════
//  订单接口（支持多商户）
// ═══════════════════════════════════════════════════════════

// ─── Create Order ───────────────────────────────────────────
app.post('/create-order', async (req, res) => {
  const { amount, currency = 'USD', description = '', merchantId } = req.body;
  if (!amount || isNaN(amount) || Number(amount) <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  try {
    const auth = await getMerchantAuth(merchantId);
    const host = `${req.protocol}://${req.get('host')}`;
    const merchant = merchantId ? findMerchant(merchantId) : null;
    const isDirect = merchant?.type === 'direct';

    const purchaseUnit = {
      amount: {
        currency_code: currency,
        value: Number(amount).toFixed(2),
      },
      ...(description ? { description } : {}),
    };

    // Partner mode: set payee to merchant
    if (merchantId && !isDirect) {
      purchaseUnit.payee = { merchant_id: merchantId };
    }

    const orderBody = {
      intent: 'CAPTURE',
      purchase_units: [purchaseUnit],
      payment_source: {
        paypal: {
          experience_context: {
            payment_method_preference: 'IMMEDIATE_PAYMENT_REQUIRED',
            shipping_preference: 'NO_SHIPPING',
            user_action: 'PAY_NOW',
            return_url: `${host}/success`,
            cancel_url: merchantId ? `${host}/merchant.html?id=${merchantId}` : `${host}`,
          },
        },
      },
    };

    const r = await fetch(`${auth.base}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
        ...auth.headers,
      },
      body: JSON.stringify(orderBody),
    });

    const order = await r.json();
    if (!r.ok) {
      console.error('[Create Order Error]', JSON.stringify(order, null, 2));
      return res.status(r.status).json({ error: order });
    }

    // Track order → merchant mapping
    if (merchantId) {
      orderMerchantMap[order.id] = merchantId;
      persistOrderState();
    }

    const approveLink = order.links?.find(l => l.rel === 'payer-action');
    console.log(`[Order Created] ${order.id} — $${amount} ${currency}${merchantId ? ` (merchant: ${merchantId})` : ''}`);

    res.json({
      orderId: order.id,
      approveUrl: approveLink?.href || '',
      status: order.status,
    });
  } catch (err) {
    console.error('[Create Order]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Buyer: Get pickup code for order ───────────────────────
app.get('/pickup-code/:id', (req, res) => {
  const code = pickupCodes[req.params.id];
  if (!code) return res.status(404).json({ error: 'Not found' });
  res.json({ pickupCode: code });
});

// ─── Buyer Success Page ─────────────────────────────────────
app.get('/success', (req, res) => {
  const orderId = req.query.token || '';
  res.send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>支付成功</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f7fa; display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 16px; }
    .card { background: #fff; border-radius: 16px; padding: 40px 32px; max-width: 400px; width: 100%; text-align: center; box-shadow: 0 2px 16px rgba(0,0,0,.08); }
    .checkmark { width: 72px; height: 72px; border-radius: 50%; background: #d4edda; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; }
    .checkmark svg { width: 36px; height: 36px; stroke: #155724; stroke-width: 3; fill: none; }
    h2 { color: #155724; margin-bottom: 16px; }
    .pickup-box { background: #fff8e1; border: 2px dashed #f9a825; border-radius: 12px; padding: 20px; margin: 20px 0; }
    .pickup-label { font-size: 13px; color: #888; margin-bottom: 4px; }
    .pickup-code { font-size: 48px; font-weight: 800; color: #e65100; letter-spacing: 8px; font-family: 'Courier New', monospace; }
    .info { text-align: left; background: #f8f9fa; border-radius: 8px; padding: 16px; margin-top: 16px; font-size: 14px; }
    .info .info-row { padding: 8px 0; display: flex; justify-content: space-between; border-bottom: 1px solid #eee; }
    .info .info-row:last-child { border-bottom: none; }
    .info .label { color: #888; white-space: nowrap; margin-right: 12px; }
    .info .value { font-weight: 600; text-align: right; word-break: break-all; }
    .hint { margin-top: 16px; color: #aaa; font-size: 12px; }
    .cancelled { color: #c00; font-size: 16px; margin-top: 12px; }
    .loading { display: inline-block; width: 20px; height: 20px; border: 2px solid #ccc; border-top-color: #0070ba; border-radius: 50%; animation: spin .6s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
  <script>history.replaceState({}, '', '/success');</script>
</head>
<body>
  <div class="card">
    <div class="checkmark">
      <svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg>
    </div>
    <h2>支付成功</h2>
    <div id="content"><span class="loading"></span></div>
  </div>
  <script>
    // 保存 orderId 到 sessionStorage，刷新后可恢复
    let orderId = '${orderId}';
    if (orderId) {
      sessionStorage.setItem('lastOrderId', orderId);
    } else {
      orderId = sessionStorage.getItem('lastOrderId') || '';
    }

    function showCancelled(msg) {
      document.querySelector('.checkmark').style.background = '#f8d7da';
      document.querySelector('.checkmark svg').style.stroke = '#721c24';
      document.querySelector('h2').textContent = '订单已取消';
      document.querySelector('h2').style.color = '#721c24';
      document.getElementById('content').innerHTML = '<p class="cancelled">' + msg + '</p><a href="/lookup.html" style="display:inline-block;margin-top:16px;color:#0070ba;font-size:14px;">查询取货码</a>';
    }

    function showSuccess(data) {
      const order = data.order || {};
      const capture = data.capture || order.purchase_units?.[0]?.payments?.captures?.[0];
      const amt = capture?.amount || order.purchase_units?.[0]?.amount;
      const payer = order.payer;
      let html = '';
      if (data.pickupCode) {
        html += '<div class="pickup-box"><div class="pickup-label">取货码</div><div class="pickup-code">' + data.pickupCode + '</div></div>';
      }
      html += '<div class="info">';
      if (amt) html += '<div class="info-row"><span class="label">金额</span><span class="value">' + amt.value + ' ' + amt.currency_code + '</span></div>';
      html += '<div class="info-row"><span class="label">订单号</span><span class="value">' + order.id + '</span></div>';
      if (payer?.name) html += '<div class="info-row"><span class="label">付款人</span><span class="value">' + (payer.name.given_name||'') + ' ' + (payer.name.surname||'') + '</span></div>';
      if (payer?.email_address) html += '<div class="info-row"><span class="label">邮箱</span><span class="value">' + payer.email_address + '</span></div>';
      if (capture?.create_time) html += '<div class="info-row"><span class="label">时间</span><span class="value">' + new Date(capture.create_time).toLocaleString() + '</span></div>';
      html += '</div>';
      html += '<p class="hint">请向商家出示取货码</p>';
      document.getElementById('content').innerHTML = html;
    }

    (async () => {
      if (!orderId) { document.getElementById('content').innerHTML = '<p style="color:#888">交易已完成</p>'; return; }

      // 先检查是否已取消
      try {
        const cancelData = await fetch('/cancel-status/' + orderId).then(r => r.json());
        if (cancelData.cancelled) { showCancelled('该订单已被商家取消'); return; }
      } catch (_) {}

      // 显示等待状态
      document.getElementById('content').innerHTML = '<p><span class="loading"></span> 正在确认支付结果...</p>';

      // 用 SSE 实时等待 capture 完成 + 取货码
      const es = new EventSource('/buyer-watch/' + orderId);
      es.onmessage = (e) => {
        const data = JSON.parse(e.data);
        if (data.status === 'COMPLETED') {
          es.close();
          showSuccess(data);
        } else if (data.status === 'CANCELLED') {
          es.close();
          showCancelled('该订单已被商家取消，款项将原路退回');
        } else if (data.status === 'TIMEOUT') {
          es.close();
          showCancelled('支付失败，请重新扫码支付');
        }
      };
      es.onerror = () => {
        // SSE 断开后尝试一次性 fallback
        es.close();
        fetch('/pickup-code/' + orderId).then(r => r.ok ? r.json() : null).then(d => {
          if (d?.pickupCode) {
            fetch('/order-status/' + orderId).then(r => r.json()).then(order => {
              showSuccess({ pickupCode: d.pickupCode, order });
            });
          } else {
            document.getElementById('content').innerHTML = '<p style="color:#888">连接中断</p><a href="/lookup.html" style="display:inline-block;margin-top:12px;color:#0070ba;font-size:14px;">手动查询取货码</a>';
          }
        });
      };
    })();
  </script>
</body>
</html>`);
});

// ─── Get Order Status ───────────────────────────────────────
app.get('/order-status/:id', async (req, res) => {
  try {
    const merchantId = orderMerchantMap[req.params.id];
    const auth = await getMerchantAuth(merchantId);
    const r = await fetch(`${auth.base}/v2/checkout/orders/${req.params.id}`, {
      headers: { Authorization: `Bearer ${auth.token}`, ...auth.headers },
    });
    const order = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: order });
    res.json(order);
  } catch (err) {
    console.error('[Order Status]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Capture Order ──────────────────────────────────────────
app.post('/capture-order/:id', async (req, res) => {
  try {
    const merchantId = orderMerchantMap[req.params.id];
    const auth = await getMerchantAuth(merchantId);
    const r = await fetch(`${auth.base}/v2/checkout/orders/${req.params.id}/capture`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
        ...auth.headers,
      },
    });
    const result = await r.json();
    if (!r.ok) {
      console.error('[Capture Error]', JSON.stringify(result, null, 2));
      return res.status(r.status).json({ error: result });
    }
    console.log(`[Captured] ${req.params.id} — ${result.status}`);
    res.json(result);
  } catch (err) {
    console.error('[Capture]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Cancel Order ───────────────────────────────────────────
app.post('/cancel-order/:id', async (req, res) => {
  const orderId = req.params.id;
  cancelledOrders.add(orderId);
  console.log(`[Cancelled] ${orderId}`);

  try {
    const merchantId = orderMerchantMap[orderId];
    const auth = await getMerchantAuth(merchantId);
    const r = await fetch(`${auth.base}/v2/checkout/orders/${orderId}`, {
      headers: { Authorization: `Bearer ${auth.token}`, ...auth.headers },
    });
    const order = await r.json();
    const captureId = order.purchase_units?.[0]?.payments?.captures?.[0]?.id;
    if (captureId && order.status === 'COMPLETED') {
      const rr = await fetch(`${auth.base}/v2/payments/captures/${captureId}/refund`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${auth.token}`,
          'Content-Type': 'application/json',
          ...auth.headers,
        },
      });
      const refund = await rr.json();
      console.log(`[Auto Refund] ${captureId} — ${refund.status}`);
      return res.json({ cancelled: true, refunded: true, refundId: refund.id });
    }
  } catch (err) {
    console.error('[Cancel Refund Check]', err.message);
  }

  res.json({ cancelled: true });
});

app.get('/cancel-status/:id', (req, res) => {
  res.json({ cancelled: cancelledOrders.has(req.params.id) });
});

// ─── SSE: Watch Order Status ────────────────────────────────
app.get('/order-watch/:id', async (req, res) => {
  const orderId = req.params.id;
  const merchantId = orderMerchantMap[orderId];
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('data: {"status":"watching"}\n\n');

  let stopped = false;
  req.on('close', () => { stopped = true; });
  const startTime = Date.now();
  const POLL_TIMEOUT = 30 * 1000; // 30 seconds

  // 立即检查：如果已有取货码说明已完成，直接推送
  if (pickupCodes[orderId]) {
    try {
      const auth = await getMerchantAuth(merchantId);
      const r = await fetch(`${auth.base}/v2/checkout/orders/${orderId}`, {
        headers: { Authorization: `Bearer ${auth.token}`, ...auth.headers },
      });
      const order = await r.json();
      if (order.status === 'COMPLETED') {
        order.pickupCode = pickupCodes[orderId];
        res.write(`data: ${JSON.stringify(order)}\n\n`);
        res.end();
        console.log(`[SSE Retry] ${orderId} — pushed existing pickup code ${pickupCodes[orderId]}`);
        return;
      }
    } catch (_) {}
  }

  const poll = async () => {
    if (stopped) return;
    if (Date.now() - startTime > POLL_TIMEOUT) {
      res.write('data: {"status":"TIMEOUT"}\n\n');
      res.end();
      console.log(`[SSE Timeout] ${orderId}`);
      return;
    }
    if (cancelledOrders.has(orderId)) {
      res.write('data: {"status":"CANCELLED"}\n\n');
      res.end();
      return;
    }
    try {
      const auth = await getMerchantAuth(merchantId);
      const r = await fetch(`${auth.base}/v2/checkout/orders/${orderId}`, {
        headers: { Authorization: `Bearer ${auth.token}`, ...auth.headers },
      });
      const order = await r.json();

      if (order.status === 'APPROVED' && !cancelledOrders.has(orderId)) {
        const cr = await fetch(`${auth.base}/v2/checkout/orders/${orderId}/capture`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${auth.token}`,
            'Content-Type': 'application/json',
            ...auth.headers,
          },
        });
        const captured = await cr.json();
        if (captured.status !== 'COMPLETED') {
          // Capture 失败，不推送成功，继续轮询重试
          console.error(`[SSE Capture Failed] ${orderId} — ${captured.status || JSON.stringify(captured)}`);
          if (!stopped) setTimeout(poll, 3000);
          return;
        }
        const code = getPickupCode(orderId);
        console.log(`[SSE Captured] ${orderId} — ${captured.status} — Pickup: ${code}`);
        captured.pickupCode = code;
        res.write(`data: ${JSON.stringify(captured)}\n\n`);
        res.end();
        return;
      }

      if (order.status === 'COMPLETED') {
        order.pickupCode = getPickupCode(orderId);
        res.write(`data: ${JSON.stringify(order)}\n\n`);
        res.end();
        return;
      }
    } catch (err) {
      console.error('[SSE Poll]', err.message);
    }
    if (!stopped) setTimeout(poll, 3000);
  };

  setTimeout(poll, 3000);
});

// ─── SSE: Buyer Watch (买家端实时等待取货码) ─────────────────
app.get('/buyer-watch/:id', async (req, res) => {
  const orderId = req.params.id;
  const merchantId = orderMerchantMap[orderId];
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  let stopped = false;
  req.on('close', () => { stopped = true; });
  const startTime = Date.now();
  const BUYER_TIMEOUT = 60 * 1000; // 买家端给 60 秒

  const poll = async () => {
    if (stopped) return;
    if (Date.now() - startTime > BUYER_TIMEOUT) {
      res.write('data: {"status":"TIMEOUT"}\n\n');
      res.end();
      return;
    }
    if (cancelledOrders.has(orderId)) {
      res.write('data: {"status":"CANCELLED"}\n\n');
      res.end();
      return;
    }

    // 已有取货码 → 直接推送
    if (pickupCodes[orderId]) {
      try {
        const auth = await getMerchantAuth(merchantId);
        const r = await fetch(`${auth.base}/v2/checkout/orders/${orderId}`, {
          headers: { Authorization: `Bearer ${auth.token}`, ...auth.headers },
        });
        const order = await r.json();
        if (order.status === 'COMPLETED') {
          const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
          res.write(`data: ${JSON.stringify({ status: 'COMPLETED', pickupCode: pickupCodes[orderId], order, capture })}\n\n`);
          res.end();
          return;
        }
      } catch (_) {}
    }

    // 订单 APPROVED 但尚未 capture → 买家端主动触发 capture
    try {
      const auth = await getMerchantAuth(merchantId);
      const r = await fetch(`${auth.base}/v2/checkout/orders/${orderId}`, {
        headers: { Authorization: `Bearer ${auth.token}`, ...auth.headers },
      });
      const order = await r.json();

      if (order.status === 'APPROVED' && !cancelledOrders.has(orderId)) {
        const cr = await fetch(`${auth.base}/v2/checkout/orders/${orderId}/capture`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${auth.token}`,
            'Content-Type': 'application/json',
            ...auth.headers,
          },
        });
        const captured = await cr.json();
        if (captured.status === 'COMPLETED') {
          const code = getPickupCode(orderId);
          const capture = captured.purchase_units?.[0]?.payments?.captures?.[0];
          console.log(`[Buyer Capture] ${orderId} — Pickup: ${code}`);
          res.write(`data: ${JSON.stringify({ status: 'COMPLETED', pickupCode: code, order: captured, capture })}\n\n`);
          res.end();
          return;
        }
      }

      if (order.status === 'COMPLETED') {
        const code = getPickupCode(orderId);
        const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
        res.write(`data: ${JSON.stringify({ status: 'COMPLETED', pickupCode: code, order, capture })}\n\n`);
        res.end();
        return;
      }
    } catch (err) {
      console.error('[Buyer Watch]', err.message);
    }

    if (!stopped) setTimeout(poll, 2000);
  };

  // 首次立即检查
  poll();
});

// ─── Start ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3456;
app.listen(PORT, () => {
  console.log(`Offline Payment Platform running at http://localhost:${PORT}`);
  console.log(`PayPal: ${process.env.PAYPAL_ENV} | BN: ${BN_CODE || 'not set'}`);
  // 启动时自动同步 pending 商户
  syncPendingMerchants().then(merchants => {
    const active = merchants.filter(m => m.merchantId);
    if (active.length) console.log(`[Sync] ${active.length} active merchant(s)`);
  }).catch(() => {});
});
