// 召唤（Summon/卡池）全链路：卡池列表 / 概率详情 / 抽卡结算 / 卡池关闭 / 灵契召唤。
//
// ── 客户端事实（tools/bc_cmp/summon_new/ 反编译实证）──
// · 卡池界面元数据（名称/背景/消耗/概率文案/UP specialList）在客户端 CfgSummon；
//   每池的**角色掉落列表**配置里是空 {}，运行时由本模块 m_role_summon_pool_toc 下发
//   （SummonTipPanel.changeDataList 按 typeId 第 3 位分 UR/SR/R/N 桶，rateTip = val/1000 显示 "N%"）。
// · 抽卡结果展示由两条协议合流：m_servant_update_toc{new, reward_type=5} 把新誓灵塞进
//   OutCardMgr（OutCardVO.itemTypeID = type+30000000），m_role_servant_summon_toc 的
//   summon_rewards 只把**材料**塞进队列（isServantItem 的会被跳过）、并作为结算网格数据。
//   ⇒ 推送顺序：货币/物品变更 → m_servant_update_toc → m_role_servant_summon_toc（最后）。
// · summon_rewards[].val = "NEW" 角标（val!=0 显示）；protect_rewards = 保底奖励
//   （客户端先从展示队列摘除，结算动画播完后单独以 REWARD_TYPE_SUMMON_SPECIAL 再播）。
// · info.list[].time 语义 = **该池累计已抽数**（initTimes 建 timesDic；新手池首连 5 张折扣、
//   "剩余N次可触发奇迹召唤" 都读它），不是时间戳。
// · m_servant_update_toc 的 p_servant_add.servant schema 标 array 实为单对象（老坑，与 map_fight 同口径）。
const { S, saveState } = require('../state');
const L = require('../lib');
const { log, pushGoodsUpdate, pushAssetChange, getScore, addScore } = L;
const SD = require('../data/summon_data');
const R = require('../data/summon_rules');
const HB = require('./handbook'); // isUnlocked：is_first/NEW 角标的唯一权威口径（图鉴未激活=NEW）

const nowSec = () => Math.floor(Date.now() / 1000);
const dayKey = () => new Date().toLocaleDateString('sv');

// 卡池配置（生成数据镜像）；id → pool
const poolOf = id => SD.POOLS.find(p => p.id === Number(id));

function st() {
  if (!S.summonState) S.summonState = {};
  const s = S.summonState;
  if (!s.day) s.day = dayKey();
  if (!s.pulls) s.pulls = {};        // {poolId: 累计抽数}
  if (!s.dayPulls) s.dayPulls = {};  // {poolId: 今日抽数}
  if (!s.freeUsed) s.freeUsed = {};  // {poolId: 今日已用免费十连}
  if (s.pityVersion !== 2) {         // v2：保底改"连续未获得 UP"口径，旧"已拥有停表"计数（含 150 冻结值）作废重计
    s.pity = {};                     // {poolId: 保底计数}
    s.pityVersion = 2;
  }
  if (!Array.isArray(s.affinityGot)) s.affinityGot = []; // 已灵契兑换的 servantTypeID
  if (!s.closed) s.closed = {};      // {poolId: 关闭时刻}
  if (s.day !== dayKey()) {          // 跨天：免费十连/每日计数重置
    s.day = dayKey();
    s.dayPulls = {};
    s.freeUsed = {};
    log(`[summon] 每日重置：免费十连/每日计数（${s.day}）`);
  }
  return s;
}

// 今日剩余免费十连
function freeLeft(poolId) {
  const allowed = R.DAILY_FREE_TEN[poolId] || 0;
  return Math.max(0, allowed - (st().freeUsed[poolId] || 0));
}

// 召唤券（cost.type=3 的道具，约定之契 31000004）数量与消耗
const ticketCountOf = (itemId) => {
  const g = S.bagGoods.find(x => x.type_id === Number(itemId));
  return g ? g.cur_num : 0;
};
function consumeItem(conn, itemId, n) {
  const g = S.bagGoods.find(x => x.type_id === Number(itemId));
  if (!g) return;
  g.cur_num -= n;
  if (g.cur_num <= 0) {
    S.bagGoods.splice(S.bagGoods.indexOf(g), 1);
    // 消耗/删除路径 opType=2 且必须带 goods(id) 供客户端 delGoods（见 工作日志 商店条目）
    pushGoodsUpdate(conn, [{ id: g.id, type_id: g.type_id, cur_num: 0, bag_type: g.bag_type }], 2);
  } else {
    pushGoodsUpdate(conn, [g], 3);
  }
}

// ── info：m_role_summon_info_tos → 卡池列表 + 保底计数 ──
function buildInfoList() {
  const s = st();
  const list = [];
  for (const p of SD.POOLS) {
    if (!R.isPoolOpen(p.id, s.closed, nowSec())) continue;
    if (!R.poolWeights(p.id)) continue;
    const isNewbieClosed = p.id === R.NEWBIE_POOL_ID && (s.pulls[p.id] || 0) >= R.NEWBIE_TOTAL_LIMIT;
    if (isNewbieClosed) continue; // 抽满 20 次客户端本地也会移除（setTimes→clearSummonVO）
    list.push({
      id: p.id,
      time: s.pulls[p.id] || 0,                 // 累计抽数（不是时间戳！见文件头注释）
      start_time: p.id === 1 || p.id === 2 || p.id === R.NEWBIE_POOL_ID ? 0 : nowSec() - 7 * 86400,
      end_time: p.id === 1 || p.id === 2 || p.id === R.NEWBIE_POOL_ID ? 0 : nowSec() + 365 * 86400,
      type: p.id === 1 || p.id === 2 || p.id === R.NEWBIE_POOL_ID ? 1 : 2, // 2 = 限定池（顶部时间条样式）
      day_times: s.dayPulls[p.id] || 0,
      close_time: s.closed[p.id] || 0,
      daily_free_times: freeLeft(p.id),
    });
  }
  return list;
}

function handleSummonInfo(conn) {
  const s = st();
  // select_list：官方仅用于定向自选 UP 池（isSelect=true）。
  // 不可把神谕/灵契召唤（id=12）塞进 select_list：官方客户端 SummonMgr.initSummonList 已显式
  // 跳过 id=12，并将其重构成独立 PopupPanel 迁至「唤灵殿堂 → 召唤」（CopyDarePanel.onClickBtnSummon
  // → SummonModule.openAffinityView）。经 select_list 强塞进 SummonPanel 会激活废弃的
  // updateNormalAffinity 遗留路径：二次打开只走 setActive(true) 不入 WindowsManager.panelStack，
  // 导致点关闭按钮（btnClose → WindowsManager.close）永远返回 false、页面彻底卡死无法关闭。
  const selectList = [];
  // protect_list：保底计数（p_kvi {id: poolId, val: 计数}），面板显示 "x/150"
  const protectList = R.PITY_POOLS
    .filter(p => (s.pity[p.poolId] || 0) > 0)
    .map(p => ({ id: p.poolId, val: s.pity[p.poolId] }));
  const list = buildInfoList();
  conn.sendToc('m_role_summon_info_toc', {
    shop_price: 50,   // 约定之契自动补购单价（SummonMgr.buyPrice）
    list,
    protect_list: protectList,
    select_list: selectList,
  });
  log(`[summon] 卡池列表 ${list.length} 池（免费十连剩余 ${freeLeft(1)}）`);
}

// ── pool：m_role_summon_pool_tos → 某池概率详情（角色 + 权重）──
function handleSummonPool(conn, obj) {
  const poolId = Number(obj && obj.summon_type) || 0;
  const weights = R.poolWeights(poolId);
  conn.sendToc('m_role_summon_pool_toc', {
    summon_type: poolId,
    last_modified: R.CONTENT_VERSION,
    summon_rewards: weights
      ? Object.entries(weights).map(([t, v]) => ({ id: 30000000 + Number(t), val: v }))
      : [],
    need_unlock: [],   // "(图鉴开启后加入)" 条目；本地服无隐藏角色
  });
}

// ── 召唤结算推送（货币/物品 → 新誓灵 → summon_toc 的顺序见文件头）──
// grants: [{brief, isNew}]；protects: 保底发放的 servantType 列表（走 protect_rewards 单独展示）
function pushSummonResult(conn, pool, results, grants, protects) {
  const s = st();
  // 1) 材料入包（友情池产出的结晶等）
  const mats = results.filter(x => x.kind === 'mat');
  if (mats.length) {
    const changed = [];
    for (const m of mats) changed.push(...L.grantGoods(m.type, 1, conn));
    const merged = new Map();
    for (const g of changed) merged.set(g.type_id, g);
    pushGoodsUpdate(conn, [...merged.values()], 3);
  }
  // 2) 新誓灵（m_servant_update_toc：new+reward_type=5 → ServantMgr.addServant + OutCardMgr 队列）
  if (grants.length) {
    conn.sendToc('m_servant_update_toc', {
      new: grants.map(g => ({
        servant: g.brief,
        is_first: g.isNew ? 1 : 0,
      })),
      update: [],
      del: [],
      reward_type: 5, // ServantConst.REWARD_TYPE_SUMMON
    });
  }
  // 3) summon_toc：summon_rewards = 全部结果（id=30000000+type / 材料道具id；val=NEW 角标）
  //    同一次十连里重复获得的同类只标第一只 NEW
  const seen = new Set();
  const summonRewards = results.map(x => {
    if (x.kind !== 'servant') return { id: x.type, val: 0 };
    const isNew = grants.some(g => g.brief.type === x.type && g.isNew) && !seen.has(x.type);
    seen.add(x.type);
    return { id: 30000000 + x.type, val: isNew ? 1 : 0 };
  });
  conn.sendToc('m_role_servant_summon_toc', {
    summon_type: pool.id,
    summon_rewards: summonRewards,
    protect_rewards: protects.map(t => ({ id: 30000000 + t, val: 1 })),
    protect_times: s.pity[pool.id] || 0,
    summon_times: s.pulls[pool.id] || 0,
    day_times: s.dayPulls[pool.id] || 0,
    act_id: 0,
    daily_free_times: freeLeft(pool.id),
  });
}

// ── 抽卡：m_role_servant_summon_tos{summon_type, summon_times, act_id} ──
function handleSummon(conn, obj) {
  const poolId = Number(obj && obj.summon_type) || 0;
  const times = Number(obj && obj.summon_times) || 0;
  const err = (code, why) => { conn.sendToc('m_common_error_toc', { code }); log(`[summon] 拒绝（${code}）：${why}`); };
  const pool = poolOf(poolId);
  if (!pool || !R.poolWeights(poolId)) return err(R.ERR.NO_CFG, `卡池 ${poolId} 无配置`);
  if (!R.OPEN_POOL_IDS.includes(poolId)) return err(R.ERR.ACT_POOL_CLOSED, `卡池 ${poolId} 未开放`);
  if (times !== R.SUMMON_TIMES_ONE && times !== R.SUMMON_TIMES_TEN) return err(R.ERR.COND, `次数非法 ${times}`);
  if (poolId === R.NEWBIE_POOL_ID && times !== R.SUMMON_TIMES_TEN) return err(R.ERR.NEWBIE_TEN_ONLY, '新手池只能十连');
  const s = st();
  if (poolId === R.NEWBIE_POOL_ID && (s.pulls[poolId] || 0) + times > R.NEWBIE_TOTAL_LIMIT) {
    return err(R.ERR.DAY_LIMIT, '新手池累计 20 次上限');
  }
  // 先生成并校验本轮结果，再扣除召唤资源。配置中若出现客户端不存在的誓灵类型，
  // 必须整轮拒绝，不能让玩家付费后只得到空结果。
  // ⚠️ 校验必须用纯白名单谓词，不能走 makeServantBrief——其内部会激活图鉴，
  // 把下面的 isNew（先判后建卡）全体污染成"已拥有"（2026-10-24 smoke_summon 实测 is_first 全 0）
  const results = R.rollPool(poolId, times);
  const VALID_TYPE = require('../data/servant_types').isValidServantType;
  for (const x of results) {
    if (x.kind === 'servant' && !VALID_TYPE(x.type)) {
      return err(R.ERR.NO_CFG, `卡池 ${poolId} 产出非法誓灵 ${x.type}`);
    }
  }

  // 免费十连（daily_free_times>0 时客户端把十连按钮换成"免费"直发 summon_times=10，不扣费）
  const isFreeTen = times === R.SUMMON_TIMES_TEN && freeLeft(poolId) > 0;
  if (!isFreeTen) {
    const cost = pool.cost[0] || { type: 3, id: R.TICKET_ITEM, num: 1, sliver: 50, isAutoBuy: true };
    if (cost.type === 2) {
      // 积分池：cost.id = role_scores id（2=友情点 → 官方码 455003，其它积分 → 455001）
      const need = cost.num * times;
      if (getScore(cost.id) < need) {
        return err(cost.id === 2 ? R.ERR.FRIEND_NOT_ENOUGH : R.ERR.COND, `积分 ${cost.id} 不足 ${getScore(cost.id)}/${need}`);
      }
      addScore(conn, cost.id, -need);
    } else {
      // 召唤券池：消耗道具，缺口按 buyPrice 水晶/张自动补购（SummonAlertPanel 同口径）
      const have = ticketCountOf(cost.id);
      const plan = R.ticketPlan(poolId, times, have, s.pulls[poolId] || 0, cost.num);
      if (plan.buyCount > 0) {
        const cry = plan.buyCount * 50; // shop_price
        const totalGold = (Number(S.roleAsset.gold) || 0) + (Number(S.roleAsset.gold_given) || 0);
        if (totalGold < cry) return err(R.ERR.GOLD_SHORT, `水晶不足（补购 ${plan.buyCount} 张需 ${cry}）`);
      }
      if (plan.useTickets > 0) consumeItem(conn, cost.id, plan.useTickets);
      if (plan.buyCount > 0) {
        let left = plan.buyCount * 50;
        const useGiven = Math.min(Number(S.roleAsset.gold_given) || 0, left);
        S.roleAsset.gold_given -= useGiven; left -= useGiven;
        S.roleAsset.gold -= left;
        pushAssetChange(conn);
      }
    }
  } else {
    s.freeUsed[poolId] = (s.freeUsed[poolId] || 0) + 1;
  }

  // 抽取 + 发放。isNew = 该 type 图鉴未激活（先判后建卡：makeServantBrief 会激活图鉴，
  // 同一十连第二只同款自然去重；拥有后破除再获得也不再误标 NEW）
  const grants = [];
  for (const x of results) {
    if (x.kind !== 'servant') continue;
    const isNew = !HB.isUnlocked(x.type);
    const brief = require('./servant').makeServantBrief(x.type);
    if (!brief) continue; // 非法 type（已记日志）：不入列、不推送，避免毒化客户端类型计数表
    grants.push({ brief, isNew });
    require('./servant').grantServantBrief(brief);
  }
  // 保底（"连续 150 次未获得 UP"口径，本轮自然抽出 UP 时链条重置、不触发）：
  // 达阈值 → 额外发放走 protect_rewards（客户端结算动画后单独播）
  const pit = R.pityStep(poolId, results.filter(x => x.kind === 'servant').map(x => x.type), s.pity[poolId] || 0);
  s.pity[poolId] = pit.pity;
  const protects = [];
  if (pit.grant) {
    const pityNew = !HB.isUnlocked(pit.grant); // 先判后建卡：第二轮保底重复 UP 不再误标 NEW
    const brief = require('./servant').makeServantBrief(pit.grant);
    if (brief) {
      require('./servant').grantServantBrief(brief);
      grants.push({ brief, isNew: pityNew });
      protects.push(pit.grant);
      log(`[summon] 保底触发：池 ${poolId} 必得 ${pit.grant}`);
    }
  }
  // 计数
  s.pulls[poolId] = (s.pulls[poolId] || 0) + times;
  s.dayPulls[poolId] = (s.dayPulls[poolId] || 0) + times;
  // 新手池抽满 → 关闭（客户端 setTimes 也会本地移除；补 close_time 供 72h 倒计时展示）
  if (poolId === R.NEWBIE_POOL_ID && s.pulls[poolId] >= R.NEWBIE_TOTAL_LIMIT) {
    s.closed[poolId] = nowSec();
    log('[summon] 新手卡池抽满关闭');
  }

  // 任务：cond 7「进行N次誓灵召唤」+ cond 66「通过战斗或召唤获得誓灵N名」
  const newCount = grants.filter(g => g.isNew).length + protects.length;
  try { require('./activity').advanceMissions(conn, { summonCount: times, gainServant: newCount }); } catch (e) { /* 任务未就绪不阻塞 */ }
  // UR 计数（含保底 UR）：活动事件与成就共用
  const urTypes = results.filter(x => x.kind === 'servant' && Math.floor(x.type / 10000) % 10 === 4).length
    + protects.filter(t => Math.floor(t / 10000) % 10 === 4).length;
  try {
    require('./act_extra').actEvent(conn, 'summon', times, null);
    require('./act_extra').actEvent(conn, 'gain', newCount, { ur: urTypes });
  } catch (e) { /* 忽略 */ }
  // 成就：45xxx 召唤次数 / 43xxx 连续不出UR / 44xxx 十连UR数
  try { require('./achievement').addSummon(times, urTypes > 0, urTypes, times === 10); } catch (e) { /* 忽略 */ }

  pushSummonResult(conn, pool, results, grants, protects);
  // 新誓灵 → 图鉴红点 + 祭坛名气 diff（复用战斗掉落同款推送；在 summon_toc 之后）
  try { require('./handbook').pushRedPoints(conn); } catch (e) { /* 忽略 */ }
  try { require('./altar').pushFameUpdates(conn); } catch (e) { /* 忽略 */ }
  // 言灵录："获得X"（新誓灵：grants 里的 brief + 保底 protects）
  try {
    const MM = require('./moment');
    MM.onServantObtained(grants.filter(g => g.isNew).map(g => Number(g.brief.type)).concat(protects.map(Number)));
    MM.checkUnlocks(conn);
  } catch (e) { /* 忽略 */ }
  saveState();
  log(`[summon] 池 ${pool.id}「${pool.name}」×${times}${isFreeTen ? '(免费)' : ''} → ${results.map(x => x.kind === 'servant' ? x.type : `道具${x.type}`).join(',')}${protects.length ? ` +保底${protects.join(',')}` : ''}（累计 ${s.pulls[poolId]}）`);
}

// ── 手动关闭卡池（面板只有新手池有该按钮）──
function handleCloseSummon(conn, obj) {
  const poolId = Number(obj && obj.summon_type) || 0;
  const s = st();
  s.closed[poolId] = nowSec();
  saveState();
  // 客户端 setSummonCloseTimes(close_time + 259200) 展示 72h 倒计时
  conn.sendToc('m_role_summon_close_toc', { summon_type: poolId, close_time: nowSec() });
  log(`[summon] 手动关闭卡池 ${poolId}`);
}

// ── firstReward 池点击上报（firstRewardPools={97}；无 toc schema，静默记账）──
function handleTouchPool(conn, obj) {
  log(`[summon] touch pool ${obj && obj.pool_id}`);
  // 必须回包（D2 / 二百二十二）：这条协议**没有同名 toc**，客户端也没有对应 handler，
  // 但它每点一次卡池就发一次。旧实现只记日志 ⇒ 连点卡池时链路上没有别的流量，
  // 3 秒后必弹「服务端未响应」（2026-10-23 平板真机 23:36:23 连点三下 → 23:36:36 弹框）。
  conn.sendToc('m_common_reply_toc', { proto_id: 0 });
}

// ── 灵契召唤（affinity）：材料(score 15/17)换誓灵 ──
function handleAffinityInfo(conn) {
  conn.sendToc('m_affinity_summon_info_toc', { list: st().affinityGot });
}

function handleAffinitySummon(conn, obj) {
  const servantType = Number(obj && obj.servant_type) || 0;
  const cfg = SD.AFFINITY_SERVANTS.find(a => a.servantTypeID === servantType);
  const err = (code, why) => { conn.sendToc('m_common_error_toc', { code }); log(`[summon] 灵契召唤拒绝（${code}）：${why}`); };
  if (!cfg) return err(R.ERR_AFFINITY.NO_CFG, `灵契配置不存在 ${servantType}`);
  // 材料是 role_scores（客户端 SummonConfig.getAffinityMatScoreID = CfgSummon.affinityMats[item][1]，
  // 即 data/score_items.js 的同一张表；此处统一走 scoreIdOfItem，避免两份映射漂移）
  for (const [matId, need] of cfg.needMat) {
    const scoreId = L.scoreIdOfItem(matId);
    if (!scoreId || getScore(scoreId) < need) return err(R.ERR_AFFINITY.MATERIAL, `材料 ${matId}（score ${scoreId}）不足 ${getScore(scoreId)}/${need}`);
  }
  // 建卡校验必须**先于扣材料**：非法 type 时既不发誓灵也不吃材料（否则玩家白白损失积分）
  const first = HB.isUnlocked(servantType) ? 0 : 1; // 先判后建卡：makeServantBrief 会激活图鉴
  const brief = require('./servant').makeServantBrief(servantType);
  if (!brief) return err(R.ERR_AFFINITY.NO_CFG, `誓灵 type=${servantType} 非法（客户端 CfgServant 无此 typeId）`);
  for (const [matId, need] of cfg.needMat) addScore(conn, L.scoreIdOfItem(matId), -need);
  // 发誓灵（reward_type=7 SUMMON_SPECIAL：OutCard 无开门动画的卡片展示）
  require('./servant').grantServantBrief(brief);
  conn.sendToc('m_servant_update_toc', {
    new: [{ servant: brief, is_first: first }],
    update: [],
    del: [],
    reward_type: 7,
  });
  st().affinityGot.push(servantType);
  saveState();
  conn.sendToc('m_affinity_summon_toc', { servant_type: servantType });
  log(`[summon] 灵契召唤获得 ${servantType}（消耗 ${cfg.needMat.map(([m, n]) => `${m}×${n}`).join(' + ')}）`);
}

// ── 凭神回响（echo）：回响之契（role_scores 28）兑换指定誓灵 ──
// 客户端事实（SummonEchoExchangePanel / SummonEchoItemPopupPanel / SummonEchoExchangeAlertPanel）：
//  · 入口：SummonPanel.btnExchange，显隐 = ActivityMgr.isOpenAct(ActivityConst.ACT_ECHO=1009)。
//    CfgActivity[1009] actKind=0（无 viewClass、不进活动面板左侧列表，ActivityMgr.addAct 对
//    actKind==0 只建 VO 不入 uv1）⇒ 下发它只是"开关"，不会 create(nil) 崩。
//  · 打开面板 → m_echo_shop_info_tos → toc.items=[p_echo_item{type_id,price,buy_times,total_times}]；
//    type_id 是**誓灵道具 id**（=30000000+type），客户端 ItemConfig.getItemVO(type_id) 取不到就崩。
//  · 点条目 → 弹窗（price 与 getScore(28) 比较）→ 确认 → m_echo_exchange_tos{item=type_id, num}，
//    num 由客户端硬编码 1。
//  · m_echo_exchange_toc **只 dispatch 刷新回响数字**，誓灵到货全靠 m_servant_update_toc。
//  · m_echo_servant_info_tos **客户端从不主动发**（反编译全库无调用方）——它只在分解面板
//    （SummonDecomposeSelectPanel/SummonDecomposePanel 的 lblEcho）里被 getCanGetEchoServantList
//    消费 ⇒ 服务端必须主动推，否则"分解 UR 预计得 100 回响"恒显示 0。
const ECHO = require('../data/echo_shop_data');
const ECHO_ERR = { NOT_ALLOWED: 925001, NOT_ENOUGH: 925002 }; // CfgErrorCode 925001/925002（TYPE_TIP 弹提示）

function echoBought() {
  const s = st();
  if (!s.echoBought) s.echoBought = {};   // {type_id: 已兑换数}
  return s.echoBought;
}
function echoShopItems() {
  const bought = echoBought();
  return ECHO.SERVANTS.map(g => ({
    type_id: g.type_id,
    price: ECHO.PRICE,
    buy_times: Number(bought[g.type_id] || 0),
    total_times: ECHO.TOTAL_TIMES,
  }));
}
function pushEchoServantInfo(conn) {
  if (conn) conn.sendToc('m_echo_servant_info_toc', { ids: ECHO.ECHO_TYPES });
}
function handleEchoShopInfo(conn) {
  conn.sendToc('m_echo_shop_info_toc', { items: echoShopItems() });
  pushEchoServantInfo(conn);   // 顺带补推分解面板需要的名单（客户端不会自己请求）
  log(`[echo] 凭神回响列表 ${ECHO.SERVANTS.length} 件（${ECHO.PRICE} 回响之契/件，余 ${getScore(ECHO.SCORE_ID)}）`);
}
function handleEchoExchange(conn, obj) {
  const itemId = Number(obj && obj.item) || 0;
  const want = Math.max(1, Math.floor(Number(obj && obj.num) || 1));
  const err = (code, why) => { conn.sendToc('m_common_error_toc', { code }); log(`[echo] 兑换拒绝（${code}）：${why}`); };
  const g = ECHO.goodsOf(itemId);
  if (!g) return err(ECHO_ERR.NOT_ALLOWED, `道具 ${itemId} 不在凭神回响可兑换名单`);
  const bought = echoBought();
  const n = Number(bought[itemId] || 0);
  if (n + want > ECHO.TOTAL_TIMES) return err(ECHO_ERR.NOT_ALLOWED, `超出限购 ${n}+${want}/${ECHO.TOTAL_TIMES}`);
  const cost = ECHO.PRICE * want;
  const have = getScore(ECHO.SCORE_ID);
  if (have < cost) return err(ECHO_ERR.NOT_ENOUGH, `回响之契不足 ${have}/${cost}`);
  // 建卡校验必须**先于扣费**（同灵契召唤）：非法 type 时既不吃回响也不发誓灵
  const SV = require('./servant');
  const briefs = [];
  for (let i = 0; i < want; i++) {
    const isNew = !HB.isUnlocked(g.type); // 先判后建卡：makeServantBrief 激活图鉴，同批第二只自然去重
    const b = SV.makeServantBrief(g.type);
    if (!b) return err(ECHO_ERR.NOT_ALLOWED, `誓灵 type=${g.type} 非法（客户端 CfgServant 无此 typeId）`);
    briefs.push({ brief: b, isNew });
  }
  addScore(conn, ECHO.SCORE_ID, -cost);
  for (const x of briefs) SV.grantServantBrief(x.brief);
  bought[itemId] = n + want;
  saveState();
  // 回包只负责刷新回响数字；誓灵卡片靠 m_servant_update_toc（reward_type=5 召唤获得）
  conn.sendToc('m_echo_exchange_toc', { item: itemId, num: want });
  conn.sendToc('m_servant_update_toc', {
    new: briefs.map(x => ({ servant: x.brief, is_first: x.isNew ? 1 : 0 })),
    update: [],
    del: [],
    reward_type: 5,
  });
  // 新誓灵 → 图鉴红点 / 祭坛名气 diff / 言灵录（与召唤同款后置钩子）
  try { require('./handbook').pushRedPoints(conn); } catch (e) { /* 忽略 */ }
  try { require('./altar').pushFameUpdates(conn); } catch (e) { /* 忽略 */ }
  try {
    const MM = require('./moment');
    MM.onServantObtained(briefs.filter(x => x.isNew).map(x => Number(x.brief.type)));
    MM.checkUnlocks(conn);
  } catch (e) { /* 忽略 */ }
  try { require('./activity').advanceMissions(conn, { gainServant: briefs.filter(x => x.isNew).length }); } catch (e) { /* 忽略 */ }
  log(`[echo] 兑换 ${itemId}（誓灵 ${g.type}）×${want}，扣回响 ${cost} → 余 ${getScore(ECHO.SCORE_ID)}；累计兑换 ${bought[itemId]}`);
}

module.exports = {
  handlers: {
    m_role_summon_info_tos: handleSummonInfo,
    m_role_summon_pool_tos: handleSummonPool,
    m_role_servant_summon_tos: handleSummon,
    m_role_summon_close_tos: handleCloseSummon,
    m_summon_touch_pool_tos: handleTouchPool,
    m_affinity_summon_info_tos: handleAffinityInfo,
    m_affinity_summon_tos: handleAffinitySummon,
    m_echo_shop_info_tos: handleEchoShopInfo,
    m_echo_servant_info_tos: (conn) => pushEchoServantInfo(conn),
    m_echo_exchange_tos: handleEchoExchange,
  },
  buildInfoList, freeLeft, ticketCountOf, pushEchoServantInfo, echoShopItems,
};
