// 银匙之门（幻梦战 Dream，功能 ID 16，通关主线 5-4 解锁）
// 入口：主线页左侧 btnDream → DreamEnterPanel（开始/继续挑战 + 买钥之匙）→ DreamFightReadyPanel
//       （九宫格布阵 5 主力 + 2 替补，独立于主线编队）→ 标准战斗链。
//
// 协议链（全部客户端反编译实证，schema 见 tools/key_lua/Proto_new.lua）：
//   m_copy_dream_info_tos → toc{now,max,is_fight,fail_times,daily_times,add_times}
//   m_embattle_detail_tos{id=队伍号恒1} → toc{id, detail:p_embattle_servant[]{pos,id}}
//   m_embattle_update_tos{id, update:[p_kvi{id=pos,val=servantId}]} → toc{id, update:[{pos,id}]}
//       （val=0 = 下阵；客户端 DreamMgr.updateServant 的换位语义必须逐字镜像，见 applyEmbattle）
//   m_copy_dream_begin/quit/jump/buy_times_tos（全空参）→ 同名空 toc
//   m_chaos_select_rage_skill_tos{type,servant_id,skill_id} → toc 同形（切换怒气技）
//   战斗：m_copy_fight_tos(copy_id=11000000+关) → m_fight_servant_start_tos → m_fight_skill_select_tos
//       （与主线同一套 toc；非幻梦 copy 一律回落 handlers/map_fight.js，装配顺序保证覆盖）
//
// 官方错误码（CfgErrorCode，按 toc protoId 编号）——本实现全部照用：
//   1259001 副本ID错误 / 1259002 挑战次数不足 / 1259003 消耗超过上限（钥之匙 38/15）
//   1261001 已到达历史最高关卡（跳关）/ 1261002 挑战次数不足（跳关）
//   1263001 今天的次数已用完（买钥之匙）
//
// 数值/规则口径与「哪些是本地服设计」的边界：见 data/dream_rules.js 顶部长注释。
const { S, saveState, batchWrites } = require('../state');
const L = require('../lib');
const { log, grantGoods, pushGoodsUpdate, pushAssetChange, pushServantChanges, progressOf,
  CHANGE_ID_EXP, CHANGE_ID_LEVEL, TRAIN, applyRoleExpGain, pushRoleExpChange, pushRoleLevelup } = L;
const FC = require('../data/fight_core');
const CH = require('../data/chaos_data');
const { relicBonusOf } = require('../data/relic_data');
const R = require('../data/dream_rules');
const MF = require('./map_fight');
const { makeServantBrief } = require('./servant');
const altarMod = require('./altar');
const handbookMod = require('./handbook');

const ERR_COPY_ID = 1259001, ERR_TIMES = 1259002, ERR_COST = 1259003;
const ERR_JUMP_MAX = 1261001, ERR_JUMP_TIMES = 1261002, ERR_BUY_TIMES = 1263001;
const FUNC_ID_DREAM = 16;

// ---- 战斗单位 wire-id（bid）映射（一百八十八 方案 A'，同 map_fight.js）----
// 引擎内部 id 不动（我方=真实誓灵 id，结算按它反查）；下发/回传走 bid。
// 幻梦战会话容器是 S.dreamFight（f），分配器挂 f.bidAlloc。
function bidAllocOf(f) {
  if (!f.bidAlloc) f.bidAlloc = FC.newBidAllocator();
  return f.bidAlloc;
}
function bidOfAlly(unit, f) {
  if (unit.bid && FC.isWireBid(unit.bid)) return unit.bid; // 替补续用已分配的 bid（同场稳定）
  unit.bid = bidAllocOf(f).next(0);
  return unit.bid;
}
const bidOfUnit = u => (u && u.bid != null) ? u.bid : u.id; // 兜底：无 bid 用 id（值域断言会抓）

const dayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

// ---- 状态（存档块 S.dreamState；会话战斗块 S.dreamFight 不落盘）----
function st() {
  if (!S.dreamState) {
    S.dreamState = {
      now: 1, max: 0, isFight: 0, failTimes: 0,
      dailyLeft: R.DAILY_TIMES_BASE, buyTimes: 0, day: dayKey(),
      embattle: {}, cleared: [],
    };
  }
  const s = S.dreamState;
  if (s.day !== dayKey()) { // 跨天：挑战次数与买钥次数重置（官方口径「每日」）
    s.day = dayKey();
    s.dailyLeft = R.DAILY_TIMES_BASE;
    s.buyTimes = 0;
    log(`[dream] 跨天重置：挑战次数=${s.dailyLeft} 买钥次数=0`);
  }
  if (!s.embattle) s.embattle = {};
  if (!Array.isArray(s.cleared)) s.cleared = [];
  R.syncDreamLv(S.servants); // 幻梦等级绿字（暗噬成长线兜底值）与算力同源
  return s;
}

function isFuncOpen() {
  return L.buildOpenFunctions().includes(FUNC_ID_DREAM);
}

// 登录链推送（role.js 登录序列挂载）：主线页「银匙之门」按钮直接显示"剩余次数：N"，
// 而客户端只在打开入口面板时才拉 info（DreamEnterPanel:35 / DreamReadyPanelVO:40）——
// 不推送则按钮（1013 下发后）恒显示"剩余次数：0"（二百九十九）。
// 消费端 DreamModule.m_copy_dream_info_toc 是纯显示刷新（填 DreamMgr + 刷未打开的面板），登录推送安全。
function onLogin(conn) {
  if (isFuncOpen()) pushInfo(conn);
}
function err(conn, code, why) {
  conn.sendToc('m_common_error_toc', { code });
  log(`[dream] 拒绝（${code}）：${why}`);
}

// ---- info ----
function pushInfo(conn) {
  const s = st();
  conn.sendToc('m_copy_dream_info_toc', {
    now: s.now,
    max: s.max,
    is_fight: s.isFight ? 1 : 0,
    fail_times: s.failTimes,
    daily_times: s.dailyLeft,   // 剩余次数（DreamEnterPanel：==0 弹「今日挑战次数已用尽」）
    add_times: s.buyTimes,      // 已购买钥之匙次数（买钥面板按 maxTimes - add_times 出可购次数）
  });
}

// ---- 布阵 ----
// 客户端 DreamMgr 只持有 {id,pos} 列表，本服权威态 = s.embattle {pos: servantId}
function embattleList() {
  const s = st();
  const out = [];
  for (const [pos, id] of Object.entries(s.embattle)) {
    if (Number(id) > 0 && S.servants.some(x => x.id === Number(id))) out.push({ pos: Number(pos), id: Number(id) });
  }
  return out.sort((a, b) => a.pos - b.pos);
}
function posOfServant(id) {
  const s = st();
  for (const [pos, sid] of Object.entries(s.embattle)) {
    if (Number(sid) === Number(id)) return Number(pos);
  }
  return 0;
}
// 首次进入自动布阵：在钥之匙预算内（主队 38 / 副队 15）最大化幻梦等级之和。
// 官方预算逼着人上便宜卡（5 主力均摊 7.6 点 ≈ N/R 为主），贪心按等级降序只会塞满 3~4 只 UR 就没预算，
// 所以用背包 DP（誓灵数 × 槽位 × 预算，规模极小）选一套能真正站满 5+2 的默认阵容
function pickByBudget(pool, slots, budget) {
  // best[k][c] = { lv, pick[] }：用 k 个槽、花费恰好 <= c 的最大幻梦等级和
  let best = Array.from({ length: slots + 1 }, () => Array.from({ length: budget + 1 }, () => null));
  best[0][0] = { lv: 0, pick: [] };
  for (const b of pool) {
    const c0 = R.costOfType(b.type), lv0 = R.dreamLevelOf(b);
    const next = best.map(row => row.slice());
    for (let k = 0; k < slots; k++) {
      for (let c = 0; c + c0 <= budget; c++) {
        const from = best[k][c];
        if (!from) continue;
        const cur = next[k + 1][c + c0];
        if (!cur || cur.lv < from.lv + lv0) next[k + 1][c + c0] = { lv: from.lv + lv0, pick: from.pick.concat(b) };
      }
    }
    best = next;
  }
  let win = { lv: -1, pick: [] };
  for (let k = 0; k <= slots; k++) {
    for (let c = 0; c <= budget; c++) {
      const v = best[k][c];
      if (v && (v.lv > win.lv || (v.lv === win.lv && v.pick.length > win.pick.length))) win = v;
    }
  }
  return win.pick;
}
function autoEmbattleIfEmpty() {
  const s = st();
  if (embattleList().length) return;
  const main = pickByBudget(S.servants, R.MAIN_NUM, R.MAIN_COST_MAX);
  const rest = S.servants.filter(b => !main.includes(b));
  const sub = pickByBudget(rest, R.SUB_POS.length, R.SUB_COST_MAX);
  main.forEach((b, i) => { s.embattle[i + 1] = b.id; });
  sub.forEach((b, i) => { s.embattle[R.SUB_POS[i]] = b.id; });
  const c = costOfEmbattle();
  log(`[dream] 自动布阵：主力 ${main.length} 只（${c.main}/${R.MAIN_COST_MAX}，梦等级 ${main.map(b => R.dreamLevelOf(b)).join('/')}）`
    + ` 替补 ${sub.length} 只（${c.sub}/${R.SUB_COST_MAX}）`);
}
// 逐字镜像 DreamMgr.updateServant：
//   val=0 且该格有人 → 下阵；
//   该格有人且 mover 原本不在阵上 → 顶掉原占位者（不换位）；
//   该格有人且 mover 在阵上 → 两者换位；
//   该格空 → 直接落位（mover 若在阵上则腾空原格）
function applyEmbattle(pos, servantId) {
  const s = st();
  const cur = Number(s.embattle[pos]) || 0;      // 该格现有人
  const moverPos = servantId > 0 ? posOfServant(servantId) : 0; // mover 原格（0=不在阵上）
  if (servantId === 0) {
    if (cur) delete s.embattle[pos];
    return;
  }
  if (cur && cur === servantId) return;          // 原地不动
  if (cur && !moverPos) {                        // 顶掉（客户端 removeItem 后 slot1=nil）
    delete s.embattle[pos];
  } else if (cur && moverPos) {                  // 换位
    s.embattle[moverPos] = cur;
  } else if (moverPos) {                         // 空格 + 阵上移动：腾空原格
    delete s.embattle[moverPos];
  }
  s.embattle[pos] = servantId;
}
function costOfEmbattle() {
  const s = st();
  let main = 0, sub = 0;
  for (const [pos, id] of Object.entries(s.embattle)) {
    const b = S.servants.find(x => x.id === Number(id));
    if (!b) continue;
    if (Number(pos) < 10) main += R.costOfType(b.type); else sub += R.costOfType(b.type);
  }
  return { main, sub };
}

// ================= 幻梦战斗引擎 =================
// 与主线同一套 toc，但独立实现（不动 map_fight 主干）。差异全部来自客户端幻梦分支：
//   ① 九宫格 9 格/边（主线 6 格），3 路站位锁排（前方对手/前方直线/前方队友等 23 种 effType）
//   ② PP 无限（不扣不推 SKILL_PP）
//   ③ 每只誓灵只携带「1 普攻（按擅长属性分物/魔）+ 1 怒气技（可在布阵面板替换）」
//   ④ 回合开始判定怒气达标即放怒气技，不足则用普攻（强制自动，不吃主线 3 技能作战策略）
//   ⑤ effType 走 CfgDream 覆盖（普攻统一 1002 前方对手）  ⑥ 回合上限 25/20/15 且超时判负
//   ⑦ 替补：主力阵亡后按格补入，走 enter_list 增援路径（FightLoop.onBorn）
const briefPosOf = tile => (tile[0] + 500) * 1000 + (tile[1] + 500);
// 极少数允许自由挑目标的怒气技 effType（1007 光熊之拳 / 1052 任一直线×2 / 1056 任意一排×1）
const FREE_CHOICE_EFFS = new Set([1007, 1052, 1056]);

// 幻梦技能池（官方口径）：严格 2 技 = [普攻（按擅长属性选魔法箭/属性冲击）, 唯一怒气技]。
// 不再塞入我方主线 3 技能槽或敌方整本技能书；unitToc 下发这 2 技供客户端 checkAsset 预载动画。
function dreamSkillPool(type, level, usingIds, rageSkill, learnedIds, servant, star) {
  const basic = R.basicSkillOf(type, servant, star);
  const ids = [basic];
  const rs = Number(rageSkill) || 0;
  if (rs > 0 && FC.skillCfg(rs) && !ids.includes(rs)) ids.push(rs);
  return ids;
}

// 圣器「批次4/5」词条打包：与 map_fight.mkAllyUnit 同源（relic_data.relicBonusOf 输出 → 战斗单位字段）
function relicMiscOf(rb) {
  return {
    openShield: rb.openShieldPct || 0, takenMit: rb.takenMit || 0,
    hurtMitChance: rb.hurtMitChance || null, stackDmgPerHurt: rb.stackDmgPerHurt || null,
    randomDmgRange: rb.randomDmgRange || null, repeatSkillDmg: rb.repeatSkillDmg || null,
    fearChance: rb.fearChance || 0, fearFeature: rb.fearFeature || 0,
    priorityChance: rb.priorityChance || 0, weatherSummon: rb.weatherSummon || null,
    onKillRandomAtk: rb.onKillRandomAtk || 0, roundRandomStatOrHeal: !!rb.roundRandomStatOrHeal,
    foeTakenDmgUp: rb.foeTakenDmgUp || 0, allyDmgUp: rb.allyDmgUp || 0,
    breakBarrier: !!rb.breakBarrier, noResistDamage: !!rb.noResistDamage,
    sameNatureWeek: !!rb.sameNatureWeek,
    excl: rb.excl || null, // 联动圣器专属段打包透传（2026-10-25 家族落地）
    swapDef: rb.swapDef || null,
    danmakuDmgMul: rb.danmakuDmgMul || 0, assistHitBonus: rb.assistHitBonus || 0,
    physSingleSplash: rb.physSingleSplash || 0,
  };
}
function mkUnit(o) {
  const attrs = R.dreamAttrs(o.type, o.level, o.star, o.servant);
  const ids = dreamSkillPool(o.type, o.level, o.usingIds, o.rageSkill,
    o.servant && Array.isArray(o.servant.learned_skills) ? o.servant.learned_skills : null,
    o.servant, o.star);
  const unit = {
    id: o.id, type: o.type, nature: FC.natureOf(o.type), level: o.level, star: o.star,
    skin: o.skin, side: o.side, pos: o.pos.slice(), slot: o.slot,
    hp: attrs.hp, maxHp: attrs.hp, shield: 0, attrs,
    rage: R.RAGE_START, basicSkill: ids[0], rageSkill: Number(o.rageSkill) || 0,
    skills: ids.map(id => ({ id, pp: (FC.skillCfg(id) || {}).pp || 30 })),
    dmgMul: o.dmgMul || 0, selfMit: o.selfMit || 0, teamMit: 0, dodge: 0,
    critLv: o.critLv || 0, critMul: o.critMul || 0, critMit: o.critMit || 0,
    immuneCrit: !!o.immuneCrit, natMul: o.natMul || {}, weekMul: o.weekMul || 0,
    talent: o.talent || FC.talentOf(o.type) || 0,
    servant: o.servant,
    relicId: o.relicId || 0,
    // 「受到克制伤害后属性提升」族圣器（见 relic_data RELIC_COMBAT_MODS.onHurtByWeek）
    relicHurtByWeek: o.relicHurtByWeek || null,
    relicDeathSave: o.relicDeathSave || null,
    relicLowHpHeal: o.relicLowHpHeal || null,
    relicDodgeBonus: o.relicDodgeBonus || 0,
    relicHitBonus: o.relicHitBonus || 0,
    relicMisc: o.relicMisc || null,
    relicCure: o.relicCure || null,
    relicDeathGuard: o.relicDeathGuard || 0,
    // 作战策略「自行」技能循环（FC.allyChoose modeId=6；source = o.servant.ai_skills）
    aiSkills: (o.servant && Array.isArray(o.servant.ai_skills)) ? o.servant.ai_skills.slice() : [],
  };
  FC.initUnitBattleState(unit);
  if (o.openShieldPct) unit.shield = Math.round(attrs.hp * o.openShieldPct);
  if (o.critLv) {
    unit.statLevels[111] = (unit.statLevels[111] || 0) + o.critLv;
    unit.crit_hit_lv = unit.statLevels[111];
  }
  return unit;
}

// p_servant（进场包）。幻梦战 PP 显示为「次数无限」，power_point 只需恒 >0（客户端按 !=0 判可点）
function unitToc(u) {
  const skills = u.skills.map(s => {
    const cfg = FC.skillCfg(s.id) || {};
    const max = cfg.pp || 30;
    return { id: s.id, type: cfg.type || 0, nature: cfg.nature || 0, power_point: max, max_power_point: max, state: 0, state_reason: [] };
  });
  const statLevels = u.statLevels || {};
  const buffs = u.buffs || {};
  return {
    id: u.bid != null ? u.bid : u.id, type: u.type, name: '', skin_id: u.skin || (u.type * 100 + 1), nature: u.nature,
    feature: u.talent ? [u.talent] : [], item: u.relicId ? [u.relicId] : [], level: u.level,
    skill: skills, using_skill: u.skills.map(s => s.id),
    attr: {
      hp: u.hp, rage: u.rage, shield: Math.max(0, Math.round(u.shield || 0)), element_shield: [], hp_list: [],
      max_hp_num: 1, max_hp: u.maxHp,
      phy_atk: u.attrs.phy_atk, mag_atk: u.attrs.mag_atk,
      phy_def: u.attrs.phy_def, mag_def: u.attrs.mag_def, speed: u.attrs.speed,
      phy_atk_lv: statLevels[101] || 0,
      mag_atk_lv: statLevels[102] || 0,
      phy_def_lv: statLevels[103] || 0,
      mag_def_lv: statLevels[104] || 0,
      speed_lv: statLevels[105] || 0,
      crit_hit_lv: statLevels[111] || 0,
      hit_rate_lv: statLevels[113] || 0,
      dodge_rate_lv: statLevels[115] || 0,
    },
    brief_pos: briefPosOf(u.pos),
    // buffs 编码口径（三百一十三）：客户端 updateAllBuff 按 `id % 1e6` 解 buffId、`floor(id/1e6)` 解
    // level（isZeroHide 类 level=0 会被拒显）、`val` 当 endRound——与 map_fight fightServantOf 同口
    buffs: Object.keys(buffs).map(bid => ({
      id: FC.encodeBuffVal(Number(bid), buffs[bid].level || 1),
      val: buffs[bid].duration || 0,
    })),
    morph_id: 0, power: 0, element: [], role_id: 0,
  };
}

// 建立一场幻梦战：我方来自 s.embattle（pos 1-9 主力 / 10-11 替补），敌方来自 CfgDream.monsters
function buildFight(fightId, barrier) {
  const s = st();
  const cfg = R.barrierCfg(barrier);
  const allies = [], allyBench = [], enemies = [], enemyBench = [];
  for (const e of embattleList()) {
    const b = S.servants.find(x => x.id === e.id);
    if (!b) continue;
    // 官方规则（银匙之门初始公告）：幻梦战「暂不受圣器效果影响」——客户端面板公式 calcFantasyPropVal
    // 同样不吃圣器（能源/核心/信仰/混沌/祭坛全传 0/nil，圣器词条不在其中）。一百零三曾为对齐
    // 「三管线词条装配」把圣器接进幻梦单位；二百九十九按官方口径摘除：传 null 走 relicBonusOf
    // 的「无物品 → 零加成」分支（relic_data.js:426 有 null 守卫），字段结构保留（全零），
    // 主线 map_fight/塔 tower_fight 的装配不受影响。
    const rb = relicBonusOf(null, S.bagGoods);
    const u = mkUnit({
      id: b.id, type: b.type, level: R.dreamLevelOf(b), star: Number(b.star) || 5,
      skin: Number(b.skin_id) || 0, side: 0, slot: e.pos,
      pos: R.tileOfPos(e.pos < 10 ? e.pos : 1, true),
      usingIds: null,
      rageSkill: CH.rageSkillOf(b), servant: b,
      dmgMul: rb.dmgMul || 0,
      critLv: rb.critLv || 0,
      critMul: rb.critMul || 0,
      critMit: rb.critMit || 0,
      immuneCrit: !!rb.immuneCrit,
      natMul: rb.natMul || {},
      weekMul: rb.weekMul || 0,
      talent: CH.talentOf(b),
      relicHurtByWeek: rb.onHurtByWeek || null,
      relicDeathSave: rb.deathSaveChance > 0 ? { chance: rb.deathSaveChance, feature: rb.deathSaveFeature } : null,
      relicLowHpHeal: rb.lowHpHeal || null,
      relicDodgeBonus: rb.dodgeBonus || 0,
      relicHitBonus: rb.hitBonus || 0,
      relicMisc: relicMiscOf(rb),
      relicCure: rb.cureOnce || null,
      relicDeathGuard: rb.deathGuardPct || 0,
      openShieldPct: rb.openShieldPct || 0,
      // 幻梦战不宣带圣器（官方口径同上）：进场包 item[] 恒空，客户端战斗详情不显示圣器
      relicId: 0,
    });
    if (rb.phyAtkMul) u.attrs.phy_atk = Math.round(u.attrs.phy_atk * (1 + rb.phyAtkMul));
    if (rb.magAtkMul) u.attrs.mag_atk = Math.round(u.attrs.mag_atk * (1 + rb.magAtkMul));
    const rarityColor = Math.floor(Number(b.type) / 10000) % 10;
    const defOk = !rb.rOnly || rarityColor <= 2;
    if (defOk && rb.defPct) u.attrs.phy_def = Math.round(u.attrs.phy_def * (1 + rb.defPct));
    if (defOk && rb.mdefPct) u.attrs.mag_def = Math.round(u.attrs.mag_def * (1 + rb.mdefPct));
    if (e.pos < 10) allies.push(u); else allyBench.push(u);
  }
  let eid = 70000001;
  for (const m of cfg.monsters) {
    const u = mkUnit({
      id: eid++, type: m.type, level: m.level, star: m.star, skin: m.skin,
      side: 1, slot: m.pos, pos: R.tileOfPos(m.pos < 10 ? m.pos : 1, false),
      usingIds: null, rageSkill: m.rage,
      talent: FC.talentOf(m.type) || 0,
      relicId: 0,
    });
    if (m.pos < 10) enemies.push(u); else enemyBench.push(u);
  }
  const flags = R.effectFlags(barrier);
  S.dreamFight = {
    // isDream：幻梦战语义标记。战斗核心据此执行「10273 虚无爆发消耗当前一半虚空」
    // （CfgSkillDetail 原文：「幻梦战时消耗当前一半虚空」）；主线/塔不带此字段。
    fightId, barrier, copyId: R.copyIdOf(barrier), round: 0, over: 0, isDream: true,
    allies, allyBench, enemies, enemyBench,
    maxRound: R.maxRoundOf(barrier), flags,
    // 参战全员（含被替补顶替下去的阵亡者）——结算发经验按这份名单，避免替补上场后原主力丢经验
    allAllies: allies.concat(allyBench),
    weather: { start_weather: 0, weather_end_round: 0 },
    bidAlloc: FC.newBidAllocator(), // wire-id 分配器（一百八十八 方案 A'）
  };
  // 我方进场即分配 bid（真实誓灵 id 不动）；替补延后到 reinforce() 上场时分配
  allies.concat(allyBench).forEach(u => { bidOfAlly(u, S.dreamFight); });
  enemies.concat(enemyBench).forEach(u => { u.bid = S.dreamFight.bidAlloc.next(1); });
  log(`[dream] 开战 第${barrier}关 fight=${fightId} 我方 ${allies.length}(+${allyBench.length}替补) `
    + `敌方 ${enemies.length}(+${enemyBench.length}替补) lv${cfg.monsters[0] && cfg.monsters[0].level} `
    + `回合上限 ${S.dreamFight.maxRound}${flags.ids.length ? ' 机制[' + R.effectTipsOf(barrier).join(' / ') + ']' : ''}`);
  return S.dreamFight;
}

// 推一个幻梦回合包。round=1 带双方进场；后续回合 enter_list 用于替补增援（FightLoop.onBorn）
function pushRound(conn, f, fightList, enterList, roundEffects) {
  if (f.weather && f.weather.weather_end_round > 0 && f.round >= f.weather.weather_end_round) {
    f.weather = { start_weather: 0, weather_end_round: 0 };
  }
  const alive = f.enemies.filter(e => e.hp > 0).length + f.enemyBench.length;
  const effects = roundEffects || (fightList && fightList.roundEffects) || [];
  // wire id 映射（一百八十八 方案 A'）：effect 的 atk/src/tar 内部 id → 客户端战斗 id
  const wireMap = {};
  f.allies.concat(f.allyBench || [], f.enemies, f.enemyBench || []).forEach(u => { if (u) wireMap[u.id] = bidOfUnit(u); });
  // 三百：回合内被移出主力的单位（阵亡→替补补位 splice）仍可能被本回合 effect 引用——
  // 用回合开始快照补齐映射（对象上的 bid 在分配后终身有效），杜绝内部 id 透传
  const snap = fightList && fightList.wireById;
  if (snap) snap.forEach((u, id) => { if (u && wireMap[id] == null) wireMap[id] = bidOfUnit(u); });
  const toWire = n => wireMap[n] != null ? wireMap[n] : n;
  // 纯演出型 effect（change_value 为空）一律清空 tar：客户端 rage/HP/SKILL 等分支会直接拿
  // change_value[下标] 做算术，空值即 "attempt to perform arithmetic" 刷屏卡死（三百·续）。
  const wireEffects = effects.map(e => FC.sanitizeEffectTargets(e)).map(e => Object.assign({}, e, {
    atk_servant_id: toWire(e.atk_servant_id),
    src_servant_id: toWire(e.src_servant_id),
    tar_servant_ids: (e.tar_servant_ids || []).map(toWire),
  }));
  conn.sendToc('m_fight_servant_fight_toc', {
    fight_id: f.fightId,
    fight_type: 0,
    fight_round: f.round,
    round_start: f.round === 1 ? 1 : 0,
    fight_list: fightList || [],
    enter_list: enterList || [],
    summon_List: [],
    stand_list: [],
    remove_stand_list: [],
    effect_list: wireEffects,
    opp_servant_num: alive,
    update: [], // 幻梦战 PP 无限：不发 UPDATE_DATA_TYPE_SKILL_PP
    weather: f.weather || { start_weather: 0, weather_end_round: 0 },
    spec_type: '',
    spec_value: [],
    update_attr_list: [],
    element_wake_times: 0,
    select_time: Math.floor(Date.now() / 1000) + 30,
  });
}

// 替补补位：主力阵亡的空格由替补依次填入（返回本回合要进场的 p_servant）
function reinforce(f) {
  const enters = [];
  const fill = (field, bench, ally) => {
    for (let i = 0; i < field.length; i++) {
      if (field[i].hp > 0 || !bench.length) continue;
      const dead = field[i];
      const sub = bench.shift();
      sub.pos = dead.pos.slice();  // 顶上阵亡者的格位
      sub.slot = dead.slot;
      field[i] = sub;
      // wire id：buildFight 已给全员预分配（含替补）→ 沿用；只有意外无 bid 的单位才现分配
      //（同一分配器，同场绝不复用；重复分配会让"客户端已见 id"与"内部对象"错位）
      if (ally) bidOfAlly(sub, f);
      else if (!(sub.bid && FC.isWireBid(sub.bid))) sub.bid = bidAllocOf(f).next(1);
      enters.push(unitToc(sub));
      log(`[dream] 替补上场：${ally ? '我方' : '敌方'} ${sub.id}(lv${sub.level}) 接替阵亡的 ${dead.id}`);
    }
  };
  fill(f.allies, f.allyBench, true);
  fill(f.enemies, f.enemyBench, false);
  return enters;
}

// ---- 单回合结算 ----
function affordable(u, sid) {
  return !R.isRageSkill(sid) || u.rage >= R.rageCostOf(sid);
}
// 精准打击（机制 3）：全部幻梦普攻（魔法箭 + 属性冲击）优先攻击敌方后排（|x| 最大排，同路优先）
function preciseTarget(f, actor, skillId, foes) {
  if (!f.flags || !f.flags.precise || !R.isBasicSkill(skillId) || !foes.length) return null;
  const maxX = Math.max(...foes.map(t => Math.abs(Number(t.pos[0]) || 0)));
  const backRow = foes.filter(t => Math.abs(Number(t.pos[0]) || 0) === maxX);
  return FC.nearestOne(backRow, actor);
}
// 幻梦专属技能决策（敌我同口径）：
//   回合开始怒气达标即放唯一怒气技，不足则用普攻；不吃主线 3 技能作战策略（SkillChoice）。
//   兼容冒烟测试直接覆写 u.skills、以及天击/永恒解脱/凝视/心灵暗示等异常限制。
function dreamPickSkillId(u, manual) {
  const skills = Array.isArray(u.skills) ? u.skills : [];
  if (manual && skills.some(s => s.id === manual.skillId) && affordable(u, manual.skillId)) {
    return Number(manual.skillId);
  }
  const has = sid => sid > 0 && skills.some(s => Number(s.id) === Number(sid));
  const rageSid = has(u.rageSkill) ? Number(u.rageSkill)
    : ((skills.find(s => R.isRageSkill(s.id)) || {}).id || 0);
  const basicSid = has(u.basicSkill) ? Number(u.basicSkill)
    : ((skills.find(s => !R.isRageSkill(s.id)) || {}).id || rageSid || R.basicSkillOf(u.type, u.servant, u.star));
  const isAtk = sid => {
    const c = R.dreamSkillCfg(sid);
    return !!(c && (Number(c.type) === 1 || Number(c.type) === 2) && Number(c.power) > 0);
  };
  // 心灵暗示（10003）：只允许使用被锁定技能（怒气足够时）
  if ((u.mindShackleCount || 0) > 0 && u.mindShackleSkillId != null) {
    const ms = Number(u.mindShackleSkillId);
    if (has(ms) && affordable(u, ms)) return ms;
  }
  // 凝视（10269）：禁用上次技能，另一技能可用则切换
  if ((u.gazeRounds || 0) > 0 && u.gazeSkillId != null) {
    const gs = Number(u.gazeSkillId);
    if (gs === rageSid && basicSid && basicSid !== gs) return basicSid;
    if (gs === basicSid && rageSid && rageSid !== gs && affordable(u, rageSid)) return rageSid;
  }
  // 天击（10261）/ 永恒解脱（10323）：封锁攻击技时，优先用可用的非攻击怒气技
  if ((u.noAttackRounds || 0) > 0 || u.eternalReleased) {
    if (rageSid && affordable(u, rageSid) && !isAtk(rageSid)) return rageSid;
    if (basicSid && !isAtk(basicSid)) return basicSid;
  }
  // 标准幻梦规则：怒气足够 → 放怒气技；否则 → 普攻
  if (rageSid && affordable(u, rageSid)) return rageSid;
  return basicSid;
}
function dreamFallbackBasic(u) {
  const skills = Array.isArray(u.skills) ? u.skills : [];
  if (u.basicSkill && skills.some(s => Number(s.id) === Number(u.basicSkill))) return Number(u.basicSkill);
  const nonRage = skills.find(s => !R.isRageSkill(s.id));
  return nonRage ? Number(nonRage.id) : R.basicSkillOf(u.type, u.servant, u.star);
}
// 治疗修正（机制 1/4/5）。返回 p_fight_effect 条目数组
function settleHeal(f, cfg, targets, mode) {
  const out = [];
  for (const t of targets) {
    if (!t || t.hp <= 0) continue;
    const amount = Math.ceil((t.maxHp * cfg.healPct) / 100);
    if (mode === 'block') {
      out.push({ target: t.id, hurt: 0, final_hp: t.hp, extra: 0 });
    } else { // reverse：回复无效且扣除等量生命
      const after = Math.max(0, t.hp - amount);
      out.push({ target: t.id, hurt: amount, final_hp: after, extra: 0 });
      t.hp = after;
    }
  }
  return out;
}

// 怒气同步 effect（三百）：客户端唯一回合内刷条通道 = FeatureLoop.lua:353 独立 if
// `change_type == FIGHT_EFF_CHANGE_TYPE_RAGE(200003)` → 按目标下标取 change_value →
// Servant.UpdateRage **绝对赋值**（slot0.rage = 值 + headItem 刷条）。此前服务端只算不发
// ⇒ 怒气条恒 0（廿六"回合内不显形属官方限制"的结论证伪：官方通道一直在，只是没实现）。
// id=60120：FightFeature 表内 name-only 条目——dealFeatureEff 主循环对每条 effect 无条件
// GetFeature(id,true) 查表（缺表=每条 printError 刷屏，二百七十一 D9b 同族）；无 tips ⇒ 无飘字、
// 无 act ⇒ 不播动画也不插空 p_fight。与二百九十静默 HP 直改族的兜底 id 同源。
// tar/change_value 单条单目标（D9 拆分规则：change_value 按目标下标消费）。
function rageEffect(u, phase) {
  return {
    id: 60120, src_type: 3, src_id: 0,
    src_servant_id: u.id, atk_servant_id: u.id,
    tar_servant_ids: [u.id],
    change_type: 200003,
    change_value: [Math.max(0, Math.round(u.rage))], // 涨/扣后的绝对值
    effect_phase: phase || 7,
    trigger_count: 0, remove_round: 0,
  };
}

function resolveRound(f, selMap) {
  const units = f.allies.concat(f.enemies);
  const stateCheck = FC.validateBattleState(f, units);
  if (!stateCheck.ok) log(`[dream] 回合状态已规整 round=${f.round} repairs=${stateCheck.repairs}`);
  const byId = new Map(units.map(u => [u.id, u]));
  const fightList = [];
  const roundEffects = [];
  // 回合开始全员涨怒 → 每单位一条 200003 同步 effect（phase 7 = 回合开始结算段）
  // 御四家狂化天赋（97000~97030）额外 +25% 怒气获取
  units.forEach(u => {
    if (u.hp > 0) {
      u.rage = R.rageAfterRound(u.rage, u.talent);
      roundEffects.push(rageEffect(u, 7));
    }
  });
  let actIndex = 0;
  const startTalents = FC.settleRoundStartTalents(units, f.round || 1, actIndex, f);
  if (startTalents.length) roundEffects.push(...startTalents);
  const aliveFoes = side => units.filter(u => u.hp > 0 && u.side !== side);
  const aliveFriends = side => units.filter(u => u.hp > 0 && u.side === side);
  const manualOf = u => (u.side === 0 && selMap) ? (selMap[u.id] || (u.bid != null ? selMap[u.bid] : null) || null) : null;

  // 回合开始快照全员本回合计划施放的技能（怒气达标即放怒气技，不足则普攻），
  // 传给 applySkillPriorities 保证先制怒气技（+1 优先度）仅在真正施放的回合生效
  const plannedMap = {};
  units.forEach(u => {
    if (u.hp > 0) plannedMap[u.id] = dreamPickSkillId(u, manualOf(u));
  });
  FC.applySkillPriorities(units, f, plannedMap); // 批次E：官方技能优先度进排序
  const actors = FC.sortActors(units, f);
  for (let ai = 0; ai < actors.length; ai++) {
    const actor = actors[ai];
    if (actor.hp <= 0) continue;
    if (!aliveFoes(actor.side).length) break;

    // 行动前异常状态判定（睡眠/冻结/麻痹/混乱）
    const actCheck = FC.checkUnitCanAct(actor, units, actIndex);
    // 三百一十三：成功路径也可能带效果（checkUnitCanAct 的行动前状态表现，如海星狂热消耗的 300020
    // /灵魂画手成功自损）——与 map_fight 同口径无条件并入，不再只在失败路径消费
    if (actCheck.effects && actCheck.effects.length) {
      roundEffects.push(...actCheck.effects);
    }
    if (!actCheck.canAct) {
      const wAtk = bidOfUnit(actor); // wire id
      if (actCheck.selfHit) {
        fightList.push({
          atk_id: wAtk,
          skill_id: 10081,
          index: actIndex,
          power_point: 99,
          effect_list: [{
            type: 0, target: wAtk, hurt: actCheck.selfDmg,
            final_hp: actCheck.finalHp,
            shield_hurt: 0, final_shield: Math.max(0, actor.shield || 0),
            element_shield_hurt: 0, final_element_shield: 0, extra: 0,
          }],
          result: 0,
        });
        actIndex++;
      } else {
        fightList.push({
          atk_id: wAtk,
          skill_id: 10081,
          index: actIndex,
          power_point: 99,
          effect_list: [],
          result: 1, // SKILL_RESULT_FAIL
        });
        actIndex++;
      }
      continue;
    }

    // 决策：采用回合开始快照的技能（若回合中怒气被吸干导致不再足够，则回落普攻）
    const manual = manualOf(actor);
    let skillId = plannedMap[actor.id] || dreamPickSkillId(actor, manual);
    if (!affordable(actor, skillId)) skillId = dreamFallbackBasic(actor);
    let cfg = R.dreamSkillCfg(skillId);
    // 暗噬 1101 是幻梦战普攻威力加成；作用于全部幻梦普攻（魔法箭 + 属性冲击），怒气技仍走 CfgDream 原威力
    if (cfg && actor.side === 0 && R.isBasicSkill(skillId) && actor.servant) {
      const add = CH.attackAddOf(actor.servant);
      if (add) cfg = Object.assign({}, cfg, { power: Number(cfg.power || 0) + add });
    }
    if (!cfg || !affordable(actor, skillId)) continue;

    // 目标解析：绝大多数幻梦 effType（1002/1051/1010/1011/1106/1108/2005/2008/2012/2014/2016/2103 等）
    // 由 targetsOfEff 严格按官方站位/条件几何决定；仅对少数“任意选择”类（1007/1052/1056）及精准打击指定 main。
    const foesNow = aliveFoes(actor.side);
    let main = null;
    let effTypeForTargets = cfg.effType;
    const pt = preciseTarget(f, actor, skillId, foesNow);
    if (pt) {
      main = pt;
      effTypeForTargets = 1007; // 精准打击覆写普攻 1002，直指后排同路目标（仍走嘲讽/天赋链）
    } else if (FREE_CHOICE_EFFS.has(Number(cfg.effType))) {
      if (manual && manual.targetPos) {
        main = FC.resolveTargetPos(foesNow, manual.targetPos);
      }
      if (!main) {
        const best = FC.bestAttackChoice(actor, units, [{ id: skillId, pp: 1 }], foesNow);
        main = (best && best.main) || foesNow[0] || null;
      }
    }

    const friendEff = FC.isFriendEff(effTypeForTargets);
    let targets = [];
    if (Number(effTypeForTargets) === 4001) {
      // 幻梦 effType=4001 包含 6 个天气技 + 6 个屏障/场地技（10001/10002/10009/10235/10250/10241）：
      // 10241 冰之结界在 skill_effect_data 中按 target 施加减速，传敌方全体防落 [actor] 自减速；其余传 [actor] 走天气/全队/场地分支
      targets = (Number(cfg.id) === 10241) ? foesNow : [actor];
    } else if ((cfg.healPct && !(cfg.power > 0)) || friendEff) {
      targets = FC.targetsOfEff(effTypeForTargets, actor.side, units, main, actor, cfg.id);
    } else {
      targets = FC.targetsOfEff(effTypeForTargets, actor.side, units, main, actor, cfg.id).filter(t => t.side !== actor.side);
    }
    if (!targets.length) targets = friendEff ? [actor] : (main ? [main] : foesNow.slice(0, 1));
    const choice = { skillId, main };

    // 梦境治疗封锁/反转只作用于纯治疗技；复合攻击技（天之甘露等）正常走伤害结算
    const isPureHeal = !!(cfg.healPct && !(cfg.power > 0));
    const mode = isPureHeal ? R.healModeOf(f.barrier, actor.side) : 'ok';
    const effects = (isPureHeal && mode !== 'ok')
      ? settleHeal(f, cfg, targets, mode)
      : FC.settleSkill(actor, cfg, targets, units, null, actIndex, f);

    if (effects.wakeEffects && effects.wakeEffects.length) {
      // 三百·续：wakeEffects 是 settleSkill 的**旁路**出口，不经过 fight_core 的 flattenEffects
      // ⇒ 多值单目标（21740 亚巴顿转移全部负面属性等 4 处）不会被拆，客户端只应用第 1 项。
      // 这里统一过 flatten（含按目标拆条 + 空值清 tar + 零变化过滤）。
      roundEffects.push(...FC.flattenEffects(effects.wakeEffects));
    }
    if (effects.weatherChange) {
      f.weather = effects.weatherChange;
      log(`[dream] 天气变更: ${f.weather.start_weather}, 持续至第 ${f.weather.weather_end_round} 回合`);
    }

    // 技能衍生属性等级与 Buff 效果结算
    const skillEffs = FC.applySkillEffects(actor, cfg, targets, units, actIndex, f);
    if (skillEffs.length) roundEffects.push(...skillEffs);

    // 被动天赋触发
    const talentEffs = FC.checkTalentsAfterSkill(actor, cfg, targets, effects, units, actIndex, f);
    if (talentEffs.length) roundEffects.push(...talentEffs);

    // 怒气：使用怒气技扣费；受击方额外涨怒（各自发 200003 同步客户端怒气条，三百）
    if (R.isRageSkill(choice.skillId)) {
      actor.rage = Math.max(0, actor.rage - R.rageCostOf(choice.skillId));
      roundEffects.push(rageEffect(actor, 4)); // phase 4 = 技能后结算段
    }
    effects.forEach(e => {
      const t = byId.get(e.target);
      if (t && e.hurt > 0 && t.hp > 0) {
        t.rage = R.rageAfterHit(t.rage);
        roundEffects.push(rageEffect(t, 4));
      }
    });
    fightList.push({
      atk_id: bidOfUnit(actor), // wire id
      skill_id: choice.skillId,
      index: actIndex, power_point: 99, // 幻梦战次数无限
      effect_list: effects.map(e => ({
        type: 0, target: bidOfUnit(byId.get(e.target) || { bid: e.target }), hurt: e.hurt, final_hp: e.final_hp,
        shield_hurt: Number(e.shield_hurt) || 0, final_shield: Number(e.final_shield) || 0,
        element_shield_hurt: 0, final_element_shield: 0, extra: e.extra,
      })),
      result: 0,
    });
    actIndex++;
    FC.applyLureReorder(actors, ai);
  }

  // 回合末异常状态伤害扣减与持续时间自然衰减
  const endTicks = FC.settleRoundEndTicks(units, f);
  if (endTicks.length) roundEffects.push(...endTicks);

  fightList.roundEffects = roundEffects;
  // 三百：回合结算会把阵亡者 splice 出主力数组（替补补位）——本回合 effect（回合开始涨怒/天赋）
  // 仍引用被移出的对象，pushRound 的 wireMap 若只按结算后的数组建，这些 id 查无映射 → toWire
  // 原样透传内部 id → 客户端「不存在对象：70000002」每帧刷屏。把回合开始时的 units 快照
  // （对象上 bid 已分配）一并挂下去，pushRound 补齐映射（跟对象走，不跟数组走）。
  fightList.wireById = byId;
  return fightList;
}

// ---- 胜利结算 ----
function onWin(conn, f) {
  const s = st();
  const barrier = f.barrier;
  const firstClear = !s.cleared.includes(barrier);
  // 1) 固定材料（银钥/秘丸 + 里程碑碎片）
  const rewards = [];
  const changed = [];
  for (const it of R.itemRewardOf(barrier)) {
    changed.push(...grantGoods(it.id, it.num, conn));
    rewards.push({ type: it.id, num: it.num });
  }
  if (changed.length) pushGoodsUpdate(conn, changed, 3);
  // 2) 概率掉落誓灵（里程碑关；首通必给，避免 25% 反复空手——本地服口径）
  const dropType = firstClear ? R.milestoneServantOf(barrier) : R.rollServantDrop(barrier);
  const servantReward = [];
  if (dropType) {
    const first = handbookMod.isUnlocked(dropType) ? 0 : 1; // 先判后建卡：makeServantBrief 会激活图鉴
    const brief = makeServantBrief(dropType);
    // 非法 type（makeServantBrief 已记日志）：不入列、不宣告、不展示——
    // 否则毒化客户端 ServantMgr 类型计数表，祭坛 updateRankList 会索引 nil 崩
    if (brief) {
      require('./servant').grantServantBrief(brief);
      servantReward.push({ id: dropType, val: 1, type: 1 });
      // 该实例 3s 后才随 m_servant_update_toc 告知客户端；期间 pushServantChanges → pushFameUpdates
      // 若带上它会崩客户端祭坛（ServantMgr 查不到 sid → 选人 VO.configVO=nil）
      altarMod.markPendingAnnounce([brief.id]);
      // 言灵录："获得X"（含 ownDays 计时起点）
      try {
        const MM = require('./moment');
        MM.onServantObtained([Number(brief.type)]);
        MM.checkUnlocks(conn);
      } catch (e) { /* 言灵录异常不阻塞掉落 */ }
      setTimeout(() => {
        conn.sendToc('m_servant_update_toc', {
          new: [{ servant: brief, is_first: first }], update: [], del: [], reward_type: 2,
        });
        altarMod.clearPendingAnnounce([brief.id]); // 先宣告实例，再补推名气
        altarMod.pushFameUpdates(conn);
        handbookMod.pushRedPoints(conn);
      }, 3000);
    }
  }
  // 3) 誓灵经验（结算面板按 DreamMgr.getMainServants() 建 VO → 只给主力）+ 指挥官经验
  const gain = R.servantExpOf(barrier);
  const servantExp = [], changes = [];
  for (const a of f.allAllies || f.allies.concat(f.allyBench)) {
    const b = S.servants.find(x => x.id === a.id);
    if (!b) continue;
    const got = a.hp > 0 ? gain : Math.floor(gain / 2);
    const r = TRAIN.applyServantExp(b, got);
    servantExp.push({ id: a.id, val: r.gained, type: 0 });
    if (r.gained > 0) {
      changes.push({ servant_id: a.id, key: CHANGE_ID_EXP, val: r.exp });
      if (r.level !== r.oldLevel) changes.push({ servant_id: a.id, key: CHANGE_ID_LEVEL, val: r.level });
    }
  }
  const roleGain = R.roleExpOf(barrier);
  const roleR = applyRoleExpGain(roleGain);
  pushRoleExpChange(conn); // 必须先于结算包（CopyRewardPanel 以新 GlobalData.exp 为动画终点）
  // 星云点（御灵士星图）：誓灵实得经验 1/750 转化（同 map_fight 结算口径）
  require('./grow').gainNebula(conn, servantExp.reduce((s, x) => s + x.val, 0));
  // 4) 进度推进
  if (firstClear) s.cleared.push(barrier);
  s.max = Math.max(s.max, barrier);
  const isLast = barrier >= R.MAX_BARRIER;
  s.now = isLast ? R.MAX_BARRIER : barrier + 1;
  if (isLast) { s.isFight = 0; s.failTimes = 0; } // 通关 130 关 → 本次挑战结束
  const mvpUnit = f.allies.filter(a => a.hp > 0).sort((a, b) => b.level - a.level)[0]
    || (f.allAllies || f.allies)[0] || {};
  // 成对协议背靠背 + 期间不写盘（gainNebula/落账各自 saveState，真机 fsync 500~950ms）
  batchWrites(() => {
    conn.sendToc('m_fight_result_toc', {
      fight_id: f.fightId, copy_id: f.copyId, result: 1,
      mvp: mvpUnit.id || 0,
      star: [], // 幻梦战不显示星（CopyRewardPanel.showStar 在 isDreamReady 时恒 false）
      gold: 0, silver: 0, role_exp: roleGain,
      servant_reward: servantReward, item_reward: rewards, servant_exp: servantExp,
      kill_num: R.barrierCfg(barrier).monsters.length,
      mvp_stats: [], score: 0, add_score: 0, replace_list: [],
    });
    // scene_result 必须背靠背 result_toc（客户端 onFightBatchEnd(checkResult()) 竞态，
    // 间隔被推送拉开会误报「由于网络问题导致战斗结果还没收到」，map_fight 2026-10-12 同修）
    conn.sendToc('m_fight_scene_result_toc', { fight_id: f.fightId, result: 1 });
    if (changes.length) pushServantChanges(conn, changes);
    if (roleR.leveledUp) pushRoleLevelup(conn);
  });
  pushInfo(conn); // 面板复位后不会重拉 info（onOpen(false) 不走 onOpenToc），必须主动推
  log(`[dream] 第${barrier}关 胜利${firstClear ? '（首通）' : ''} → 进度 ${s.now}/${R.MAX_BARRIER} 最深 ${s.max}`
    + ` 奖励[${rewards.map(r => r.type + '×' + r.num).join(',')}]${dropType ? ' 掉落誓灵 ' + dropType : ''}`);
  S.dreamFight = null;
  saveState();
}

// ---- 战败结算 ----
// 官方 CopyUtil.backDreamReadyPanel：败北返回时若 failTimes==2 或 dailyTimes<=0 则回到入口面板。
// 第 3 败 → 本次挑战结束（now 归 1、failTimes 归 0）；前 10 关失败不计数。
function onLose(conn, f, reason) {
  const s = st();
  const counted = f.barrier > R.FREE_FAIL_BARRIER;
  if (counted) s.failTimes += 1;
  const runOver = s.failTimes >= R.MAX_FAIL;
  if (runOver) { s.isFight = 0; s.now = 1; s.failTimes = 0; }
  // 战败也要发 LOSE 结算包（2026-10-01）：客户端 FightModule 的 RESULT_LOSE 分支对所有
  // 战斗类型无条件 openRewardPanel → CopyRewardPanel(RoleBuffView isShort) 读
  // CopyMgr.getResult(fightId)，缺包 → resultVO nil → 崩溃（其他玩家实测报错）
  conn.sendToc('m_fight_result_toc', {
    fight_id: f.fightId, copy_id: f.copyId, result: 0,
    mvp: 0, star: [], gold: 0, silver: 0, role_exp: 0,
    servant_reward: [], item_reward: [], servant_exp: [],
    kill_num: (R.barrierCfg(f.barrier) || { monsters: [] }).monsters.length,
    mvp_stats: [], score: 0, add_score: 0, replace_list: [],
  });
  conn.sendToc('m_fight_scene_result_toc', { fight_id: f.fightId, result: 0 });
  pushInfo(conn);
  log(`[dream] 第${f.barrier}关 战败（${reason}）失败次数 ${counted ? s.failTimes || R.MAX_FAIL : '不计（前10关）'}`
    + `${runOver ? ' → 本次挑战结束' : ''}`);
  S.dreamFight = null;
  saveState();
}

// 检查终局。返回 true 表示本回合已出结果
function checkEnd(conn, f) {
  const allyDead = f.allies.every(a => a.hp <= 0) && !f.allyBench.length;
  const foeDead = f.enemies.every(e => e.hp <= 0) && !f.enemyBench.length;
  if (foeDead && !allyDead) { f.over = 2; onWin(conn, f); return true; }
  if (allyDead) { f.over = 1; onLose(conn, f, foeDead ? '同归于尽' : '我方全灭'); return true; }
  return false;
}

// 开启一次挑战：扣 1 次挑战次数，进度归 1，失败计数清零
function startRun(conn) {
  const s = st();
  if (s.dailyLeft <= 0) return false;
  s.dailyLeft -= 1;
  s.isFight = 1;
  s.now = 1;
  s.failTimes = 0;
  autoEmbattleIfEmpty();
  saveState();
  log(`[dream] 开始挑战：剩余次数 ${s.dailyLeft}`);
  return true;
}

module.exports = {
  handlers: {
// ---- 面板状态 ----
m_copy_dream_info_tos(conn) {
  pushInfo(conn);
},
// 布阵详情（DreamEnterPanel 点开始/继续挑战 → begin_tos 后立刻发）
m_embattle_detail_tos(conn, obj) {
  autoEmbattleIfEmpty();
  conn.sendToc('m_embattle_detail_toc', {
    id: (obj && obj.id) || 1,   // 幻梦战队伍号恒 1（DreamReadyPanelVO.getTeamId）
    detail: embattleList().map(e => ({ pos: e.pos, id: e.id })),
  });
  saveState();
},
// 拖拽换位/上下阵：客户端一次只发一条 p_kvi{id=目标格, val=誓灵id(0=下阵)}
m_embattle_update_tos(conn, obj) {
  const teamId = (obj && obj.id) || 1;
  const kv = ((obj && obj.update) || [])[0];
  if (!kv) return conn.sendToc('m_embattle_update_toc', { id: teamId, update: [] });
  const pos = Number(kv.id) || 0;
  const sid = Number(kv.val) || 0;
  if (pos > 0 && (sid === 0 || S.servants.some(x => x.id === sid))) {
    applyEmbattle(pos, sid);
    saveState();
  }
  // 回包只带这一条（客户端 DreamMgr.updateServant 自行完成换位/顶替的本地镜像）
  conn.sendToc('m_embattle_update_toc', { id: teamId, update: [{ pos, id: sid }] });
  const c = costOfEmbattle();
  log(`[dream] 布阵更新 pos=${pos} servant=${sid}；主队 ${c.main}/${R.MAIN_COST_MAX} 副队 ${c.sub}/${R.SUB_COST_MAX}`);
},
// 切换已由暗噬节点解锁的怒气技。
m_chaos_select_rage_skill_tos(conn, obj) {
  const sid = Number(obj && obj.servant_id) || 0;
  const skill = Number(obj && obj.skill_id) || 0;
  const type = Number(obj && obj.type) || R.TYPE_DREAM;
  const b = S.servants.find(x => x.id === sid);
  if (type !== R.TYPE_DREAM || !b || !isFuncOpen() || !CH.rageSkillsOf(b).includes(skill) || CH.isBusy(S, b)) {
    return err(conn, ERR_COPY_ID, `怒气技切换非法 servant=${sid} skill=${skill}`);
  }
  const old = b.rage_skill;
  b.rage_skill = skill;
  try { saveState({ throwOnError: true }); }
  catch (e) { b.rage_skill = old; return err(conn, ERR_COPY_ID, '怒气技存档失败，已回滚'); }
  conn.sendToc('m_chaos_select_rage_skill_toc', { type, servant_id: sid, skill_id: skill });
  log(`[dream] 誓灵 ${sid} 怒气技 → ${skill}（${(R.D.RAGE_SKILLS[skill] || {}).name}，费 ${R.rageCostOf(skill)}）`);
},
// 开始挑战
m_copy_dream_begin_tos(conn) {
  const s = st();
  if (!isFuncOpen()) return err(conn, ERR_COPY_ID, '银匙之门未解锁（需通关 5-4）');
  if (s.isFight) { conn.sendToc('m_copy_dream_begin_toc', {}); return pushInfo(conn); } // 已在挑战中：幂等
  if (!startRun(conn)) return err(conn, ERR_TIMES, '今日挑战次数已用尽');
  conn.sendToc('m_copy_dream_begin_toc', {});
  pushInfo(conn);
},
// 退出本次挑战（面板原文：退出后结束该次挑战并无法获得后续奖励）
m_copy_dream_quit_tos(conn) {
  const s = st();
  s.isFight = 0; s.now = 1; s.failTimes = 0;
  S.dreamFight = null;
  saveState();
  conn.sendToc('m_copy_dream_quit_toc', {});
  pushInfo(conn);
  log('[dream] 退出本次挑战');
},
// 快速战斗（跳关）：已达过的关卡免战斗直接判胜并发奖，逐关推进
m_copy_dream_jump_tos(conn) {
  const s = st();
  if (!isFuncOpen()) return err(conn, ERR_COPY_ID, '银匙之门未解锁（需通关 5-4）');
  if (!s.isFight && !startRun(conn)) return err(conn, ERR_JUMP_TIMES, '今日挑战次数已用尽');
  if (s.now > s.max) return err(conn, ERR_JUMP_MAX, `已到达历史最高关卡（now=${s.now} max=${s.max}）`);
  const barrier = s.now;
  const rewards = [], changed = [];
  for (const it of R.itemRewardOf(barrier)) {
    changed.push(...grantGoods(it.id, it.num, conn));
    rewards.push({ type: it.id, num: it.num });
  }
  if (changed.length) pushGoodsUpdate(conn, changed, 3);
  s.now = Math.min(R.MAX_BARRIER, barrier + 1);
  if (barrier >= R.MAX_BARRIER) { s.isFight = 0; s.failTimes = 0; }
  saveState();
  conn.sendToc('m_copy_dream_jump_toc', {});
  pushInfo(conn); // 客户端 jump_toc 本地做了 dailyTimes+1（官方客户端笔误），必须补推纠正
  log(`[dream] 跳关：第${barrier}关 直接通过 → 进度 ${s.now} 奖励[${rewards.map(r => r.type + '×' + r.num).join(',')}]`);
},
// 买钥之匙（+1 挑战次数，每日 2 次，70/80 水晶）
m_copy_dream_buy_times_tos(conn) {
  const s = st();
  if (s.buyTimes >= R.D.BUY_KEY.maxTimes) return err(conn, ERR_BUY_TIMES, '今日购买次数已用完');
  const cost = R.buyCostOf(s.buyTimes);
  if (S.roleAsset.gold + S.roleAsset.gold_given < cost) return err(conn, 542006, `水晶不足（需 ${cost}）`);
  // 先扣赠送水晶再扣充值水晶（与商店同口径）
  let left = cost;
  const useGiven = Math.min(S.roleAsset.gold_given, left);
  S.roleAsset.gold_given -= useGiven; left -= useGiven;
  S.roleAsset.gold -= left;
  s.buyTimes += 1;
  s.dailyLeft += 1;
  saveState();
  pushAssetChange(conn);
  conn.sendToc('m_copy_dream_buy_times_toc', {});
  pushInfo(conn);
  log(`[dream] 购买钥之匙：花费 ${cost} 水晶 → 剩余挑战次数 ${s.dailyLeft}（今日已购 ${s.buyTimes}/${R.D.BUY_KEY.maxTimes}）`);
},
// ---- 战斗链（幻梦 copy 走本模块，其余一律回落 map_fight）----
// 客户端 DreamReadyPanelVO.toFight → CopyModule.toFight(COPY_DREAM + nowBarrier)
m_copy_fight_tos(conn, obj) {
  const copyId = Number(obj && obj.copy_id) || 0;
  if (!R.isDreamCopy(copyId)) { S.dreamFight = null; return MF.handlers.m_copy_fight_tos(conn, obj); }
  const s = st();
  if (!isFuncOpen()) return err(conn, ERR_COPY_ID, '银匙之门未解锁（需通关 5-4）');
  const barrier = R.barrierOf(copyId);
  if (!R.barrierCfg(barrier)) return err(conn, ERR_COPY_ID, `关卡不存在 copy=${copyId}`);
  // 挑战未开启（第 3 败/退出后客户端仍可能停在布阵面板）→ 等价于点「开始挑战」
  if (!s.isFight && !startRun(conn)) return err(conn, ERR_TIMES, '今日挑战次数已用尽');
  // 钥之匙上限（官方错误码 1259003「消耗超过上限」）
  const c = costOfEmbattle();
  if (c.main > R.MAIN_COST_MAX || c.sub > R.SUB_COST_MAX) {
    return err(conn, ERR_COST, `钥之匙超限 主队 ${c.main}/${R.MAIN_COST_MAX} 副队 ${c.sub}/${R.SUB_COST_MAX}`);
  }
  if (!embattleList().filter(e => e.pos < 10).length) return err(conn, ERR_COPY_ID, '未上阵任何主力');
  // 客户端提交的 copy_id 以服务端进度为准（防跳关刷奖）
  const target = s.now;
  const fightId = S.nextFightId++;
  buildFight(fightId, target);
  S.dreamFight.ownerConn = conn;
  S.fightState = null; // 幻梦战独立状态，避免主线残留态串味
  conn.sendToc('m_copy_fight_toc', { copy_id: R.copyIdOf(target), fight_id: fightId });
},
m_fight_servant_start_tos(conn, obj) {
  const f = S.dreamFight;
  const fightId = Number(obj && obj.fight_id) || 0;
  if (!f || (fightId && f.fightId !== fightId)) return MF.handlers.m_fight_servant_start_tos(conn, obj);
  // 二百八十八：切后台重连后旧 owner 连接已关闭 → 新连接接管（同 map_fight select/start 接管）
  if (f.ownerConn && f.ownerConn !== conn && !MF.fightOwnerStale(f)) return err(conn, ERR_COPY_ID, '战斗连接已变更');
  f.ownerConn = conn;
  f.round = 1;
  f.over = 0;
  conn.sendToc('m_fight_servant_start_toc', { fight_id: f.fightId, side: 0, batch: 1, batch_num: 1 });
  // 三百一十三·续：入场天赋/天气/圣器共享随首包 effect_list 下发（客户端 onBatchEnd 的
  // TRIGGER_TIME_BORN 播放点=开局第一时间）。**顺序纪律**：先建进场包（入场前状态），再结算入场
  // （苏摩扣血等以 effect 增量下发）——与 map_fight assist 的既有顺序纪律同源。
  // settleRoundStartTalents 保留同三连兜底（flag 幂等，替补仍走其入场那一包）。
  const dreamEnters = f.allies.concat(f.enemies).map(unitToc);
  const dreamStartFx = FC.settleBattleStartTalents(f.allies.concat(f.enemies), f);
  pushRound(conn, f, [], dreamEnters, dreamStartFx);
},
m_fight_skill_select_tos(conn, obj) {
  const f = S.dreamFight;
  const fightId = Number(obj && obj.fight_id) || 0;
  if (!f || (fightId && f.fightId !== fightId)) return MF.handlers.m_fight_skill_select_tos(conn, obj);
  if (f.ownerConn && f.ownerConn !== conn && !MF.fightOwnerStale(f)) { conn.sendToc('m_fight_skill_select_toc', { err_code: 1 }); return; }
  f.ownerConn = conn;
  conn.sendToc('m_fight_skill_select_toc', { err_code: 0 });
  if (f.over) { log(`[dream] 忽略重复 select（战斗已结束 over=${f.over}）`); return; }
  f.round += 1;
  // 回合上限：官方面板原文「N 回合未分出胜负则失败」——超时判负
  if (f.round > f.maxRound) {
    f.over = 1;
    pushRound(conn, f, [], []);
    onLose(conn, f, `超过 ${f.maxRound} 回合未分出胜负`);
    return;
  }
  // select_list[].id 是客户端回传的战斗 id（bid）→ 反查回引擎内部 id（一百八十八 方案 A'）
  const selMap = {};
  ((obj && obj.select_list) || []).forEach(x => {
    if (!x || !x.id || !(Number(x.val) > 0)) return;
    const u = f.allies.concat(f.allyBench || [], f.enemies, f.enemyBench || [])
      .find(u => u && (bidOfUnit(u) === Number(x.id) || u.id === Number(x.id)));
    if (u) selMap[u.id] = { skillId: Number(x.val), targetPos: Number(x.type) || 0 };
  });
  const fightList = resolveRound(f, selMap);
  const enters = reinforce(f); // 阵亡格由替补补入（同回合包 enter_list → FightLoop.onBorn 增援表现）
  log(`[dream] 第${f.barrier}关 回合${f.round} 动作 ${fightList.length} 条；`
    + `敌方 [${f.enemies.map(e => e.hp).join(',')}]+${f.enemyBench.length}替补 `
    + `我方 [${f.allies.map(a => a.hp).join(',')}]+${f.allyBench.length}替补 `
    + `怒气 我[${f.allies.map(a => a.rage).join(',')}]`);
  pushRound(conn, f, fightList, enters);
  checkEnd(conn, f);
},
  },
  // 供 role.js 登录链 / GM / 冒烟测试复用
  st, pushInfo, embattleList, applyEmbattle, costOfEmbattle, autoEmbattleIfEmpty,
  buildFight, resolveRound, reinforce, unitToc, mkUnit, dreamSkillPool, startRun,
  onWin, onLose, checkEnd, isFuncOpen, onLogin,
};
