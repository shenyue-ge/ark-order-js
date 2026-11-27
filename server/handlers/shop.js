// 主页通用商店（ShopModule，功能入口无 funcID 门——任何进度可点）。
// 客户端流程（bc 反编译实证）：
//  1. 点商店按钮 → gotoOpenMainPanel：首次发 m_shop_shops_tos → m_shop_shops_toc.shops=[开启的 shop_id]
//     （空列表 = isInitShop() 假 → 弹"暂未开放"，即本模块要修的 bug）；页签按 CfgShop.firstShopTabArr
//     固定创建，仅当 shop_id ∈ shops 才显示（checkShopTabNav）。
//  2. 切页签发 m_shop_detail_tos([shop_id]) → m_shop_detail_toc.details=[p_shop_detail]
//     （details 必须非空：客户端直接取 details[1].shop_id）。商品全靠此处下发，客户端无商品表。
//  3. 水晶商店组（1/2/3/5）购买走 m_shop_buy_tos；兑换商店组（11+）走 m_score_shop_*（本地服货币
//     不可获得，整组不开启）。商店1 支持 m_shop_refresh_tos 花水晶提前刷新（CfgShop.refreshShopCost=100）。
//  4. tag 十进制位串（ShopUtil.getDecodeNum 从右数位）：末3位=折扣角标、第6-7位=类型(1皮肤/2礼盒)、
//     第8位=已拥有。皮肤"已拥有"按 skinState/背包动态置位。
// 结社商店（shop 8）与改名卡购买（shop5/goods5004）逻辑仍住在 family.js，本模块按 shopId/goodsId 委托。
const D = require('../data/shop_data');
const GD = require('../data/grow_data');
const { S, saveState } = require('../state');
const L = require('../lib');
const { log } = L;
const FAM = require('./family');

function invalidateShopDetailCache(conn) {
  if (conn && conn.invalidateTocCache) conn.invalidateTocCache('shop2');
}

function st() {
  if (!S.shopState) S.shopState = { bought: {}, seedDay: '', rotCount: 0 };
  if (!S.shopState.bought) S.shopState.bought = {};
  return S.shopState;
}

// ---- 商店1 限时特惠：每日 04:00 轮换 + 可花水晶手动刷新 ----
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
function nextRefreshAt() {
  const d = new Date();
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 4, 0, 0);
  if (t <= d) t.setDate(t.getDate() + 1);
  return Math.floor(t.getTime() / 1000);
}
// mulberry32：日期+刷新次数做种，同一天内确定性轮换（重登不变）
function prng(seedStr) {
  let a = 0;
  for (const c of String(seedStr)) a = (a * 31 + c.charCodeAt(0)) >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function clearRotationBought() {
  const b = st().bought;
  for (const k of Object.keys(b)) {
    const n = Number(k);
    if (n >= D.SPECIAL_BASE_ID && n < D.SPECIAL_BASE_ID + 100) delete b[k];
  }
}
function ensureRotation() {
  const s = st();
  const day = todayKey();
  if (s.seedDay !== day) {           // 跨天（或首次）：新一天轮换，清轮换商品购买记录
    s.seedDay = day; s.rotCount = 0;
    clearRotationBought();
  }
}
function specialDefs() {
  ensureRotation();
  const rnd = prng(st().seedDay + ':' + st().rotCount);
  const pool = D.SPECIAL_POOL.slice();
  const picked = [];
  while (picked.length < D.SPECIAL_SIZE && pool.length) {
    picked.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
  }
  return picked.map((p, i) => ({
    id: D.SPECIAL_BASE_ID + i,
    type_id: p.type_id, num: p.num,
    price: Math.max(1, Math.round(p.base * (100 - p.off) / 100)),
    currency: D.CRYSTAL,
    total_times: 99,
    tag: p.off,                     // 末3位=折扣百分点 → 客户端"-N% OFF"角标
    origin_price: p.base,           // 划线原价（getOriginalCostNumStr）
    end_time: nextRefreshAt(),      // 单品剩余购买时间=下次轮换点
  }));
}

// ---- Live2D 皮肤判定 ----
let _live2dSkinIndex;
function isLive2dSkin(skinId) {
  if (!skinId) return false;
  if (!_live2dSkinIndex) {
    _live2dSkinIndex = {};
    try {
      const cfg = require('../skin_config.json');
      for (const id of (cfg.live2dSkins || [])) _live2dSkinIndex[Number(id)] = true;
    } catch (e) { /* no optional skin config in a minimal data set */ }
  }
  return !!_live2dSkinIndex[Number(skinId)];
}

// m_shop_detail_tos is a hot path on the ARM/Jint build. Build the ownership
// indexes once per response instead of doing 162 Array.includes/Array.some
// scans for the skin shop (and the same work again for grow-shop parts).
function makeOwnershipIndex() {
  const out = { skin: {}, l2d: {}, bag: {} };
  const ss = S.skinState || {};
  for (const id of (ss.owned || [])) out.skin[Number(id)] = true;
  for (const id of (ss.l2dOwned || [])) out.l2d[Number(id)] = true;
  for (const g of (S.bagGoods || [])) out.bag[Number(g.type_id)] = true;
  return out;
}

// ---- 皮肤"已拥有"判定：已激活（skinState）或皮肤道具还在背包（买了未使用也算，防重复购） ----
function skinOwned(def) {
  if (S.skinState && S.skinState.owned.includes(def.skin_id)) return true;
  return S.bagGoods.some(g => Number(g.type_id) === Number(def.item_id));
}

function itemP(def, owned) {
  const bought = Number(st().bought[def.id] || 0);
  let tag = def.tag || 0;
  let buyTimes = bought;
  let spec_type = '';
  let spec_data = [];

  if (def.skin_id) {                // 商店2：类型位=皮肤(1)、第8位=已拥有
    const isL2D = !!(def.l2d_price || isLive2dSkin(def.skin_id));
    const baseOwned = !!(owned && (owned.skin[Number(def.skin_id)] || owned.bag[Number(def.item_id)]));
    const l2dOwned = !!(owned && owned.l2d[Number(def.skin_id)]);
    const allOwned = isL2D ? (baseOwned && l2dOwned) : baseOwned;

    tag = baseOwned ? 10100000 : 100000;
    buyTimes = allOwned ? 1 : 0;

    if (isL2D) {
      spec_type = 'p_skin_shop_item';
      spec_data = {
        __nestedProto: 'p_skin_shop_item',
        state: l2dOwned ? 1 : 0,
        has_live: 1,
        buy_type: 1,
        currency: def.currency,
        discount_end: 0,
        origin_price: def.l2d_price || 120,
        price: def.l2d_price || 120,
      };
    }
  } else if (def.part) {            // 御灵士部件（shop34~43）：第8位=已拥有（GrowShopItem.isHasOwn）
    if (owned && owned.bag[Number(def.type_id)]) tag = 10000000;
  } else if (def.buff) {            // 加速引擎/战令：已激活则标记已售罄/已拥有
    const co = require('./collab').st();
    const isOwned = (co.engine && (co.engine[def.buff.type] || co.engine[def.buff.actId])) || bought >= def.total_times;
    if (isOwned) {
      buyTimes = Math.max(buyTimes, def.total_times);
    }
  }
  return {
    id: def.id, type_id: def.type_id, num: def.num, tag,
    price: [{ id: def.currency, val: def.price }],   // ShopItemCommonVO.initPrice 取 price[1]
    currency: def.currency,
    buy_times: buyTimes, total_times: def.total_times,
    end_time: def.end_time || 0, seq: def.id, discount_end: 0,
    origin_price: def.origin_price || def.price,
    spec_type, spec_data,
  };
}

// 部件已拥有 = 背包里有该 type_id（创建赠礼/福袋/商城购买统一入包，见 handlers/grow.js）
function partOwned(typeId) {
  return S.bagGoods.some(g => Number(g.type_id) === Number(typeId));
}

// ---- 快速购买（ShopConst.SHOP_TYPE_FAST = 99）----
// 客户端两处调用 99：
//   · ServantFaithSummonPanel.onClickBtnCall：许愿卡不足时
//     `m_shop_buy_tos(99, ItemConst.TYPE_ID_FAITH_SUMMON_ITEM, N)`（30 水晶/张）—— 本轮实装
//   · FashionHalloweenView.onClickBtnMarry：灵契之戒不足时 `(99, 31000014, 1)`（700 水晶/个）
//     —— **本轮不实装**（属灵契系统，扩范围会动到缔结灵契链路，另开条目）
// 语义 = "只买这一件、不拉商店详情"（`m_shop_buy_toc` 里 `getOrCreateShopTypeVO` 懒建 VO，
// 没有详情也不会崩）。此前 `shopDefs(99)` 返回 null ⇒ `goods 不存在` ⇒ 只回 common_reply，
// 客户端弹不出任何提示（静默失败）。见 调研-信仰.md §3.6。
const FAST_SHOP_GOODS = [
  { id: 31000023, type_id: 31000023, num: 1, price: 30, currency: D.CRYSTAL, total_times: 999 }, // 许愿卡
];

function shopDefs(shopId) {
  if (shopId === 1) return specialDefs();
  if (shopId === 2) return D.SKIN_GOODS;
  if (shopId === 3) return D.SHOP3_GOODS;
  if (shopId === 5) return D.SHOP5_GOODS;
  if (shopId === 11) return D.SHOP11_GOODS;   // 契约兑换（破碎之契）
  if (shopId === 12) return D.SHOP12_GOODS;   // 祈神仪式（破碎之契·稀有档）
  if (shopId === 50) return D.SHOP50_GOODS;   // 小千日记军需商店（饼干 score 2134）
  if (shopId >= 34 && shopId <= 44) return GD.shopDefsOf(shopId); // 御灵士商城（部件 34~43 / 染剂 44）
  if (shopId === 71) return D.SHOP71_GOODS;   // 薄明的圣夜（1737）：货币=圣诞袜 score 2237
  if (shopId === 55) return D.SHOP55_GOODS;   // 爱神的季节小铺（1421）：货币=score 2152
  if (shopId === 59) return D.SHOP59_GOODS;   // 羲和的节日小屋（1490）：货币=score 2172
  if (shopId === 74) return require('../data/collab_data').BILI_SHOP_GOODS; // 苍色的试炼兑换屋（CfgShop[74].scoreType=11 哔哩芯片，走 m_score_shop_*）
  if (shopId === 99) return FAST_SHOP_GOODS;  // 快速购买（信仰召唤许愿卡 / 灵契之戒）
  return null;
}
function detailP(shopId) {
  const defs = shopDefs(shopId);
  if (defs) {
    const owned = makeOwnershipIndex();
    return { shop_id: shopId, shop_goods: defs.map(d => itemP(d, owned)), next_refresh_time: shopId === 1 ? nextRefreshAt() : 0, open_time: 0, end_time: 0 };
  }
  if (shopId === 8) return FAM.shopDetailP(8);  // 结社商店（结社面板内打开）
  return { shop_id: shopId, shop_goods: [], next_refresh_time: 0, open_time: 0, end_time: 0 };
}
function pushDetail(conn, shopId) {
  conn.sendToc('m_shop_detail_toc', { details: [detailP(shopId)] });
}

// 扣水晶：先扣赠送（gold_given）再扣充值（gold）——与结社创建/改名卡同口径
function costCrystal(cost) {
  const useGiven = Math.min(Number(S.roleAsset.gold_given) || 0, cost);
  S.roleAsset.gold_given -= useGiven;
  S.roleAsset.gold -= cost - useGiven;
}

// 商店扣费与发奖必须成对提交。快照只覆盖本次购买会改动的内存状态，发奖异常时恢复，
// 避免出现“货币已扣、次数已增、商品未到账”的半提交状态。
function shopTxSnapshot() {
  return {
    gold: Number(S.roleAsset.gold) || 0,
    gold_given: Number(S.roleAsset.gold_given) || 0,
    silver: Number(S.roleAsset.silver) || 0,
    scores: JSON.parse(JSON.stringify(S.roleAsset.scores || {})),
    bagGoods: S.bagGoods.map(g => ({ ...g })),
    servants: S.servants.map(s => ({ ...s })),
    nextGoodsId: S.nextGoodsId,
    bought: JSON.parse(JSON.stringify((S.shopState && S.shopState.bought) || {})),
    skinState: S.skinState ? JSON.parse(JSON.stringify(S.skinState)) : null,
    collabState: S.collabState ? JSON.parse(JSON.stringify(S.collabState)) : null,
  };
}
function restoreShopTx(snap) {
  S.roleAsset.gold = snap.gold;
  S.roleAsset.gold_given = snap.gold_given;
  S.roleAsset.silver = snap.silver;
  S.roleAsset.scores = snap.scores;
  S.bagGoods = snap.bagGoods;
  S.servants = snap.servants;
  S.nextGoodsId = snap.nextGoodsId;
  st().bought = snap.bought;
  S.skinState = snap.skinState;
  S.collabState = snap.collabState;
}

const handlers = {
// 商店总开关（首页点商店按钮后的第一个请求）：返回开启的 shop_id 列表，空列表=客户端弹"暂未开放"
m_shop_shops_tos(conn) {
  conn.sendToc('m_shop_shops_toc', { shops: D.OPEN_SHOPS });
  log(`[shop] 商店列表下发：[${D.OPEN_SHOPS.join(',')}]`);
},
// 商店详情：details 必须非空（客户端 m_shop_detail_toc 直接取 details[1].shop_id）
m_shop_detail_tos(conn, obj) {
  const ids = ((obj && obj.shop_ids) || []).map(Number).filter(Boolean);
  const list = (ids.length ? ids : [1]).map(detailP);
  conn.sendToc('m_shop_detail_toc', { details: list });
  log(`[shop] 商店详情 [${ids.join(',')}] → ${list.map(d => d.shop_id + ':' + d.shop_goods.length + '件').join(' ')}`);
},
// 购买（水晶商店组）。结社商店(8)与改名卡(5004)委托 family.js 原实现
m_shop_buy_tos(conn, obj) {
  invalidateShopDetailCache(conn);
  const shopId = Number(obj && obj.shop_id);
  const gid = Number(obj && obj.id);
  const num = Math.max(1, Number(obj && obj.num) || 1);
  const opt = Number(obj && obj.opt) || 0;
  const reply = () => conn.sendToc('m_common_reply_toc', { proto_id: 0 });
  if (shopId === 8 || (shopId === 5 && gid === 5004)) return FAM.handlers.m_shop_buy_tos(conn, obj);

  const defs = shopDefs(shopId) || [];
  const def = defs.find(g => g.id === gid);
  if (!def) { log(`[shop] 购买被拒：shop=${shopId} goods=${gid} 不存在`); return reply(); }
  const s = st();
  if (shopId === 1) ensureRotation();       // 轮换可能已跨天，先对齐再校验次数
  const bought = Number(s.bought[gid] || 0);

  const isL2D = def.skin_id ? !!(def.l2d_price || isLive2dSkin(def.skin_id)) : false;
  const baseOwned = def.skin_id ? skinOwned(def) : false;
  const l2dOwned = (S.skinState && S.skinState.l2dOwned && S.skinState.l2dOwned.includes(def.skin_id)) || false;

  if (def.skin_id) {
    if (!isL2D) {
      if (baseOwned) { log(`[shop] 皮肤已拥有拒绝重复购买 ${def.type_id}`); return reply(); }
    } else {
      if (opt === 0) { // OPT_NONE: 仅买原画
        if (baseOwned) { log(`[shop] 皮肤原画已拥有拒绝重复购买 ${def.type_id}`); return reply(); }
      } else if (opt === 1) { // OPT_IMG_L2D: 原画+Live2D 一体购
        if (baseOwned || l2dOwned) { log(`[shop] 皮肤或Live2D已拥有拒绝重复购买 ${def.type_id}`); return reply(); }
      } else if (opt === 2) { // OPT_L2D: 升级Live2D
        if (!baseOwned) { log(`[shop] 未拥有原画无法单独购买Live2D升级 ${def.type_id}`); return reply(); }
        if (l2dOwned) { log(`[shop] Live2D已拥有拒绝重复购买 ${def.type_id}`); return reply(); }
      } else {
        log(`[shop] 未知购买选项 opt=${opt}`); return reply();
      }
    }
  } else {
    if (def.part && partOwned(def.type_id)) { log(`[shop] 御灵士部件已拥有拒绝重复购买 ${def.type_id}`); return reply(); }
    if (def.buff) {
      const co = require('./collab').st();
      if (co.engine && (co.engine[def.buff.type] || co.engine[def.buff.actId])) {
        log(`[shop] 加速引擎已拥有拒绝重复购买 goods=${gid} act=${def.buff.actId}`);
        return reply();
      }
    }
    if (bought + num > def.total_times) { log(`[shop] 购买次数不足 ${bought}/${def.total_times}`); return reply(); }
  }

  let cost = 0;
  if (def.skin_id && isL2D) {
    const basePrice = def.price || 360;
    const l2dPrice = def.l2d_price || 120;
    if (opt === 0) cost = basePrice * num;
    else if (opt === 1) cost = (basePrice + l2dPrice) * num;
    else if (opt === 2) cost = l2dPrice * num;
  } else {
    cost = def.price * num;
  }

  const tx = shopTxSnapshot();
  if (def.currency === D.CRYSTAL) {
    if ((Number(S.roleAsset.gold) || 0) + (Number(S.roleAsset.gold_given) || 0) < cost) {
      log(`[shop] 水晶不足：需 ${cost} 有 ${S.roleAsset.gold + S.roleAsset.gold_given}`); return reply();
    }
    costCrystal(cost);
  } else if (def.currency === D.GOLD) {
    if ((Number(S.roleAsset.silver) || 0) < cost) { log(`[shop] 金币不足：需 ${cost} 有 ${S.roleAsset.silver}`); return reply(); }
    S.roleAsset.silver -= cost;
    try { require('./act_extra').actEvent(conn, 'silver', cost, null); } catch (e) { /* 忽略 */ }
  } else {
    log(`[shop] 未知货币 ${def.currency}`); return reply();
  }
  s.bought[gid] = bought + num;
  if (def.skin_id) {
    if (!S.skinState) S.skinState = { owned: [], l2dOwned: [] };
    if (!S.skinState.owned) S.skinState.owned = [];
    if (!S.skinState.l2dOwned) S.skinState.l2dOwned = [];

    let gain_live = 0;
    if (isL2D) {
      if (opt === 0) {
        if (!S.skinState.owned.includes(def.skin_id)) S.skinState.owned.push(def.skin_id);
        gain_live = 0;
      } else if (opt === 1) {
        if (!S.skinState.owned.includes(def.skin_id)) S.skinState.owned.push(def.skin_id);
        if (!S.skinState.l2dOwned.includes(def.skin_id)) S.skinState.l2dOwned.push(def.skin_id);
        gain_live = 2;
      } else if (opt === 2) {
        if (!S.skinState.l2dOwned.includes(def.skin_id)) S.skinState.l2dOwned.push(def.skin_id);
        gain_live = 2;
      }
    } else {
      if (!S.skinState.owned.includes(def.skin_id)) S.skinState.owned.push(def.skin_id);
      gain_live = 0;
    }

    const gain_servant = require('./servant').skinGainServantFlag(def.skin_id, baseOwned);
    saveState();
    L.pushAssetChange(conn);
    conn.sendToc('m_shop_buy_toc', { shop_id: shopId, id: gid, num, opt });
    conn.sendToc('m_servant_shop_active_skin_toc', { skin_type_id: def.skin_id, gain_live, gain_servant });
    // 新皮肤 → 皮肤图鉴红点/is_new（打开对应图鉴页签时清零）
    const hb = require('./handbook');
    if (hb.onSkinObtained(def.skin_id)) { saveState(); hb.pushSkinRedPoints(conn); }
    log(`[shop] 购买皮肤 ${def.skin_id}（${def.type_id}），opt=${opt}，扣水晶 ${cost}，已激活 gain_live=${gain_live} gain_servant=${gain_servant}`);
    return;
  }
  // collab 特例：加速引擎（buff 1108，StarDreamPermitView 引擎轨解锁）与誓灵（22/33 直接入队）
  if (def.buff) {
    try {
      require('./collab').engineBuy(conn, def.buff.type, def.buff.actId, def.buff.scoreId);
    } catch (e) {
      restoreShopTx(tx);
      log(`[shop] 加速引擎发放失败，已回滚购买：${e.message}`);
      return reply();
    }
    saveState();
    L.pushAssetChange(conn);
    conn.sendToc('m_shop_buy_toc', { shop_id: shopId, id: gid, num, opt });
    return;
  }
  if (def.servant) {
    try {
      // type_id 是 CfgItems 誓灵凭证（30000000+誓灵type，见 collab_data.js BILI_SHOP_GOODS 注）：
      // `% 10^7` 还原誓灵 type（=客户端 ServantUtil.getServandTypeID_by_TypeID 同式；对 7 位裸 type 幂等）
      if (!require('./collab').grantServant(conn, Number(def.type_id) % 10000000)) throw new Error('invalid servant reward');
    } catch (e) {
      restoreShopTx(tx);
      log(`[shop] 誓灵发放失败，已回滚购买：${e.message}`);
      return reply();
    }
    saveState();
    L.pushAssetChange(conn);
    conn.sendToc('m_shop_buy_toc', { shop_id: shopId, id: gid, num, opt });
    log(`[shop] 购买誓灵 shop=${shopId} goods=${gid} type=${def.type_id}`);
    return;
  }
  let changed;
  try {
    changed = L.grantGoods(def.type_id, def.num * num, conn);
  } catch (e) {
    restoreShopTx(tx);
    log(`[shop] 商品发放失败，已回滚购买：${e.message}`);
    return reply();
  }
  saveState();
  L.pushAssetChange(conn);
  if (changed.length) L.pushGoodsUpdate(conn, changed, 3);   // 必须显式 3(GOODS_OP_UPDATE)：传 [] 会编码成 0，客户端不入包（真机实证 2026-08-24）
  conn.sendToc('m_shop_buy_toc', { shop_id: shopId, id: gid, num, opt });
  log(`[shop] 购买 shop=${shopId} goods=${gid} ${def.type_id}×${def.num * num}，扣${def.currency === D.CRYSTAL ? '水晶' : '金币'} ${cost}`);
},
// 购物车批量购买（御灵士商城 GrowShopPanel.onClickBtnBuyTry：试穿列表一键购）。
// tos.list=[p_kvt{id:shop_id, val:goods_id, type:1}]；逐条走 m_shop_buy_tos 同款校验/扣费/入包，
// 任一条失败不中断其余（客户端只按 toc 列表清试穿标记）。回 toc.list 与请求对齐（id/val 原样）。
m_multi_shop_buy_tos(conn, obj) {
  invalidateShopDetailCache(conn);
  const reqs = Array.isArray(obj && obj.list) ? obj.list : [];
  const results = [];
  for (const r of reqs) {
    const shopId = Number(r && r.id);
    const gid = Number(r && r.val);
    const defs = shopDefs(shopId) || [];
    const def = defs.find(g => g.id === gid);
    if (!def) { log(`[shop] 购物车跳过：shop=${shopId} goods=${gid} 不存在`); continue; }
    if (def.part && partOwned(def.type_id)) { log(`[shop] 购物车跳过已拥有部件 ${def.type_id}`); continue; }
    const s = st();
    const bought = Number(s.bought[gid] || 0);
    if (bought + 1 > def.total_times) { log(`[shop] 购物车跳过次数不足 goods=${gid}`); continue; }
    const cost = def.price;
    const tx = shopTxSnapshot();
    if (def.currency === D.CRYSTAL) {
      if ((Number(S.roleAsset.gold) || 0) + (Number(S.roleAsset.gold_given) || 0) < cost) { log(`[shop] 购物车水晶不足 goods=${gid}`); continue; }
      costCrystal(cost);
    } else if (def.currency === D.GOLD) {
      if ((Number(S.roleAsset.silver) || 0) < cost) { log(`[shop] 购物车金币不足 goods=${gid}`); continue; }
      S.roleAsset.silver -= cost;
    } else { log(`[shop] 购物车未知货币 ${def.currency} goods=${gid}`); continue; }
    s.bought[gid] = bought + 1;
    let changed;
    try {
      changed = L.grantGoods(def.type_id, def.num, conn);
    } catch (e) {
      restoreShopTx(tx);
      log(`[shop] 购物车商品发放失败，已回滚 goods=${gid}：${e.message}`);
      continue;
    }
    if (changed.length) L.pushGoodsUpdate(conn, changed, 3);
    results.push({ id: shopId, val: gid, type: 1 });
    log(`[shop] 购物车购买 shop=${shopId} goods=${gid} type_id=${def.type_id}，扣 ${def.currency === D.CRYSTAL ? '水晶' : '金币'} ${cost}`);
  }
  saveState();
  L.pushAssetChange(conn);
  conn.sendToc('m_multi_shop_buy_toc', { list: results });
},
// 商店1 刷新特惠：花 100 水晶（CfgShop.refreshShopCost）换新一批轮换；无独立 toc，直接重推详情
m_shop_refresh_tos(conn, obj) {
  const shopId = Number(obj && obj.shop_id);
  if (shopId !== 1) { conn.sendToc('m_common_reply_toc', { proto_id: 0 }); return; }
  const cost = D.REFRESH_COST;
  if ((Number(S.roleAsset.gold) || 0) + (Number(S.roleAsset.gold_given) || 0) < cost) {
    log('[shop] 刷新特惠水晶不足'); conn.sendToc('m_common_reply_toc', { proto_id: 0 }); return;
  }
  costCrystal(cost);
  const s = st();
  s.seedDay = todayKey();
  s.rotCount += 1;
  clearRotationBought();
  saveState();
  L.pushAssetChange(conn);
  pushDetail(conn, 1);
  log(`[shop] 刷新限时特惠（第 ${s.rotCount} 次手动），扣水晶 ${cost}`);
},
// 买金币（CfgShop.silvers：50 水晶→按御灵士等级档金币；本地服等级未实现，取第 1 档 1000）
m_silver_buy_tos(conn) {
  const gain = D.SILVERS[0][2];
  const cost = D.SILVER_COST;
  if ((Number(S.roleAsset.gold) || 0) + (Number(S.roleAsset.gold_given) || 0) < cost) {
    log('[shop] 买金币水晶不足'); conn.sendToc('m_common_reply_toc', { proto_id: 0 }); return;
  }
  costCrystal(cost);
  S.roleAsset.silver = (Number(S.roleAsset.silver) || 0) + gain;
  saveState();
  L.pushAssetChange(conn);
  conn.sendToc('m_silver_buy_toc', { add_silver: gain, reduce_gold: cost });
  log(`[shop] 买金币 +${gain}，扣水晶 ${cost}`);
},
// 充值面板兜底（商店4 未开启，正常不会请求；pay_shop_list[1] 若为空数组客户端会 nil 索引崩 → 填一个空商店）
m_pay_shop_info_tos(conn) {
  conn.sendToc('m_pay_shop_info_toc', {
    month_card_times: 0, week_card_times: [], buy_times_list: [],
    pay_shop_list: [{ shop_id: 4, shop_goods: [], next_refresh_time: 0, open_time: 0, end_time: 0 }],
  });
},
// 兑换商店组（m_score_shop_*，ExchangeItemVO/RareVO 的 isNormalShop=false 走这一族）：
// 11 契约兑换 / 12 祈神仪式，货币=破碎之契（score 3，誓约破除产出）。
// details 必须非空——兜底 defaultFill 会发空 details，客户端 m_score_shop_detail_toc 取 details[1].shop_id 直接崩
m_score_shop_detail_tos(conn, obj) {
  const ids = ((obj && obj.shop_ids) || []).map(Number).filter(Boolean);
  const list = (ids.length ? ids : [11]).map(id => detailP(id));
  conn.sendToc('m_score_shop_detail_toc', { details: list, shop_version: 0 });
  log(`[shop] 兑换商店详情 [${ids.join(',')}] → ${list.map(d => d.shop_id + ':' + d.shop_goods.length + '件').join(' ')}`);
},
// 兑换购买：扣破碎之契（score），回 m_score_shop_buy_toc（客户端 updateBuyItemNum → 已购次数+num）
m_score_shop_buy_tos(conn, obj) {
  invalidateShopDetailCache(conn);
  const shopId = Number(obj && obj.shop_id);
  const gid = Number(obj && obj.id);
  const num = Math.max(1, Number(obj && obj.num) || 1);
  const ver = Number(obj && obj.shop_version) || 0;
  const reply = () => conn.sendToc('m_common_reply_toc', { proto_id: 0 });
  const defs = shopDefs(shopId) || [];
  const def = defs.find(g => g.id === gid);
  if (!def) { log(`[shop] 兑换被拒：shop=${shopId} goods=${gid} 不存在`); return reply(); }
  const s = st();
  const bought = Number(s.bought[gid] || 0);
  if (bought + num > def.total_times) { log(`[shop] 兑换次数不足 ${bought}/${def.total_times}`); return reply(); }
  const cost = def.price * num;
  if (L.getScore(def.currency) < cost) { log(`[shop] 兑换货币不足：需 ${cost} 有 ${L.getScore(def.currency)}`); return reply(); }
  const tx = shopTxSnapshot();
  L.addScore(conn, def.currency, -cost);
  s.bought[gid] = bought + num;
  // collab 特例：誓灵类商品（22/33）直接入队（form 上没有对应道具，grantGoods 会发出无效物品）
  if (def.servant) {
    // 兑换商店同样遵守扣分与发奖原子性；这里保存快照必须在扣分前完成。
    // 旧路径已扣分，失败时按兑换金额补回，次数和新誓灵由快照恢复。
    try {
      // type_id 是誓灵凭证（30000000+誓灵type），`% 10^7` 还原（同客户端 getServandTypeID_by_TypeID；对裸 type 幂等）
      if (!require('./collab').grantServant(conn, Number(def.type_id) % 10000000)) throw new Error('invalid servant reward');
    } catch (e) {
      restoreShopTx(tx);
      log(`[shop] 兑换誓灵发放失败，已回滚积分：${e.message}`);
      return reply();
    }
    saveState();
    conn.sendToc('m_score_shop_buy_toc', { shop_id: shopId, id: gid, num, shop_version: ver });
    log(`[shop] 兑换誓灵 shop=${shopId} goods=${gid} type=${def.type_id}，扣 score ${def.currency} ${cost}`);
    return;
  }
  let changed;
  try {
    changed = L.grantGoods(def.type_id, def.num * num, conn);
  } catch (e) {
    restoreShopTx(tx);
    log(`[shop] 兑换商品发放失败，已回滚积分：${e.message}`);
    return reply();
  }
  saveState();
  if (changed.length) L.pushGoodsUpdate(conn, changed, 3);
  conn.sendToc('m_score_shop_buy_toc', { shop_id: shopId, id: gid, num, shop_version: ver });
  log(`[shop] 兑换 shop=${shopId} goods=${gid} ${def.type_id}×${def.num * num}，扣 score ${def.currency} ${cost} → 余 ${L.getScore(def.currency)}`);
},
};

module.exports = { handlers, detailP, itemP, specialDefs, nextRefreshAt };
