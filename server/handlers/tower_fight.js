// 无尽冒险战斗引擎（tower_fight.js）——800xxxx copy 的战斗会话。
// 模式沿用 dream.js（独立会话状态 + 回合包 + 替补增援），差异：
//   · 我方单位 = towerState.team 的 12 槽（p_tower_servant），HP 跨层冻结（savedHp 写回）；
//   · 敌方 = tower_data.makeWave(floor)（单波，无替补）；
//   · 无怒气/机制/回合上限（主线规则，30 回合兜底判负沿用）；
//   · 胜利 → tower.settleWin（结晶/里程碑/进度），战败 → 回恢复点重编队。
'use strict';
const { S, saveState, batchWrites } = require('../state');
const L = require('../lib');
const { log } = L;
const T = require('../data/tower_data');
const FC = T.FC;
const CH = require('../data/chaos_data');
const { equipBonusOf, relicBonusOf, applyEnchant } = require('../data/relic_data'); // 核心装备与圣器附加（与主线同口径）
const FD = require('../data/faith_data');               // 信仰附加（本体套装 teamId=0）
const { usingSkillsOf } = require('./servant');
const SC = require('./skill_choice');                   // 作战策略（我方自动选技介入，FC.allyChoose）

const MAGIC_ARROWS = new Set(Object.values(FC.MAGIC_ARROW || {}));
const FIGHT_MAX_ROUND = 30;

// ---- 战斗单位 wire-id（bid）映射（一百八十八 方案 A'，同 map_fight/dream）----
// 引擎内部 id 不动（我方=真实誓灵 id；savedHp 跨层冻结/结算经验全按内部 id）；下发/回传走 bid。
// ⚠️ 顺带修复（审计发现）：敌方内部 id 原基址 90000001 与玩家誓灵 id 空间（nextServantId=90000001）
// 正面冲突——同场 1 号敌方单位与 1 号我方誓灵同 id，引擎 units.find(u=>u.id===target) 会先命中
// 我方。改 75000001（与誓灵 9 段、幻梦 7 段均不冲突；wire id 仍由 bid 单独分配，不依赖内部值）。
const ENEMY_INTERNAL_ID_BASE = 75000001;
function bidAllocOf(f) {
  if (!f.bidAlloc) f.bidAlloc = FC.newBidAllocator();
  return f.bidAlloc;
}
function bidOfAlly(unit, f) {
  if (unit.bid && FC.isWireBid(unit.bid)) return unit.bid; // 跨层/替补续用已分配 bid（同场稳定）
  unit.bid = bidAllocOf(f).next(0);
  return unit.bid;
}
const bidOfUnit = u => (u && u.bid != null) ? u.bid : u.id; // 兜底：无 bid 用 id（值域断言会抓）

// 我方站位（主线 map_fight 同款 TILE_OF_POS）：**左半场 = tile x 负值**（客户端
const ALLY_TILES = { 1: [-2, -1], 2: [-2, 0], 3: [-2, 1], 4: [-3, -1], 5: [-3, 0], 6: [-3, 1] };
const ENEMY_TILES = { 1: [2, -1], 2: [2, 0], 3: [2, 1], 4: [3, -1], 5: [3, 0], 6: [3, 1] };

const briefPosOf = (x, y) => (500 + x) * 1000 + 500 + y;

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
  // o.extra：我方装备附加（核心 + 信仰，六维，形状同 calcAttrs 的 extra）；敌方不传
  const attrs = o.servant ? CH.normalAttrsOf(o.servant, o.extra || {}) : FC.calcAttrs(o.type, o.level, null, 0, o.extra || {}, FC.stepOfStar(o.star || 4));
  // 我方只使用誓灵当前装备的技能槽（三百零二：空攻池自动补已学最强攻击技，learnedIds 取 o.servant）；
  // 敌方才按等级使用完整技能池。
  const ids = o.usingIds == null
    ? FC.buildSkillPool(o.type, o.level, null).slice()
    : FC.buildUsingPool(o.type, o.usingIds, o.servant && Array.isArray(o.servant.learned_skills) ? o.servant.learned_skills : null);
  if (o.usingIds == null) {
    const arrow = FC.MAGIC_ARROW[FC.natureOf(o.type)] || 10018;
    if (!ids.includes(arrow)) ids.push(arrow);
  }
  const scale = o.scale || 1; // 病毒感染档：敌方数值乘区
  for (const k of Object.keys(attrs)) attrs[k] = Math.round(attrs[k] * scale);
  const unit = {
    id: o.id, type: o.type, nature: FC.natureOf(o.type), level: o.level, star: o.star || 4,
    skin: o.skin || o.type * 100 + 1, side: o.side, pos: o.pos.slice(),
    hp: attrs.hp, maxHp: attrs.hp, shield: 0, attrs,
    // 信仰增伤/减伤（我方；敌方为 0）。与主线 mkAllyUnit 同口径，供结算折算
    dmgMul: o.dmgMul || 0, selfMit: o.selfMit || 0,
    critLv: o.critLv || 0,
    critMul: o.critMul || 0,
    critMit: o.critMit || 0,
    immuneCrit: !!o.immuneCrit,
    natMul: o.natMul || {},
    weekMul: o.weekMul || 0,
    talent: o.talent || FC.talentOf(o.type) || 0,
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
    skills: ids.map(id => ({ id, pp: (FC.skillCfg(id) || {}).pp || 30 })),
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

// p_servant 进场包
function unitToc(u) {
  const skills = u.skills.map(s => {
    const cfg = FC.skillCfg(s.id) || {};
    const max = cfg.pp || 30;
    return { id: s.id, type: cfg.type || 0, nature: cfg.nature || 0, power_point: max, max_power_point: max, state: 0, state_reason: [] };
  });
  const statLevels = u.statLevels || {};
  const buffs = u.buffs || {};
  return {
      id: u.bid != null ? u.bid : u.id, type: u.type, name: '', skin_id: u.skin, nature: u.nature,
      feature: u.talent ? [u.talent] : [], item: u.relicId ? [u.relicId] : [], level: u.level,
      skill: skills, using_skill: u.skills.map(s => s.id),
      attr: {
        hp: u.hp, rage: 0, shield: Math.max(0, Math.round(u.shield || 0)), element_shield: [], hp_list: [],
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
    brief_pos: briefPosOf(u.pos[0], u.pos[1]),
    buffs: Object.keys(buffs).map(bid => ({ id: Number(bid), val: buffs[bid].level || 1 })),
    morph_id: 0, power: 0, element: [], role_id: 0,
  };
}

// 建立一场塔战。我方 = team.slots 1-6 主力 / 7-12 替补（HP 用冻结值起步）
function buildFight(fightId, floor) {
  const t = S.towerState && S.towerState.team;
  const allies = [], allyBench = [];
  if (t) {
    for (let slot = 1; slot <= 12; slot++) {
      const sid = Number(t.slots[slot]) || 0;
      if (!sid) continue;
      const b = S.servants.find(x => x.id === sid);
      if (!b) continue;
      const saved = t.savedHp && t.savedHp[sid];
      const extra = equipBonusOf(b, S.bagGoods);
      const fb = FD.faithAttrBonusOf(b, S.bagGoods, 0);
      for (const k of Object.keys(fb)) extra[k] = (extra[k] || 0) + fb[k];
      const fm = FD.faithFightModsOf(b, S.bagGoods, 0);
      const rb = relicBonusOf(b, S.bagGoods);
      const u = mkUnit({
        id: b.id, type: b.type, level: b.level, star: Number(b.star) || 2,
        side: 0, pos: (ALLY_TILES[slot <= 6 ? slot : slot - 6] || ALLY_TILES[1]).slice(),
        skin: Number(b.skin_id) || 0, // 真实当前皮肤（9 位尾数 1-4 = spine 星级形态；见 map_fight fightServantOf 注）
        extra, dmgMul: fm.dmg + (rb.dmgMul || 0), selfMit: fm.mit,
        critLv: rb.critLv || 0,
        critMul: rb.critMul || 0,
        critMit: rb.critMit || 0,
        immuneCrit: !!rb.immuneCrit,
        natMul: rb.natMul || {},
        weekMul: rb.weekMul || 0,
        talent: CH.talentOf(b), servant: b,
        relicHurtByWeek: rb.onHurtByWeek || null,
        relicDeathSave: rb.deathSaveChance > 0 ? { chance: rb.deathSaveChance, feature: rb.deathSaveFeature } : null,
        relicLowHpHeal: rb.lowHpHeal || null,
        relicDodgeBonus: rb.dodgeBonus || 0,
        relicHitBonus: rb.hitBonus || 0,
        relicMisc: relicMiscOf(rb),
        relicCure: rb.cureOnce || null,
        relicDeathGuard: rb.deathGuardPct || 0,
        openShieldPct: rb.openShieldPct || 0,
        usingIds: usingSkillsOf(b),
         relicId: (() => { const g = S.bagGoods.find(x => Number(x.id) === Number(b.relic_gid)); return g ? Number(g.type_id) || 0 : 0; })(),
      });
      applyEnchant(u.attrs, S.bagGoods.find(g => Number(g.id) === Number(b.relic_gid)));
      if (rb.phyAtkMul) u.attrs.phy_atk = Math.round(u.attrs.phy_atk * (1 + rb.phyAtkMul));
      if (rb.magAtkMul) u.attrs.mag_atk = Math.round(u.attrs.mag_atk * (1 + rb.magAtkMul));
      const rarityColor = Math.floor(Number(b.type) / 10000) % 10;
      const defOk = !rb.rOnly || rarityColor <= 2;
      if (defOk && rb.defPct) u.attrs.phy_def = Math.round(u.attrs.phy_def * (1 + rb.defPct));
      if (defOk && rb.mdefPct) u.attrs.mag_def = Math.round(u.attrs.mag_def * (1 + rb.mdefPct));
      if (saved) {
        u.hp = Math.max(0, Math.min(saved.hp, u.maxHp));
        for (const sk of u.skills) {
          if (saved.skillsState && saved.skillsState[sk.id] != null) sk.pp = saved.skillsState[sk.id];
        }
      }
      (slot <= 6 ? allies : allyBench).push(u);
    }
  }
  const enemies = [];
  let eid = ENEMY_INTERNAL_ID_BASE;
  for (const e of T.makeWave(floor)) {
    enemies.push(mkUnit({
      id: eid++, type: e.type, level: e.level, star: e.boss ? 5 : 4,
      side: 1, pos: (ENEMY_TILES[e.pos || 1] || ENEMY_TILES[1]).slice(),
      talent: e.talent || FC.talentOf(e.type) || 0,
    }));
  }
  // ── 本周词条（塔 buff）：对全队生效一次（含替补，进场时就带上）──
  const effectIds = require('./tower').activeEffects();
  const mods = T.modsOf(effectIds);
  for (const u of allies.concat(allyBench)) applyBuffMods(u, mods);
  // wire-id 分配（一百八十八 方案 A'）：我方=真实誓灵 id 不动、敌内部 id 已改 75 段；
  // bid 在这里统一落（我方 100.. / 敌方 2100..），跨层重开战重新分配（savedHp 按内部 id 冻结，不受影响）
  const fBidAlloc = FC.newBidAllocator();
  allies.concat(allyBench).forEach(u => { u.bid = fBidAlloc.next(0); });
  enemies.forEach(u => { u.bid = fBidAlloc.next(1); });
  // 战斗录制（回放用）：进场单位快照（buff 已生效后的状态，与手动开战 pushRound 的 enter_list 同形状）
  const record = { units: allies.concat(enemies).map(unitToc), rounds: [] };
  // 战果统计基线：进本关时的 HP/PP（战果页签血量条 = 开打前 vs 打完后）
  for (const u of allies.concat(allyBench)) {
    u.hp0 = u.hp;
    u.pp0 = Object.fromEntries(u.skills.map(sk => [sk.id, sk.pp]));
  }
  S.towerFight = {
    fightId, floor, copyId: 8000000 + floor, round: 0, over: 0,
    allies, allyBench, enemies,
    allAllies: allies.concat(allyBench),
    buffEffects: effectIds, mods, record,
    bidAlloc: fBidAlloc, // 替补增援续用同一分配器（同场绝不复用）
  };
  log(`[tower] 开战第${floor}关 fight=${fightId} 我方 ${allies.length}(+${allyBench.length}替补) 敌方 ${enemies.length}（lv${enemies[0].level}${enemies[0].star === 5 ? ' BOSS' : ''}）`
    + `${effectIds.length ? `，词条生效 [${effectIds.join(' ')}]` : '，本周词条未激活'}`);
  return S.towerFight;
}

// 把 buff 结论打到单位上（战斗是服务端算的，不落这里就等于面板文案骗人）
//
// ⚠️ 必须是**叠加**不是覆盖（2026-11-05 修）：u.natMul / u.weekMul 在 buildFight 里
// 已经装入了圣器的同名字段（relicBonusOf.natMul / .weekMul，例如 90000012 的 {"6":0.03}），
// 原实现 `u.natMul = Object.assign({}, mods.natMul)` 会在词条生效时把圣器加成**整个清掉**
// ——玩家看到的是"词条生效了，但圣器伤害反而掉了"。空词条时也不能清（mods 全 0 时等价于无操作）。
function applyBuffMods(u, mods) {
  u.natMul = Object.assign({}, u.natMul || {});
  for (const k of Object.keys(mods.natMul || {})) u.natMul[k] = (u.natMul[k] || 0) + mods.natMul[k];
  u.natWeekMul = Object.assign({}, u.natWeekMul || {});
  for (const k of Object.keys(mods.natWeekMul || {})) u.natWeekMul[k] = (u.natWeekMul[k] || 0) + mods.natWeekMul[k];
  u.weekMul = (u.weekMul || 0) + mods.weekMul;
  u.antiWeek = (u.antiWeek || 0) + mods.antiWeek;
  u.dmgMul = (u.dmgMul || 0) + mods.dmgMul;
  u.selfMit = (u.selfMit || 0) + mods.selfMit;
  u.critMul = (u.critMul || 0) + mods.critAdd;
  u.attrs.phy_atk = Math.round(u.attrs.phy_atk * mods.atkMul.phy_atk);
  u.attrs.mag_atk = Math.round(u.attrs.mag_atk * mods.atkMul.mag_atk);
  if (mods.shieldPct > 0) u.shield = Math.round(u.maxHp * mods.shieldPct);
}

// 回血表现：与治疗技能同形状（hurt 为负 = 回血），客户端据此刷血条
function healEntry(unit, heal) {
  return {
    atk_id: unit.id, skill_id: (unit.skills[0] || {}).id || 0, index: 0, power_point: (unit.skills[0] || {}).pp || 0,
    effect_list: [{
      type: 0, target: unit.id, hurt: -heal, final_hp: unit.hp,
      shield_hurt: 0, final_shield: 0, element_shield_hurt: 0, final_element_shield: 0, extra: 0,
    }],
    result: 0,
  };
}

// ---- 回合帧的 wire 化（内部 id → 客户端战斗 id/bid）----
// 一百八十八 方案 A'：fight_list/effect 的 atk_id/target/atk_servant_id/src_servant_id/
// tar_servant_ids 全部走 bid。**录制与下发必须共用这一处**：
// 2026-11-05 无限领域「自动战斗的回放卡死」的根因就是自动 tick 绕过了 pushRound，
// 直接把 resolveRound 的**内部 id**（我方 9000007x / 敌方 7500000x）塞进 f.record.rounds，
// 而 rec.units 是 unitToc 产出的 bid 形态（100.. / 2100..）⇒ 回放时客户端
// SceneUnitManager 查不到单位，FightLoop.CheckAct 的 GetUnit(...):Play 无 nil 守卫，
// 每帧 LuaError、actStepTab 不推进 ⇒ 卡死在回放里（工作指南二百九十①同族）。
// snap（fightList.wireById）：回合结算会把阵亡者移出主力数组，本回合的回合开始 effect
// 仍引用被移出的对象——按回合开始快照补齐映射（跟对象走，不跟数组走，同 dream:407）。
function wireRound(f, fightList, enterList, roundEffects) {
  const wireMap = {};
  f.allies.concat(f.allyBench || [], f.enemies).forEach(u => { if (u) wireMap[u.id] = bidOfUnit(u); });
  const snap = fightList && fightList.wireById;
  if (snap) snap.forEach((u, id) => { if (u && wireMap[id] == null) wireMap[id] = bidOfUnit(u); });
  const toWire = n => (wireMap[n] != null ? wireMap[n] : n);
  const wl = (fightList || []).map(a => Object.assign({}, a, {
    atk_id: toWire(a.atk_id),
    effect_list: (a.effect_list || []).map(e => Object.assign({}, e, { target: toWire(e.target) })),
  }));
  // 纯演出型 effect（change_value 为空）清空 tar（三百·续：客户端数值分支拿 change_value[下标] 算术）
  const we = (roundEffects || []).map(e => FC.sanitizeEffectTargets(e)).map(e => Object.assign({}, e, {
    atk_servant_id: toWire(e.atk_servant_id),
    src_servant_id: toWire(e.src_servant_id),
    tar_servant_ids: (e.tar_servant_ids || []).map(toWire),
  }));
  // 增援进场包 id 同步（内部 id → bid）
  const wEnters = (enterList || []).map(u => Object.assign({}, u, { id: toWire(u.id) }));
  return { wl, we, wEnters };
}

// 只录制不推包：自动战斗（tick）唯一的采集入口，保证 wire 形态与手动场次一致。
function recordRound(f, fightList, enterList, roundEffects) {
  if (!f.record) return null;
  const r = wireRound(f, fightList, enterList, roundEffects);
  f.record.rounds.push({ fight_list: r.wl, enter_list: r.wEnters });
  return r;
}

function pushRound(conn, f, fightList, enterList, roundEffects) {
  const { wl, we, wEnters } = wireRound(f, fightList, enterList, roundEffects);
  if (f.record) f.record.rounds.push({ fight_list: wl, enter_list: wEnters });
  const alive = f.enemies.filter(e => e.hp > 0).length;
  const effects = we;
  if (f.weather && f.weather.start_weather > 0 && f.weather.weather_end_round > 0 && f.round > f.weather.weather_end_round) {
    f.weather = { start_weather: 0, weather_end_round: 0 };
  }
  conn.sendToc('m_fight_servant_fight_toc', {
    fight_id: f.fightId,
    fight_type: 0,
    fight_round: f.round,
    round_start: f.round === 1 ? 1 : 0,
    fight_list: wl,
    enter_list: wEnters,
    summon_List: [],
    stand_list: [],
    remove_stand_list: [],
    effect_list: effects,
    opp_servant_num: alive,
    update: [],
    weather: f.weather || { start_weather: 0, weather_end_round: 0 },
    spec_type: '',
    spec_value: [],
    update_attr_list: [],
    element_wake_times: 0,
    select_time: Math.floor(Date.now() / 1000) + 30,
  });
}

// 替补补位（同 dream）
function reinforce(f) {
  const enters = [];
  for (let i = 0; i < f.allies.length; i++) {
    if (f.allies[i].hp > 0 || !f.allyBench.length) continue;
    const dead = f.allies[i];
    const sub = f.allyBench.shift();
    sub.pos = dead.pos.slice();
    f.allies[i] = sub;
    bidOfAlly(sub, f); // 上场才分配 wire id（与 buildFight 同一分配器，同场绝不复用）
    enters.push(unitToc(sub));
    log(`[tower] 替补上场：${sub.id} 接替阵亡的 ${dead.id}`);
  }
  return enters;
}

// 单回合结算（支持异常状态判定、增益/减益 Buff 与能力等级倍率）
function resolveRound(f, selMap) {
  const units = f.allies.concat(f.enemies);
  // 回合开始单位快照：结算会把阵亡者移出主力数组（reinforce 补位），本回合 effect 仍引用
  // 被移出的对象——wireRound 用它补齐 bid 映射（同 dream:515/676）。
  const byId = new Map(units.map(u => [u.id, u]));
  const stateCheck = FC.validateBattleState(f, units);
  if (!stateCheck.ok) log(`[tower] 回合状态已规整 round=${f.round} repairs=${stateCheck.repairs}`);
  const fightList = [];
  const roundEffects = [];
  let actIndex = 0;
  const startTalents = FC.settleRoundStartTalents(units, f.round || 1, actIndex, f);
  if (startTalents.length) roundEffects.push(...startTalents);
  const aliveFoes = side => units.filter(u => u.hp > 0 && u.side !== side);
  const aliveFriends = side => units.filter(u => u.hp > 0 && u.side === side);

  // ── 词条 8「每回合自动恢复 X% 血量」：回合开始先结算，回血单独成 fight_list 条目 ──
  const regenPct = (f.mods && f.mods.regenPct) || 0;
  if (regenPct > 0) {
    for (const a of f.allAllies) {
      if (a.hp <= 0 || a.hp >= a.maxHp) continue;
      const heal = Math.min(a.maxHp - a.hp, Math.ceil(a.maxHp * regenPct));
      if (heal <= 0) continue;
      a.hp += heal;
      fightList.push(healEntry(a, heal));
    }
  }

  FC.applySkillPriorities(units, f, null); // 批次E：官方技能优先度进排序
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
      if (actCheck.selfHit) {
        fightList.push({
          atk_id: actor.id,
          skill_id: 10081,
          index: actIndex,
          power_point: 99,
          effect_list: [{
            type: 0, target: actor.id, hurt: actCheck.selfDmg,
            final_hp: actCheck.finalHp,
            shield_hurt: 0, final_shield: Math.max(0, actor.shield || 0),
            element_shield_hurt: 0, final_element_shield: 0, extra: 0,
          }],
          result: 0,
        });
        actIndex++;
      } else {
        fightList.push({
          atk_id: actor.id,
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

    let choice = null;
    const manual = actor.side === 0 ? selMap[actor.id] : null;
    if (manual && actor.skills.some(s => s.id === manual.skillId && s.pp > 0)) {
      let main = null;
      if (manual.targetPos) {
        const tx = Math.floor(manual.targetPos / 1000) - 500, ty = (manual.targetPos % 1000) - 500;
        main = aliveFoes(actor.side).find(e => e.pos[0] === tx && e.pos[1] === ty)
          || aliveFoes(actor.side).find(e => Math.abs(e.pos[0]) === Math.abs(tx) && e.pos[1] === ty) || null;
      }
      const mc = FC.skillCfg(manual.skillId);
      if (mc && (mc.healPct && !(mc.power > 0) || FC.isFriendEff(mc.effType)) && !main) { // 复合攻击技仍默认打敌人
        let ratio = 2;
        aliveFriends(actor.side).forEach(x => { const r = x.hp / x.maxHp; if (r < ratio) { ratio = r; main = x; } });
      }
      if (!main) main = (mc && FC.isFriendEff(mc.effType)) ? actor : aliveFoes(actor.side)[0];
      choice = { skillId: manual.skillId, main };
    }
    // 决策统一走 autoChoose（三百零三；自律派遣 auto_fight 经 resolveRound 同步继承）：
    // PS_AI_SEARCH=0 走贪心 B1（原行为），1/2 走期望树。作战策略模式内部优先于搜索。
    if (!choice) choice = FC.autoChoose(actor, units, { allyCtx: SC.aiCtxOf(), battleState: f, advanceCycle: true });
    const cfg = FC.skillCfg(choice.skillId);
    if (!cfg) continue;

    const friendEff = FC.isFriendEff(cfg.effType);
    let targets = [];
    if ((cfg.healPct && !(cfg.power > 0)) || friendEff) { // 纯治疗/增益技；复合攻击技按攻击技走敌方过滤
      targets = FC.targetsOfEff(cfg.effType, actor.side, units, choice.main, actor, cfg.id);
    } else {
      targets = FC.targetsOfEff(cfg.effType, actor.side, units, choice.main, actor, cfg.id).filter(t => t.side !== actor.side);
    }
    if (!targets.length) targets = friendEff ? [actor] : (choice.main ? [choice.main] : []);

    const effects = FC.settleSkill(actor, cfg, targets, units, null, actIndex, f);
    if (effects.wakeEffects && effects.wakeEffects.length) {
      // 三百·续：wakeEffects 是旁路出口，须过 flatten（多值单目标拆条 + 空值清 tar）
      roundEffects.push(...FC.flattenEffects(effects.wakeEffects));
    }
    if (effects.weatherChange) {
      f.weather = effects.weatherChange;
      log(`[tower] 天气变更: ${f.weather.start_weather}, 持续至第 ${f.weather.weather_end_round} 回合`);
    }

    // 技能衍生属性等级与 Buff 效果结算
    const skillEffs = FC.applySkillEffects(actor, cfg, targets, units, actIndex, f);
    if (skillEffs.length) roundEffects.push(...skillEffs);

    // 被动天赋触发
    const talentEffs = FC.checkTalentsAfterSkill(actor, cfg, targets, effects, units, actIndex, f);
    if (talentEffs.length) roundEffects.push(...talentEffs);

    // 成就统计（对敌伤害/最大单Hit/击杀属性）+ 本回合我方输出总额（词条 19 吸血用）
    let dealt = 0;
    for (const e of effects) {
      const victim = units.find(u => u.id === e.target);
      if (!victim || victim.side === actor.side) continue;
      const dmg = Math.max(0, Number(e.hurt) || 0);
      dealt += dmg;
      if (dmg > 0) f.dmgDealt = (f.dmgDealt || 0) + dmg;
      if (dmg > (f.maxHit || 0)) f.maxHit = dmg;
      if (Number(e.final_hp) <= 0 && dmg > 0) {
        const n = cfg.nature || 0;
        f.killNature = f.killNature || {};
        f.killNature[n] = (f.killNature[n] || 0) + 1;
        f.killsTotal = (f.killsTotal || 0) + 1;
      }
    }
    const sk = actor.skills.find(s => s.id === choice.skillId);
    if (sk && sk.pp > 0) sk.pp -= 1;
    fightList.push({
      atk_id: actor.id, skill_id: choice.skillId, index: actIndex,
      power_point: sk ? sk.pp : 0,
      effect_list: effects.map(e => ({
        type: 0, target: e.target, hurt: e.hurt, final_hp: e.final_hp,
        shield_hurt: Number(e.shield_hurt) || 0, final_shield: Number(e.final_shield) || 0,
        element_shield_hurt: 0, final_element_shield: 0, extra: e.extra,
      })),
      result: 0,
    });
    actIndex++;

    // ── 词条 19「造成伤害时恢复伤害值 X%」（吸血，仅我方）──
    const ls = (f.mods && f.mods.lifestealPct) || 0;
    if (ls > 0 && actor.side === 0 && dealt > 0 && actor.hp > 0 && actor.hp < actor.maxHp) {
      const heal = Math.min(actor.maxHp - actor.hp, Math.max(1, Math.round(dealt * ls)));
      actor.hp += heal;
      fightList.push(healEntry(actor, heal));
    }
    FC.applyLureReorder(actors, ai);
  }

  // 回合末异常状态伤害扣减与自然衰减
  const endTicks = FC.settleRoundEndTicks(units, f);
  if (endTicks.length) roundEffects.push(...endTicks);

  fightList.roundEffects = roundEffects;
  fightList.wireById = byId ?? new Map(units.map(u => [u.id, u]));
  return fightList;
}

// 胜利：tower.settleWin 记账 + 结算包（exp 走主线口径）。
// opts.silent = 自动战斗：不推 m_fight_result_toc / m_fight_scene_result_toc（客户端不在战斗场景，
// 推了会弹结算面板打断挂机视图），结晶进暂存库由战报"领取"统一发放（opts 经 settleWin 的 toStore 传递）
function onWin(conn, f, opts) {
  const silent = !!(opts && opts.silent);
  const r = require('./tower').settleWin(conn, f.floor, f, { toStore: silent });
  finishRecord(f);
  const expGain = 30 + Math.floor(f.floor / 2) * 6;
  const servantExp = [], changes = [];
  for (const a of f.allAllies) {
    if (a.hp <= 0) continue;
    const b = S.servants.find(x => x.id === a.id);
    if (!b) continue;
    const res = require('../data/train_data').applyServantExp(b, expGain);
    servantExp.push({ id: a.id, val: res.gained, type: 0 });
    if (res.gained > 0) {
      changes.push({ servant_id: a.id, key: 1, val: res.exp });
      if (res.level !== res.oldLevel) changes.push({ servant_id: a.id, key: 2, val: res.level });
    }
  }
  const roleR = L.applyRoleExpGain(10 + Math.floor(f.floor / 5));
  L.pushRoleExpChange(conn);
  // 星云点（御灵士星图）：誓灵实得经验 1/750 转化（同 map_fight 结算口径）
  require('./grow').gainNebula(conn, servantExp.reduce((s, x) => s + x.val, 0));
  const mvp = f.allies.filter(a => a.hp > 0).sort((a, b) => b.level - a.level)[0] || f.allAllies[0] || {};
  if (!silent) {
    // scene_result 必须背靠背 result_toc（客户端 onFightBatchEnd(checkResult()) 竞态，
    // 间隔被推送拉开会误报「由于网络问题导致战斗结果还没收到」，map_fight 2026-10-12 同修）。
    // 2026-10-17：settleWin/gainNebula 会 saveState（真机 fsync 500~950ms），整段进事务。
    batchWrites(() => {
      conn.sendToc('m_fight_result_toc', {
        fight_id: f.fightId, copy_id: f.copyId, result: 1,
        mvp: mvp.id || 0, star: [], gold: 0, silver: 0, role_exp: 10 + Math.floor(f.floor / 5),
        servant_reward: [], item_reward: r.rewards, servant_exp: servantExp,
        kill_num: f.enemies.length, mvp_stats: [], score: 0, add_score: 0, replace_list: [],
      });
      conn.sendToc('m_fight_scene_result_toc', { fight_id: f.fightId, result: 1 });
      if (changes.length) L.pushServantChanges(conn, changes);
      if (roleR.leveledUp) L.pushRoleLevelup(conn);
    });
  } else {
    if (changes.length) L.pushServantChanges(conn, changes);
    if (roleR.leveledUp) L.pushRoleLevelup(conn);
  }
  require('./tower').pushInfo(conn);
  S.towerFight = null;
  saveState();
  log(`[tower] 第${f.floor}关胜利${silent ? '（自动）' : ''} → 进度 ${(S.towerState && S.towerState.barrier) || '?'}`);
}

// 战败：进度回恢复点（重编队再战），失败不扣体力（官方规则）。
// opts.silent = 自动战斗：不推 m_fight_result_toc / m_fight_scene_result_toc
function onLose(conn, f, reason, opts) {
  const silent = !!(opts && opts.silent);
  const s = S.towerState;
  const t = s && s.team;
  s.barrier = (t && t.fromBarrier) || 1;
  s.team = null; // 官方语义：重新挑战可重新编辑队伍
  saveState();
  // 战败也要发 LOSE 结算包（2026-10-01）：客户端 FightModule 的 RESULT_LOSE 分支对所有
  // 战斗类型无条件 openRewardPanel → CopyRewardPanel(RoleBuffView isShort) 读
  // CopyMgr.getResult(fightId)，缺包 → resultVO nil → 崩溃（其他玩家实测报错）。
  // silent（自动战斗挂机）不推——客户端不在战斗场景，与 onWin 同口径。
  if (!silent) {
    conn.sendToc('m_fight_result_toc', {
      fight_id: f.fightId, copy_id: f.copyId, result: 0,
      mvp: 0, star: [], gold: 0, silver: 0, role_exp: 0,
      servant_reward: [], item_reward: [], servant_exp: [],
      kill_num: (f.enemies || []).length, mvp_stats: [], score: 0, add_score: 0, replace_list: [],
    });
    conn.sendToc('m_fight_scene_result_toc', { fight_id: f.fightId, result: 0 });
  }
  require('./tower').pushInfo(conn);
  log(`[tower] 第${f.floor}关战败（${reason}）${silent ? '（自动）' : ''} → 回恢复点 ${s.barrier}，编队已清空`);
  S.towerFight = null;
  saveState();
}

// 战斗是否已分胜负（checkEnd 与自动战斗循环共用）：'win' | 'lose' | null
function outcomeOf(f) {
  const foeDead = f.enemies.every(e => e.hp <= 0);
  const allyDead = f.allies.every(a => a.hp <= 0) && !f.allyBench.length;
  if (foeDead && !allyDead) return 'win';
  if (allyDead) return 'lose';
  return null;
}

// ── 战斗录制落库（回放 + 战果页签数据源，仅胜利场次）──
// 客户端回放协议（FightRecordMgr/FightRecordInfoVO 反编译实证）：
//   m_fight_record_info_tos → toc{copy_id, fight_id, record_num, result_index}
//   → 客户端进战斗场景 → m_fight_record_msg_tos(index)：
//     index=1 → 服务端推 m_fight_servant_start_toc（batch 头）
//     index=i≥2 → 推第 i-1 回合 m_fight_servant_fight_toc（第 1 回合 enter_list=全部进场单位）
//   record_num = 回合数 + 1；msg_toc{result:1} = 录像过期中止
function finishRecord(f) {
  const rec = f.record;
  if (!rec) return 0;
  const s = S.towerState;
  S.towerRecords = S.towerRecords || {};
  s.floorRecords = s.floorRecords || {};
  // 战果页签（p_tower_servant_change）：**全体进场我方单位**，开打前 vs 打完后的 HP/PP。
  // 2026-11-05 改（用户拍板「全体进场实现」）：原实现只取 `f.allies`（结算瞬间在场的主力），
  // 会漏掉两类本场真实参战的单位 ——
  //   · 替补席 `allyBench`（玩家上了 12 只却只列 6 只）；
  //   · 本场**阵亡被换下**的主力（reinforce 把 allyBench.unshift 出的替补塞进 allies[i]，
  //     原主力对象已离开 f.allies）⇒ 输掉的那只恰好在战果里看不到。
  // allAllies 是 buildFight 时就冻结的 12 只全量快照，hp0/pp0 也在这同一批对象上采集，
  // 阵亡者 hp=0 自然显示为「血量归零」，正是玩家要看的。
  const results = (f.allAllies || f.allies).filter(u => u && u.hp0 != null).map(u => ({
    skin_id: u.skin,
    level: u.level,
    hp_change: { id: Math.max(0, Math.round(u.hp0)), type: u.maxHp, val: Math.max(0, Math.round(u.hp)) },
    skill_change: u.skills.map(sk => ({
      id: sk.id,
      val: u.pp0 && u.pp0[sk.id] != null ? u.pp0[sk.id] : sk.pp, // PP 消耗前
      type: sk.pp,                                               // PP 剩余（客户端 nowPP）
    })),
  }));
  const unitIds = new Set(rec.units.map(u => u.id));
  const recId = S.nextFightId++;
  // 结算帧（回放的最后一条 msg）：m_fight_result_toc 供奖励面板数据 + scene_result 触发退场
  const mvp = f.allies.filter(a => a.hp > 0).sort((a, b) => b.level - a.level)[0] || {};
  const resultToc = {
    fight_id: f.fightId, copy_id: f.copyId, result: 1,
    mvp: mvp.id || 0, star: [], gold: 0, silver: 0, role_exp: 0,
    servant_reward: [], item_reward: [], servant_exp: [],
    kill_num: (f.enemies || []).length, mvp_stats: [], score: 0, add_score: 0, replace_list: [],
  };
  S.towerRecords[recId] = {
    id: recId, fightId: f.fightId, copyId: f.copyId, floor: f.floor,
    ts: Math.floor(Date.now() / 1000),
    units: rec.units,
    // 第 1 回合的进场单位已由 units 提供，rounds 里只留真正的增援
    rounds: rec.rounds.map((r, i) => ({
      fight_list: r.fight_list || [],
      enter_list: i === 0 ? (r.enter_list || []).filter(u => !unitIds.has(u.id)) : (r.enter_list || []),
    })),
    results,
    resultToc,
  };
  s.floorRecords[f.floor] = recId;
  // LRU：只保留最近 10 场录像（存档体积考虑），被裁掉的层 detail 回空战果 + 回放走"录像已过期"
  const all = Object.values(S.towerRecords).sort((a, b) => b.ts - a.ts);
  for (const old of all.slice(10)) {
    delete S.towerRecords[old.id];
    for (const [fl, rid] of Object.entries(s.floorRecords)) {
      if (Number(rid) === Number(old.id)) delete s.floorRecords[fl];
    }
  }
  log(`[tower] 录制第${f.floor}关战斗录像 record=${recId}（${rec.rounds.length} 回合，留档 ${Object.keys(S.towerRecords).length} 场）`);
  return recId;
}

function checkEnd(conn, f) {
  const foeDead = f.enemies.every(e => e.hp <= 0);
  const o = outcomeOf(f);
  if (o === 'win') { f.over = 2; onWin(conn, f); return true; }
  if (o === 'lose') { f.over = 1; onLose(conn, f, foeDead ? '同归于尽' : '我方全灭'); return true; }
  return false;
}

module.exports = {
  buildFight, pushRound, wireRound, recordRound, reinforce, resolveRound, checkEnd, outcomeOf,
  onWin, onLose, finishRecord,
  unitToc, mkUnit,
  isTowerFight: () => !!S.towerFight,
};
