// 羁绊（feeling / 好感度）系统：送礼、心愿、灵契、寄语、昵称。
//
// ── 客户端事实（tools/bc_cmp/ServantFeelVO_re.lua / DormModule_re.lua / DormGiftView_re.lua 实证）──
// 羁绊是**纯服务端权威的整数**，客户端零计算，只做三件事：
//   ① 按 p_servant_brief/detail 的 feeling / satisfaction / feeling_record / pledge_time 渲染羁绊面板
//      （ServantInfoPanel 心情图标 → ServantFeelView，**onOpen 不发任何协议**，全靠已缓存的 VO）；
//   ② 靠 m_servants_change_toc 的 key=7(feeling) / 11(satisfaction) / 12(pledge_time) 刷新与播动画；
//   ③ 按 feeling 门槛本地切换主界面高好感语音（CfgMain.cardSet.highFeeling=50）与宿舍站桩台词。
// ⇒ 服务端职责：算数值 + 下发。
//
// ── 送礼时序（唯一一个必须守的顺序）──
// DormGiftView.sendGiftSucc 收到 m_servant_send_gift_toc 后**立刻读 servantVO.feeling/satisfaction**
// 算 remainTimes = 新feeling - 旧feeling 来播逐点动画（DormRestPopupItem_re.lua:120-144）。
// 所以必须 **先推 m_servants_change_toc（key=7/11），再推 m_servant_send_gift_toc**，否则动画显示 0 增长。
//
// ── 入口分布 ──
// 送礼在**宿舍/协会休息室**（DormRestPopupPanel → DormGiftView），不在誓灵详情里；
// 誓灵详情的羁绊浮层只能改昵称/改寄语/缔结灵契。
const { S, saveState } = require('../state');
const L = require('../lib');
const { log, pushGoodsUpdate, pushServantChanges } = L;
const FD = require('../data/feeling_data');
const R = require('../data/feeling_rules');

// ServantConst 的 change key（客户端 getChangeField 映射：7→feeling 11→satisfaction 12→pledge_time）
const CHANGE_ID_FEELING = 7;
const CHANGE_ID_SATISFACTION = 11;
const CHANGE_ID_PLEDGE = 10;
const CHANGE_ID_PLEDGE_TIME = 12;

const dayKey = () => new Date().toLocaleDateString('sv'); // YYYY-MM-DD（本地时区，与体力/曜日同口径）
const nowSec = () => Math.floor(Date.now() / 1000);

function st() {
  if (!S.feelingState) S.feelingState = { day: '', giftUsed: 0, battleGain: {}, dormChecked: [] };
  const s = S.feelingState;
  if (!s.battleGain) s.battleGain = {};
  if (!Array.isArray(s.dormChecked)) s.dormChecked = [];
  // 触摸（大厅立绘）每日计数：{count 已计入次数, sat 已贡献 satisfaction, lastTs 上次计入时间}
  if (!s.touch || typeof s.touch !== 'object') s.touch = { count: 0, sat: 0, lastTs: 0 };
  const today = dayKey();
  if (s.day !== today) {
    s.day = today;
    s.giftUsed = 0;        // 送礼次数按天重置
    s.battleGain = {};     // 战斗涨羁绊的每日上限计数按天重置
    s.touch = { count: 0, sat: 0, lastTs: 0 }; // 触摸次数/当日满足度按天重置（冷却不跨天沿用）
    log(`[feeling] 每日重置：送礼次数 + 战斗涨羁绊上限 + 触摸次数（${today}）`);
  }
  return s;
}

// 每日送礼次数上限 = 休息室槽位数 × 2（DormMgr.getMaxSendTime 硬口径）
function giftTimesMax() {
  return (Number(S.dormState && S.dormState.slots) || 0) * R.GIFT_TIMES_PER_SLOT;
}
function giftTimesLeft() {
  return Math.max(0, giftTimesMax() - (Number(st().giftUsed) || 0));
}

// ---- 心愿 ----
// m_servant_wish_info_toc{wish: p_kvt[]}，元素 {id: 誓灵id, val: 礼物 tag id, type: 1 NORMAL/2 MISTERY}。
// 客户端只在 onEnterGame 发一次、没有刷新协议 → 日切后服务端主动重推。
// 心愿本身不落盘：按 (誓灵id, 日期) 确定性散列生成（见 feeling_rules.wishOf），重启/切号都稳定。
function wishList() {
  const day = dayKey();
  return S.servants.map(b => {
    const w = R.wishOf(b.id, day);
    return { id: b.id, val: w.val, type: w.type };
  });
}
function wishOfServant(sid) {
  return R.wishOf(sid, dayKey());
}
function pushWishInfo(conn) {
  const list = wishList();
  conn.sendToc('m_servant_wish_info_toc', { wish: list });
  const sample = list.slice(0, 3).map(w => `${w.id}→${FD.GIFT_TAGS[w.val - 1]}${w.type === 2 ? '(神秘)' : ''}`);
  log(`[feeling] 今日心愿 ${list.length} 条（${sample.join(' ')}${list.length > 3 ? ' …' : ''}）`);
}

// ---- 羁绊变更下发 ----
// key=7 feeling 与 key=11 satisfaction 都要推：面板的进度条读 satisfaction，逐点动画读 feeling
function pushFeelingChanges(conn, briefs) {
  const changes = [];
  for (const b of [].concat(briefs)) {
    changes.push({ servant_id: b.id, key: CHANGE_ID_FEELING, val: R.feelingOf(b) });
    changes.push({ servant_id: b.id, key: CHANGE_ID_SATISFACTION, val: Number(b.satisfaction) || 0 });
  }
  if (changes.length) pushServantChanges(conn, changes);
}

// ---- 战斗涨羁绊（map_fight 在主线整关通关时调用）----
// 客户端台词原文「(出战可概率增加羁绊值)」，概率/数量/每日上限客户端全无 → data/feeling_rules.js 自定。
// actMul：活动 id 201 生效期 ×1.5（客户端会显示"增加羁绊值概率1.5倍"），本服未开活动时恒 1。
function addBattleFeeling(conn, servantIds, rng) {
  const s = st();
  const r = rng || Math.random;
  const baseChance = Math.min(1, R.BATTLE_CHANCE * actFeelMul());
  const touched = [], detail = [];
  let chance = baseChance; // 日志用：取本次循环里最后一只的命中率（含圣器加成）
  for (const sid of [...new Set((servantIds || []).map(Number))]) {
    const b = S.servants.find(x => x.id === sid);
    if (!b) continue;
    if (R.isFeelingFull(b)) continue;
    // 魅力之绳族（15003001~4）：携带者获得羁绊概率 +1/1.5/2/3 个百分点
    const relicAdd = (() => {
      try {
        const rb = require('../data/relic_data').relicBonusOf(b, S.bagGoods);
        return rb.feelChanceAdd || 0;
      } catch (e) { return 0; }
    })();
    chance = Math.min(1, baseChance + relicAdd);
    const used = Number(s.battleGain[sid]) || 0;
    if (used >= R.BATTLE_DAILY_CAP) continue;
    if (r() >= chance) continue;
    const gain = Math.min(R.BATTLE_GAIN, R.BATTLE_DAILY_CAP - used);
    const res = R.applyGain(b, gain, nowSec());
    s.battleGain[sid] = used + gain;
    touched.push(b);
    detail.push(`${sid}+${gain}${res.points ? `(羁绊${res.before}→${res.feeling})` : ''}`);
  }
  if (touched.length) {
    saveState();
    pushFeelingChanges(conn, touched);
    log(`[feeling] 战斗涨羁绊（概率 ${(chance * 100).toFixed(0)}%）：${detail.join(' ')}`);
  }
  return touched;
}
// 活动 201（CopyConst.DROP_ACT_FEEL_15）倍率：本服未开羁绊活动 → 恒 1。
// 要开就往 m_copy_barrier_info_toc.act_end_time 塞 {id:201, val:结束时间戳}，客户端自然显示 1.5 倍
function actFeelMul() {
  return 1;
}

// ---- 立绘触摸涨羁绊（大厅主页面触摸好感）----
// 触摸没有专用协议：复用图鉴语音上报 m_role_handbook_play_cv_tos（handbook.js 转进来）。
// 场景判据 = 客户端补丁标记 play_type=3（见 data/feeling_rules.js TOUCH_* 段与
// client/Modules/main/MainModuleAutoGen.lua 的运行时补丁）——只认大厅主页面立绘点击，其余调用方发 2 不计数。
// 可触摸对象 = 大厅当前展示组（L.helperOrderIds()：助手组轮转位，未勾选助手时兜底单只）。
// 返回 {counted, reason, servant, gain, count, sat}；不抛异常（上报型协议的副作用不能影响主流程）。
function resolveTouchedServant(typeId) {
  const t = Number(typeId) || 0;
  if (t <= 0) return null;
  const group = L.helperOrderIds()
    .map(id => S.servants.find(b => Number(b.id) === Number(id)))
    .filter(Boolean);
  // 上报 type 必须 ∈ 大厅展示组：同名多只取名册第一只（同一时刻界面上只会有一只）
  if (!group.some(b => Number(b.type) === t)) return null;
  return S.servants.find(b => Number(b.type) === t) || null;
}

function touchFeeling(conn, obj) {
  const typeId = Number((obj && obj.servant_type_id) || 0);
  const cvId = Number((obj && obj.cv_id) || 0);
  const playType = Number((obj && obj.play_type) || 0);
  // 非触摸场景（图鉴点播/详情页/养成自动上报…）：不计数，也不写状态
  if (playType !== R.TOUCH_PLAY_TYPE) return { counted: false, reason: 'not_touch_scene' };
  if (cvId < R.TOUCH_CV_MIN || cvId > R.TOUCH_CV_MAX) return { counted: false, reason: 'not_touch_scene' };
  const s = st();
  const b = resolveTouchedServant(typeId);
  if (!b) return { counted: false, reason: 'not_main_hall' };
  const now = nowSec();
  let reason = null;
  let gain = 0;
  // 闸门按顺序判定，命中即记录原因（被拒时不写状态/不耗次数/不加满足度）
  if ((Number(s.touch.count) || 0) >= R.TOUCH_DAILY_LIMIT) reason = 'daily_limit';
  else if ((Number(s.touch.lastTs) || 0) && now - Number(s.touch.lastTs) < R.TOUCH_COOLDOWN_SEC) reason = 'cooldown';
  else {
    const budget = R.TOUCH_DAILY_FEELING_CAP * FD.SATISFACTION_PER_POINT - (Number(s.touch.sat) || 0);
    gain = Math.min(R.TOUCH_SATISFACTION, budget);
    if (gain <= 0) reason = 'daily_sat_cap';
    else if (R.isFeelingFull(b)) reason = 'feeling_max'; // 羁绊已满：不再涨、也不空耗额度
  }
  if (reason) {
    log(`[feeling] 触摸未计入（${reason}）type=${typeId} cv=${cvId} `
      + `今日 ${Number(s.touch.count) || 0}/${R.TOUCH_DAILY_LIMIT} 次`);
    return { counted: false, reason, servant: b, gain: 0, count: Number(s.touch.count) || 0, sat: Number(s.touch.sat) || 0 };
  }
  const res = R.applyGain(b, gain, now);
  s.touch.count = (Number(s.touch.count) || 0) + 1;
  s.touch.sat = (Number(s.touch.sat) || 0) + gain;
  s.touch.lastTs = now; // 只有"计入"的触摸才刷新冷却起点
  saveState();
  // 触摸会动满足度池 ⇒ key=7(feeling) 与 key=11(satisfaction) 两条都推（与送礼同一条刷新路径）
  if (conn) pushFeelingChanges(conn, [b]);
  log(`[feeling] 触摸 servant=${b.id} type=${b.type} cv=${cvId} satisfaction+${gain}`
    + ` → 羁绊 ${res.before}→${res.feeling}/${R.maxFeelingOf(b)}（进度 ${res.satisfaction}/${FD.SATISFACTION_PER_POINT}`
    + `${res.capped ? `，触顶丢弃 ${res.capped}` : ''}）`
    + `${res.milestones.length ? ` 解锁里程碑 ${res.milestones.join('/')}` : ''}`
    + ` 今日 ${s.touch.count}/${R.TOUCH_DAILY_LIMIT} 次（触摸满足度 ${s.touch.sat}/${R.TOUCH_DAILY_FEELING_CAP * FD.SATISFACTION_PER_POINT}）`);
  return { counted: true, reason: null, servant: b, gain, count: s.touch.count, sat: s.touch.sat, points: res.points };
}

// ---- 休息位自动上涨（二百七十四）：满足度增速 + 誓灵收集（小惊喜）----
// 机制口径见 data/feeling_rules.js REST 段与 调研-好感度触摸与基建自动上涨.md：
//   满足度 = 速率按繁荣度查官方表（2~7/h），**elapsed 制**（per-servant since 锚点，离线/重启同算）；
//     满 100 → 羁绊+1（applyGain 连升/触顶/里程碑全复用），推 key=7/11（客户端休息面板
//     onSatisfactionChange 自动重绘——与送礼同一条刷新路径，安全）。
//   收集 = 每 COLLECT_INTERVAL_H 一个窗口掷骰，产出进 dormState.servants[].reward（p_kvi）：
//     客户端两个入口全靠它——主城收集图标 MainItemAppIcon + 气泡圈 MainBubblePanel（点气泡发
//     m_dorm_get_reward_tos），宿舍场景誓灵头顶气泡 HouserServantHeadItem；有产出才推
//     m_dorm_reward_notify_toc（客户端 updateDormServantReward 自带 nil 守卫，早推不崩）。
// 触发点：onLogin / m_dorm_detail_tos / m_dorm_servants_tos / m_depot_info_tos / 整关通关 / 离位。
// 无全局节流：锚点在每只誓灵身上，重复调用零增量零推送，成本 = 几条 elapsed 减法。
function dormRecords() {
  return (S.dormState && Array.isArray(S.dormState.servants)) ? S.dormState.servants : [];
}
function restProsperity() {
  try { return Number(require('./dorm').furnitureProsperity()) || 0; } catch (e) { return 0; }
}
// 单只誓灵的满足度结清（restSettle 主循环与离位结算共用）。返回 gain（0=无变化）。
function settleServantSatisfaction(rec, b, pro, now, detailList) {
  const since = Math.max(0, Number(rec.since) || now);
  rec.since = now; // 先推进锚点：即使下面 gain=0 也不重算旧窗口
  const gain = Math.floor(R.satisfyRateOf(pro) * Math.max(0, now - since) / 3600);
  if (gain <= 0) return 0;
  if (R.isFeelingFull(b)) return 0; // 满羁绊：进度条恒 0，增量直接丢弃（与送礼 FEELING_FULL 同语义）
  const res = R.applyGain(b, gain, now);
  if (R.isFeelingFull(b)) {
    // 刚好升满 → 休息室"羁绊已满"红点名单复位（与送礼路径同口径，feeling.js 送礼段同款）
    st().dormChecked = st().dormChecked.filter(id => Number(id) !== Number(b.id));
  }
  if (detailList) detailList.push(`${b.id}+${gain}满意${res.points ? `(羁绊${res.before}→${res.feeling})` : ''}`);
  return gain;
}
function restSettle(conn, opts) {
  const o = opts || {};
  const now = nowSec();
  const s = st();
  const pro = restProsperity();
  const chance = R.collectChanceOf(pro);
  const interval = Math.max(1, Math.round(R.COLLECT_INTERVAL_H * 3600));
  const capWindows = Math.max(1, Math.floor(R.COLLECT_OFFLINE_CAP_H * 3600 / interval));
  const touched = [], notified = [], detail = [];
  for (const rec of dormRecords()) {
    const b = S.servants.find(x => Number(x.id) === Number(rec.servant_id));
    if (!b) continue;
    if (settleServantSatisfaction(rec, b, pro, now, detail) > 0) touched.push(b);
    // 收集：rawWindows 超过离线封顶时多余时间直接丢弃（collectAt=now），否则保留不足一个窗口的余数
    if (!Array.isArray(rec.reward)) rec.reward = [];
    const collectAt = Math.max(0, Number(rec.collectAt) || now);
    const elapsed = Math.max(0, now - collectAt);
    const rawWindows = Math.floor(elapsed / interval);
    const windows = Math.min(rawWindows, capWindows);
    rec.collectAt = rawWindows > capWindows ? now : now - (elapsed - windows * interval);
    let got = 0;
    const r = o.rng || Math.random;
    for (let i = 0; i < windows; i++) {
      if (rec.reward.length >= R.COLLECT_MAX_PER) break; // 已堆满：窗口照常消耗（防囤积），不掷骰
      if (r() < chance) { rec.reward.push(R.rollCollect(pro, o.rng)); got++; }
    }
    if (got > 0) {
      notified.push({ id: Number(rec.servant_id), reward: rec.reward.map(x => ({ id: Number(x.id), val: Number(x.val) })) });
      detail.push(`${b.id}收集+${got}`);
    }
  }
  if (touched.length || notified.length) {
    saveState();
    if (conn && touched.length) pushFeelingChanges(conn, touched);
    if (conn) for (const n of notified) conn.sendToc('m_dorm_reward_notify_toc', { id: n.id, reward: n.reward });
    if (detail.length) log(`[feeling] 休息结算（繁荣度 ${pro}，收集命中率 ${(chance * 100).toFixed(0)}%）：${detail.join(' ')}`);
  }
  return { touched: touched.length, notified: notified.length, detail };
}
// 离位结算：把该誓灵休息期间的满足度一笔结清（收集不做——离位即断，未领的由 dorm.js 自动入包）。
// bit10 清除与记录移除由 dorm.js 负责（它在编辑同一条记录）。
function settleLeaveRest(conn, sid) {
  const rec = dormRecords().find(x => Number(x.servant_id) === Number(sid));
  const b = S.servants.find(x => Number(x.id) === Number(sid));
  if (!rec || !b) return false;
  const now = nowSec();
  const since = Math.max(0, Number(rec.since) || now);
  const restedMin = Math.round((now - since) / 60);
  const gain = settleServantSatisfaction(rec, b, restProsperity(), now, null);
  if (gain <= 0) return false;
  saveState();
  pushFeelingChanges(conn, [b]);
  log(`[feeling] 离位结算 servant=${sid}：休息 ${restedMin} 分钟 satisfaction+${gain}`);
  return true;
}

function onLogin(conn) {
  st();
  saveState();
  pushWishInfo(conn);
  try { restSettle(conn); } catch (e) { log(`[feeling] 休息结算异常（不阻塞登录）：${e.message}`); }
}

module.exports = {
  st, giftTimesMax, giftTimesLeft, wishList, wishOfServant, pushWishInfo,
  pushFeelingChanges, addBattleFeeling, actFeelMul, onLogin,
  touchFeeling, resolveTouchedServant,
  restSettle, settleLeaveRest, dormRecords,
  CHANGE_ID_FEELING, CHANGE_ID_SATISFACTION, CHANGE_ID_PLEDGE_TIME,
  handlers: {
// 心愿列表（客户端 onEnterGame 发一次）
m_servant_wish_info_tos(conn) {
  pushWishInfo(conn);
},
// 送礼（宿舍休息室 → DormGiftView）。
// 校验次数/礼物/羁绊满 → 扣礼物 → satisfaction 累积（可连升多点）→
// **先推 change(key7/11) 再推 gift_toc**（客户端动画靠这个顺序）
m_servant_send_gift_tos(conn, obj) {
  const sid = Number((obj && obj.servant_id) || 0);
  const giftId = Number((obj && obj.gift_id) || 0);
  const num = Math.max(1, Number((obj && obj.num) || 1));
  const s = st();
  const b = S.servants.find(x => x.id === sid);
  const err = (code, why) => {
    conn.sendToc('m_common_error_toc', { code });
    log(`[feeling] 送礼被拒（${code}）servant=${sid} gift=${giftId}：${why}`);
  };
  if (!b) return err(R.ERR.PARAM, '未知誓灵');
  if (!FD.GIFTS[String(giftId)]) return err(R.ERR.PARAM, '不是礼物道具（CfgItems 28xxxxxx）');
  if (R.isFeelingFull(b)) return err(R.ERR.FEELING_FULL, `羁绊已满（${R.feelingOf(b)}/${R.maxFeelingOf(b)}）`);
  const left = giftTimesLeft();
  if (left <= 0) return err(R.ERR.GIFT_TIMES, `今日送礼次数已用完（上限 ${giftTimesMax()} = 休息室 ${S.dormState.slots} 位 × ${R.GIFT_TIMES_PER_SLOT}）`);
  const use = Math.min(num, left);
  // 礼物数量
  const bagNum = S.bagGoods.reduce((n, g) => n + (Number(g.type_id) === giftId ? Number(g.cur_num) || 0 : 0), 0);
  if (bagNum < use) return err(R.ERR.GIFT_NUM, `礼物不足（需 ${use}，有 ${bagNum}）`);
  // 扣礼物（按 type_id 跨格扣）
  const updated = [], removed = [];
  let leftNum = use;
  for (const g of S.bagGoods) {
    if (leftNum <= 0 || Number(g.type_id) !== giftId) continue;
    const take = Math.min(leftNum, Number(g.cur_num) || 0);
    g.cur_num -= take; leftNum -= take;
    (g.cur_num <= 0 ? removed : updated).push(g);
  }
  S.bagGoods = S.bagGoods.filter(g => Number(g.cur_num || 0) > 0);
  // 结算羁绊
  const wish = wishOfServant(sid);
  const one = R.giftGain(giftId, wish);
  const res = R.applyGain(b, one.gain * use, nowSec());
  s.giftUsed = (Number(s.giftUsed) || 0) + use;
  saveState();
  if (updated.length) pushGoodsUpdate(conn, updated, 3);
  if (removed.length) pushGoodsUpdate(conn, removed, 2);
  pushFeelingChanges(conn, [b]);                 // ← 必须在 gift_toc 之前
  conn.sendToc('m_servant_send_gift_toc', {
    servant_id: sid,
    gift_time: giftTimesLeft(),                  // 今日剩余送礼次数
    is_wish: one.isWish ? 1 : 0,                 // 1 → 客户端播"意外的惊喜！"+爱心特效
  });
  const gname = FD.GIFTS[String(giftId)].name;
  log(`[feeling] 送礼 servant=${sid} type=${b.type} ${gname}×${use}`
    + `（${one.isWish ? `命中${wish.type === 2 ? '神秘' : ''}心愿「${FD.GIFT_TAGS[wish.val - 1]}」×${one.mul}` : '未命中心愿'}）`
    + ` satisfaction+${one.gain * use} → 羁绊 ${res.before}→${res.feeling}/${R.maxFeelingOf(b)}`
    + `（进度 ${res.satisfaction}/${FD.SATISFACTION_PER_POINT}${res.capped ? `，触顶丢弃 ${res.capped}` : ''}）`
    + `${res.milestones.length ? ` 解锁里程碑 ${res.milestones.join('/')}` : ''}`
    + ` 今日剩余 ${giftTimesLeft()}/${giftTimesMax()} 次 · 心情「${R.moodOf(res.feeling)}」`);
  // 羁绊满 → 休息室红点（客户端 DormRestPopupPanel 会发 m_check_dorm_servant_tos 消掉）
  if (R.isFeelingFull(b)) {
    s.dormChecked = s.dormChecked.filter(id => Number(id) !== sid);
    saveState();
  }
},
// 缔结灵契：羁绊满 100 + 消耗 CfgMarry.proposalItem(31000014) + 誓灵不在出战/派遣中。
// toc 只是关面板播婚礼 CG，**真正的状态靠 m_servants_change_toc key=12(pledge_time) 下发**
m_servant_pledge_tos(conn, obj) {
  const sid = Number((obj && obj.servant_id) || 0);
  const b = S.servants.find(x => x.id === sid);
  const err = (code, why) => {
    conn.sendToc('m_common_error_toc', { code });
    log(`[feeling] 缔结灵契被拒（${code}）servant=${sid}：${why}`);
  };
  if (!b) return err(R.ERR.PARAM, '未知誓灵');
  if (R.isMarried(b)) return err(R.ERR.PLEDGE_DONE, '已缔结灵契');
  if (R.feelingOf(b) < R.PLEDGE_NEED_FEELING) return err(R.ERR.PLEDGE_FEELING, `羁绊不足（${R.feelingOf(b)}/${R.PLEDGE_NEED_FEELING}）`);
  // status 是位掩码（ServantUtil.isLock=getIntNBit(status,1)，bc 实证）：
  // bit1=锁定、bit3=派遣、bit4=出战。官方 666004"誓灵跑出去了"只指出战/派遣（bit3|bit4=12），
  // 锁定（bit1）不该拦——玩家锁的主力卡 99→100 羁绊后被 666004 拒（2026-10-17 azhi 真机实证）。
  // 与 data/chaos_data.js isBusy 的 `status & 12` 同口径。
  if (Number(b.status) & 12) return err(R.ERR.PLEDGE_BUSY, `誓灵状态占用（status=${b.status}）`);
  const item = FD.PROPOSAL_ITEM;
  const bagNum = S.bagGoods.reduce((n, g) => n + (Number(g.type_id) === item ? Number(g.cur_num) || 0 : 0), 0);
  if (bagNum < 1) return err(R.ERR.PLEDGE_ITEM, `缺结缔灵契道具 ${item}`);
  const updated = [], removed = [];
  for (const g of S.bagGoods) {
    if (Number(g.type_id) !== item) continue;
    g.cur_num -= 1;
    (g.cur_num <= 0 ? removed : updated).push(g);
    break;
  }
  S.bagGoods = S.bagGoods.filter(g => Number(g.cur_num || 0) > 0);
  b.pledge = 1;
  b.pledge_time = nowSec();
  saveState();
  if (updated.length) pushGoodsUpdate(conn, updated, 3);
  if (removed.length) pushGoodsUpdate(conn, removed, 2);
  // key=12 是"已婚"的唯一权威下发（客户端 isMarry() 就看 pledge_time>0）；key=10 一并推保持字段一致
  pushServantChanges(conn, [
    { servant_id: sid, key: CHANGE_ID_PLEDGE, val: 1 },
    { servant_id: sid, key: CHANGE_ID_PLEDGE_TIME, val: b.pledge_time },
  ]);
  conn.sendToc('m_servant_pledge_toc', { servant_id: sid });
  // 婚皮联动：该 type 有灵契皮（actItemID==1）时补推皮肤面板数据（m_servant_skin_toc）——
  // 客户端皮肤 VO 缓存 dataIsOK=true 后不再重拉（全客户端唯一重置点是进化 toc），不推则
  // 缔结前开过皮肤面板的本会话一直显示"未激活"直到重登。见 servant.js pushMarrySkinRefresh。
  const skinPushed = require('./servant').pushMarrySkinRefresh(conn, b);
  log(`[feeling] 缔结灵契 servant=${sid} type=${b.type} → 羁绊上限 ${FD.FEELING_MAX}→${FD.FEELING_MAX_MARRY}，解锁改昵称/改寄语${skinPushed ? '，灵契皮肤已解锁并补推面板数据' : ''}`);
},
// 改寄语（羁绊面板"相守"格，需已缔结灵契）
m_servant_edit_message_tos(conn, obj) {
  const sid = Number((obj && obj.servant_id) || 0);
  const msg = String((obj && obj.message) || '');
  const b = S.servants.find(x => x.id === sid);
  if (!b) { conn.sendToc('m_common_error_toc', { code: R.ERR.PARAM }); return; }
  if (!R.isMarried(b)) {
    conn.sendToc('m_common_error_toc', { code: R.ERR.MSG_NO_PLEDGE });
    log(`[feeling] 改寄语被拒（${R.ERR.MSG_NO_PLEDGE}）servant=${sid}：未缔结灵契`);
    return;
  }
  if ([...msg].length > R.MESSAGE_MAX_LEN) {
    conn.sendToc('m_common_error_toc', { code: R.ERR.MSG_LONG });
    log(`[feeling] 改寄语被拒（${R.ERR.MSG_LONG}）servant=${sid}：${[...msg].length} 字超过 ${R.MESSAGE_MAX_LEN}`);
    return;
  }
  b.message = msg;
  saveState();
  conn.sendToc('m_servant_edit_message_toc', { servant_id: sid, message: msg });
  log(`[feeling] 改寄语 servant=${sid}：「${msg}」`);
},
// 改昵称（需已缔结灵契 + 30 天 CD + 不与已有昵称重复）
m_servant_name_tos(conn, obj) {
  const sid = Number((obj && obj.servant_id) || 0);
  const name = String((obj && obj.name) || '').trim();
  const b = S.servants.find(x => x.id === sid);
  const err = (code, why) => {
    conn.sendToc('m_common_error_toc', { code });
    log(`[feeling] 改昵称被拒（${code}）servant=${sid}：${why}`);
  };
  if (!b || !name) return err(R.ERR.PARAM, '参数错误');
  if (!R.isMarried(b)) return err(R.ERR.NAME_NO_PLEDGE, '未缔结灵契');
  const last = Number(b.change_name_time) || 0;
  const cd = R.RENAME_CD_DAYS * 86400;
  if (last && nowSec() - last < cd) {
    return err(R.ERR.NAME_CD, `改名冷却中（还需 ${Math.ceil((cd - (nowSec() - last)) / 86400)} 天）`);
  }
  if (S.servants.some(x => x.id !== sid && String(x.name || '') === name)) {
    return err(R.ERR.NAME_DUP, `昵称「${name}」已被其他誓灵使用`);
  }
  b.name = name;
  b.change_name_time = nowSec();
  saveState();
  conn.sendToc('m_servant_name_toc', { servant_id: sid, name });
  log(`[feeling] 改昵称 servant=${sid} → 「${name}」（下次可改：${R.RENAME_CD_DAYS} 天后）`);
},
// 休息室"羁绊已满"红点确认（客户端点掉后上报，服务端记名单避免重复亮）
m_check_dorm_servant_tos(conn, obj) {
  const ids = (Array.isArray(obj && obj.id) ? obj.id : []).map(Number).filter(Boolean);
  const s = st();
  const ok = [];
  for (const sid of ids) {
    const b = S.servants.find(x => x.id === sid);
    if (!b) { conn.sendToc('m_common_error_toc', { code: R.ERR.DORM_NO_SERVANT }); continue; }
    if (!R.isFeelingFull(b)) { conn.sendToc('m_common_error_toc', { code: R.ERR.DORM_NOT_FULL }); continue; }
    if (!s.dormChecked.includes(sid)) s.dormChecked.push(sid);
    ok.push(sid);
  }
  if (ok.length) saveState();
  conn.sendToc('m_check_dorm_servant_toc', { id: ok });
  log(`[feeling] 休息室羁绊满红点已确认 [${ok.join(',') || '无'}]`);
},
  },
};
