# PayPal JS SDK v5 + Orders v2 API 实施指南

## 目录
1. [SDK 接入](#sdk-接入)
2. [PayPal Buttons（标准支付）](#paypal-buttons)
3. [错误处理](#错误处理)
4. [Webhook](#webhook)

---

## SDK 接入

### 基础加载

```html
<script src="https://www.paypal.com/sdk/js?client-id=YOUR_CLIENT_ID&currency=USD&components=buttons"></script>
```

PayPal 根据 Client ID 自动判断 Sandbox / Live 环境，SDK URL 不需要区分。

### URL 参数

| 参数 | 必填 | 说明 | 示例 |
|------|------|------|------|
| `client-id` | ✅ | Client ID | `client-id=AbCdEf...` |
| `currency` | | 货币代码（默认 USD） | `currency=USD` |
| `components` | | 需要的组件（逗号分隔） | `components=buttons,card-fields,messages` |
| `intent` | | 支付意图 | `intent=capture`（默认）或 `intent=authorize` |
| `locale` | | 语言 | `locale=zh_CN` |
| `buyer-country` | | Sandbox 买家国家 | `buyer-country=US` |

### 组件列表

| 组件 | 用途 |
|------|------|
| `buttons` | PayPal / Pay Later / Venmo 按钮 |
| `card-fields` | 信用卡直输（ACDC） |
| `messages` | Pay Later 分期提示消息（PLM） |
| `fastlane` | 加速结账 |

### 后端获取 Access Token

```javascript
let cachedToken = null;
let tokenExpiry = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry - 60_000) {
    return cachedToken;
  }
  const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const r = await fetch('https://api.sandbox.paypal.com/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await r.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + data.expires_in * 1000;
  return cachedToken;
}
```

> Token 有效期约 9 小时，建议缓存。新 token 不会使旧 token 失效。

### Sandbox vs Live

| 环境 | API Base URL |
|------|-------------|
| Sandbox | `https://api.sandbox.paypal.com` |
| Live | `https://api.paypal.com` |

> SDK URL 相同（`https://www.paypal.com/sdk/js`），PayPal 根据 Client ID 自动判断环境。

---

## PayPal Buttons

### 订单状态流转

```
CREATED → APPROVED → COMPLETED (capture)
                   → VOIDED (authorize → void)
```

### 前端

```html
<div id="paypal-button-container"></div>
<script>
  paypal.Buttons({
    style: {
      layout: 'vertical',   // vertical | horizontal
      color: 'gold',         // gold | blue | silver | white | black
      shape: 'rect',         // rect | pill
      label: 'paypal',       // paypal | checkout | buynow | pay
    },

    createOrder: async () => {
      const r = await fetch('/orders/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: '10.00', currency: 'USD' }),
      });
      const data = await r.json();
      return data.orderId;
    },

    onApprove: async (data) => {
      const r = await fetch('/orders/capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: data.orderID }),
      });
      const result = await r.json();
      // 关键：检查 capture.status，而非 order.status
      const capture = result.purchase_units?.[0]?.payments?.captures?.[0];
      if (capture?.status === 'COMPLETED') {
        alert('支付成功！');
      }
    },

    onError: (err) => {
      console.error('PayPal Error:', err);
    },

    onCancel: () => {
      console.log('用户取消支付');
    },
  }).render('#paypal-button-container');
</script>
```

### 后端 — 创建订单

```javascript
app.post('/orders/create', async (req, res) => {
  const { amount, currency = 'USD', description } = req.body;
  const token = await getToken();

  const r = await fetch('https://api.sandbox.paypal.com/v2/checkout/orders', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': `order_${Date.now()}_${Math.random()}`,  // 幂等
    },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{
        amount: {
          currency_code: currency,
          value: amount,
        },
        ...(description ? { description } : {}),
      }],
      payment_source: {
        paypal: {
          experience_context: {
            shipping_preference: 'NO_SHIPPING',  // 无需收货地址
          },
        },
      },
    }),
  });

  const order = await r.json();
  res.json({ orderId: order.id, status: order.status });
});
```

### 后端 — Capture 订单

```javascript
app.post('/orders/capture', async (req, res) => {
  const { orderId } = req.body;
  const token = await getToken();

  const r = await fetch(`https://api.sandbox.paypal.com/v2/checkout/orders/${orderId}/capture`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  const result = await r.json();

  // ⚠️ 关键：只有 capture.status === 'COMPLETED' 才算支付成功
  const capture = result.purchase_units?.[0]?.payments?.captures?.[0];
  if (capture?.status === 'COMPLETED') {
    // 扣款成功，执行业务逻辑（发货、发放权益等）
  }

  res.json(result);
});
```

> **重要**：判断支付成功必须检查 `capture.status === 'COMPLETED'`，而非 `order.status`。`order.status` 只表示订单流程状态，不代表资金已到账。

### 后端 — 查询订单

```javascript
app.get('/orders/:id', async (req, res) => {
  const token = await getToken();
  const r = await fetch(`https://api.sandbox.paypal.com/v2/checkout/orders/${req.params.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const order = await r.json();
  res.json(order);
});
```

### 多币种处理

| 货币 | 小数位 | 示例 |
|------|--------|------|
| USD / EUR / GBP | 2 | `10.00` |
| JPY / TWD | 0 | `1000`（不能有小数，否则报错） |

```javascript
function formatAmount(value, currency) {
  const zeroDecimal = ['JPY', 'TWD', 'HUF', 'KRW'];
  if (zeroDecimal.includes(currency)) {
    return String(Math.round(value));
  }
  return Number(value).toFixed(2);
}
```

---

## 错误处理

### 常见 API 错误

| 错误 | 原因 | 解决 |
|------|------|------|
| `INSTRUMENT_DECLINED` | 卡被拒绝（余额不足、银行拒绝） | 提示用户更换付款方式，不要自动重试 |
| `ORDER_NOT_APPROVED` | 未经买家授权就调 capture | 确保只在 `onApprove` 回调中 capture |
| `UNPROCESSABLE_ENTITY` | 参数错误 / Mastercard 问题 | 检查参数，换 Visa 测试卡 |
| `PERMISSION_DENIED` | ACDC / Vault 未开通 | 去 Dashboard 开通 |
| `INVALID_RESOURCE_ID` | 订单 ID 不存在 | 检查 orderId |
| `RESOURCE_NOT_FOUND` | 资源已被删除或过期 | 重新创建 |
| `DUPLICATE_TRANSACTION` | 短时间内对同一账号发起相同金额支付 | 使用 `PayPal-Request-Id` 幂等 header |
| `401 Unauthorized` | Access Token 过期 | 捕获 401 后重新获取 Token 并重试 |

### 幂等性策略

**两层保护，防止重复扣款：**

```javascript
// 1. API 层：PayPal-Request-Id（72 小时缓存，相同 ID 返回相同结果）
headers['PayPal-Request-Id'] = `order_${Date.now()}_${Math.random()}`;

// 2. 业务层：invoice_id（同一 invoice_id 不能重复 capture）
purchase_units: [{
  invoice_id: 'INV-2024-001',
  amount: { currency_code: 'USD', value: '10.00' },
}]
```

**PayPal-Request-Id 说明：**
- 72 小时内发送相同 ID 的请求，PayPal 返回缓存结果而非重复执行
- 建议每次创建订单生成唯一 ID
- 适用于所有 POST 请求（创建订单、capture、退款等）

### Token 过期自动刷新

```javascript
async function callPayPal(url, options = {}) {
  let token = await getToken();
  let r = await fetch(url, {
    ...options,
    headers: { ...options.headers, Authorization: `Bearer ${token}` },
  });

  // 401 自动刷新 Token 并重试一次
  if (r.status === 401) {
    cachedToken = null;
    token = await getToken();
    r = await fetch(url, {
      ...options,
      headers: { ...options.headers, Authorization: `Bearer ${token}` },
    });
  }

  return r;
}
```

### 前端错误处理

```javascript
paypal.Buttons({
  onError: (err) => {
    // SDK 级别错误（加载失败、配置错误等）
    console.error('PayPal SDK Error:', err);
    showUserMessage('支付系统异常，请稍后重试');
  },

  onApprove: async (data) => {
    try {
      const r = await fetch('/orders/capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: data.orderID }),
      });
      const result = await r.json();

      if (result.name === 'INSTRUMENT_DECLINED') {
        // 卡被拒绝 — 让用户重新选择付款方式
        return actions.restart();
      }

      const capture = result.purchase_units?.[0]?.payments?.captures?.[0];
      if (capture?.status === 'COMPLETED') {
        showSuccessPage(result);
      } else {
        showUserMessage('支付处理中，请稍后查看订单状态');
      }
    } catch (err) {
      console.error('Capture failed:', err);
      showUserMessage('网络异常，请检查订单状态后再试');
    }
  },
}).render('#paypal-button-container');
```

---

## Webhook

### 为什么需要 Webhook

客户端 capture 请求可能丢失（网络中断、App 被杀进程），但用户实际已授权付款。Webhook 是 PayPal 服务器主动推送支付结果的机制，保证最终一致性。

```
支付状态确认优先级：
1. /orders/capture 接口同步返回（实时，首选）
2. Webhook PAYMENT.CAPTURE.COMPLETED（异步补偿）
3. 定时对账脚本（最后兜底）
```

### 需要监听的事件

| 事件 | 含义 | 处理动作 |
|------|------|---------|
| `PAYMENT.CAPTURE.COMPLETED` | 付款成功 | 更新订单状态，发货/发放权益 |
| `PAYMENT.CAPTURE.DENIED` | 付款被拒 | 更新订单 FAILED，通知用户 |
| `PAYMENT.CAPTURE.PENDING` | 付款待处理（风控） | 更新订单 PENDING |
| `PAYMENT.CAPTURE.REFUNDED` | 退款成功 | 更新订单 REFUNDED |
| `CUSTOMER.DISPUTE.CREATED` | 用户发起争议 | 通知运营处理 |
| `CUSTOMER.DISPUTE.RESOLVED` | 争议解决 | 按结果更新订单 |

### 配置 Webhook

在 [developer.paypal.com](https://developer.paypal.com) → Webhooks 中配置：
- **URL**：你的服务器 HTTPS 地址（如 `https://yourdomain.com/webhook`）
- **Events**：勾选需要监听的事件类型

### 处理流程

```javascript
app.post('/webhook', async (req, res) => {
  // ✅ Step 1：立即返回 200，防止 PayPal 认为失败而重发
  res.sendStatus(200);

  // ✅ Step 2：异步处理
  process.nextTick(async () => {
    const event = req.body;

    // ✅ Step 3：验证签名（生产环境必须）
    const isValid = await verifyWebhookSignature(req.headers, req.body);
    if (!isValid) {
      console.warn('Webhook signature invalid:', event?.id);
      return;
    }

    // ✅ Step 4：幂等检查（防重复处理）
    if (processedEvents.has(event.id)) {
      console.log('Webhook already processed:', event.id);
      return;
    }
    processedEvents.add(event.id);

    // ✅ Step 5：业务路由
    switch (event.event_type) {
      case 'PAYMENT.CAPTURE.COMPLETED':
        await handleCaptureCompleted(event);
        break;
      case 'PAYMENT.CAPTURE.DENIED':
        await handleCaptureDenied(event);
        break;
      case 'PAYMENT.CAPTURE.REFUNDED':
        await handleRefunded(event);
        break;
      case 'CUSTOMER.DISPUTE.CREATED':
        await handleDisputeCreated(event);
        break;
      default:
        console.log('Unhandled webhook event:', event.event_type);
    }
  });
});
```

### Webhook 签名验证

```javascript
async function verifyWebhookSignature(headers, body) {
  const token = await getToken();
  const r = await fetch('https://api.sandbox.paypal.com/v1/notifications/verify-webhook-signature', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      auth_algo: headers['paypal-auth-algo'],
      cert_url: headers['paypal-cert-url'],
      transmission_id: headers['paypal-transmission-id'],
      transmission_sig: headers['paypal-transmission-sig'],
      transmission_time: headers['paypal-transmission-time'],
      webhook_id: 'YOUR_WEBHOOK_ID',  // Dashboard 中获取
      webhook_event: body,
    }),
  });
  const result = await r.json();
  return result.verification_status === 'SUCCESS';
}
```

### 处理 PAYMENT.CAPTURE.COMPLETED

```javascript
async function handleCaptureCompleted(event) {
  const capture = event.resource;
  const orderId = capture.supplementary_data?.related_ids?.order_id;
  const captureId = capture.id;
  const amount = capture.amount;

  console.log(`Payment captured: ${captureId}, amount: ${amount.value} ${amount.currency_code}`);

  // 更新订单状态
  // await db.orders.update(orderId, { status: 'CAPTURED', captureId });
  // 发货、发放权益等业务逻辑
}
```

### PayPal 重试机制

PayPal 在 Webhook 投递失败后会自动重试：

```
首次失败后：
  1 分钟 → 重试
  5 分钟 → 重试
  30 分钟 → 重试
  12 小时 → 重试
  ...最多重试 25 次（约 72 小时）
```

- 服务器短暂宕机不会丢失 Webhook
- 超过 72 小时仍失败则永久丢失 → 需要对账脚本兜底

### 对账兜底

定时查询超过 30 分钟仍为 CREATED 状态的订单，主动向 PayPal 查询最新状态：

```javascript
async function reconcileOrders() {
  const staleOrders = getStaleOrders({
    status: 'CREATED',
    createdBefore: new Date(Date.now() - 30 * 60 * 1000),
  });

  for (const order of staleOrders) {
    const token = await getToken();
    const r = await fetch(`https://api.sandbox.paypal.com/v2/checkout/orders/${order.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const paypalOrder = await r.json();

    if (paypalOrder.status === 'COMPLETED') {
      // 更新本地订单状态
      console.log('Reconcile fixed:', order.id);
    }
  }
}
```

> 建议每小时运行一次对账，作为 Webhook 的最后兜底。

---

## 附录：Sandbox 测试

### 测试账号

| 类型 | 用途 |
|------|------|
| Business (Merchant) | 收款方，提供 Client ID / Secret |
| Personal (Buyer) | 付款方，PayPal 钱包支付 |

在 [developer.paypal.com](https://developer.paypal.com) 创建。

### 测试卡号

| 卡号 | 类型 |
|------|------|
| `4012 0000 3333 0026` | Visa（推荐，最稳定） |
| `4032 0385 8498 3157` | Visa 3DS |
| `3714 4963 5398 431` | Amex |

> 过期日期：任意未来日期，CVV：任意 3 位数。
