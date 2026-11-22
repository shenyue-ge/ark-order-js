// 银匙之门（幻梦战）规则与数值基线。
// 分工：dream_data.js = 客户端配置全量镜像（自动生成，勿手改）；本文件 = 运行期规则 + 本地服数值设计。
//
// 客户端反编译实证的硬口径（**不可改**，改了面板与实战就不一致）：
// - 幻梦等级：`DreamServantDetailPanel.onClickBtnTip` 原文「幻梦战内誓灵等级=誓灵真实等级/4+暗噬成长线等级」
//   → ServantConfigVO.getLevelinFantasy()=ceil(level/4)，fantasyLevel=p_servant_brief.dream_lv（暗噬成长线，
//   功能17 未实现 → 恒 0）。属性走 calcFantasyPropVal = 与主线同一 realcalcPropVal，只是 lv 换成幻梦等级、
//   且**不吃能源/圣器/核心/信仰/混沌属性**（getFantasyPropVal 全传 0/nil）；暗噬核心只通过
//   p_servant_brief.dream_lv 进入幻梦等级，这是客户端真实暗噬路线的唯一属性入口。
// - 敌方等级：DreamBarrierVO 把 monsters.level*getLevelArg()(=4) 塞进 VO，面板再 /4 显示
//   → 展示等级恒 = 配置 level，属性直接用配置 level 算。
// - 种族值档位：敌方 star = skinID%10+1、我方 star = brief.star，档位 = ServantUtil.getStep(star)
//   （star<=2→1，否则 star-1）——与主线按颜色推档不同，必须显式传 step。
// - 场上九宫格：pos 1-9（DreamFightReadyPanel.createPosItems：x 2→4、y -1→1，我方 x 取反），
//   pos>=10 替补（listMySub/listEnemySub 预览）。主力上限 5（MAIN_NUM）、最少上场 2（SUB_NUM 复用为 min）。
// - 消耗（钥之匙）：DreamConst.DREAM_COST[1][11]=38 主队上限、[2][11]=15 副队上限；
//   单只消耗 = CfgDream.fightCost[color]（N6/R7/SR8/UR9）+ 两只特殊卡覆盖。
// - 技能次数：FightSkillItem 在幻梦战显示「次数无限」→ PP 不扣、不发 UPDATE_DATA_TYPE_SKILL_PP。
// - 怒气：CfgDream.rageSkills 里的技能（375 条，占技能表 3/4）在幻梦战**全部按怒气技处理**——
//   FightSkillMgr `hasRageSkill(id) → rageCost <= rage 才可用`；SkillVO.getFightEffType 在幻梦战
//   用 CfgDream 的 effType 覆盖主表（1007→1002、1052→1051、1056→1054 等同义档，威力/命中仍走主表）。
// - 怒气条上限 200（DreamAngerSkillBar：spMask.Height = rage/200*80）；客户端只在单位**进场**时刷条
//   （Servant.UpdateData → UpdateRage，全局无其他调用点）→ 回合内涨怒不会实时显形，属官方客户端限制。
// - 回合上限：CfgDream.specialMaxRound（101-120=20、121-130=15，其余 25），超时**判负**
//   （面板原文「N回合未分出胜负则失败」）。
// - 失败：3 次结束本次挑战；前 10 关失败不计数（DreamReadyPanelVO.updateCopyCommon 原文）。
//
// 官方不可考、由本地服设计的战斗资源数值（本文件集中，便于调参）：
// - 涨怒公式（RAGE_*）：官方无任何客户端痕迹（客户端只读 attr.rage）。
// - 每日挑战次数基数（DAILY_TIMES_BASE）：客户端只有「买钥之匙 2 次/日、70/80 水晶」；
//   免费次数官方初始公告明文「每日有3次挑战机会」（主线页按钮亦显示"剩余次数：3"，二百九十九）。
// - 概率掉落誓灵的概率（SERVANT_DROP_RATE）：wiki 只写「概率掉落」。
// - 战斗经验/指挥官经验（EXP_*）：与主线同性质的成长回报。
const D = require('./dream_data');
const FC = require('./fight_core');
const CH = require('./chaos_data');

const COPY_DREAM = 11000000;      // CopyConst.COPY_DREAM
const TYPE_DREAM = 11;            // CopyConst.TYPE_DREAM（copyId 第 7-8 位）
const MAX_BARRIER = 130;
const MAIN_NUM = 5;               // DreamConst.MAIN_NUM 主力上限
const MIN_NUM = 2;                // DreamConst.SUB_NUM，被 getServantMinNum 复用为“最少上场”
const SUB_POS = [10, 11];         // 替补两格（listMySub 固定取 pos 10/11）
const MAIN_COST_MAX = 38;         // DREAM_COST[1][TYPE_DREAM]
const SUB_COST_MAX = 15;          // DREAM_COST[2][TYPE_DREAM]
const MAX_FAIL = 3;
const FREE_FAIL_BARRIER = 10;     // 前 10 关失败不计数
const DEFAULT_MAX_ROUND = 25;     // DreamConfig.getMaxRound 兜底

// ---- 本地服数值基线 ----
const RAGE_MAX = 200;             // 客户端怒气条分母（硬口径）
const RAGE_START = 0;             // 进场怒气
const RAGE_PER_ROUND = 20;        // 每回合开始全员涨怒 → 50 费 3 回合、150 费 8 回合可用
const RAGE_ON_HIT = 5;            // 被命中额外涨怒（受击方）
const DAILY_TIMES_BASE = 3;       // 每日免费挑战次数（官方公告口径；+ 最多买 2 次钥之匙 = 5 次/日）
const SERVANT_DROP_RATE = 0.25;   // 里程碑关「概率掉落」誓灵
const EXP_BASE = 60;              // 誓灵经验 = EXP_BASE + 关数×EXP_PER_BARRIER（阵亡减半，与主线同规则）
const EXP_PER_BARRIER = 4;
const ROLE_EXP_BASE = 30;         // 指挥官经验 = ROLE_EXP_BASE + 关数×ROLE_EXP_PER_BARRIER
const ROLE_EXP_PER_BARRIER = 2;

// 场上九宫格 pos → 格坐标（敌方 x>0；我方 x 取反）。brief_pos 编码见 map_fight.briefPosOf
const TILE_OF_POS = {
  1: [2, -1], 2: [2, 0], 3: [2, 1],
  4: [3, -1], 5: [3, 0], 6: [3, 1],
  7: [4, -1], 8: [4, 0], 9: [4, 1],
};
function tileOfPos(pos, ally) {
  const t = TILE_OF_POS[pos] || TILE_OF_POS[2];
  return ally ? [-t[0], t[1]] : [t[0], t[1]];
}

// ---- id 判定 ----
function isDreamCopy(copyId) {
  const n = Number(copyId) || 0;
  return Math.floor(n / 1000000) % 100 === TYPE_DREAM; // CopyUtil.getCopyType(id)==11
}
function barrierOf(copyId) {
  return Number(copyId) - COPY_DREAM;
}
function copyIdOf(barrier) {
  return COPY_DREAM + Number(barrier);
}
function barrierCfg(barrier) {
  return D.DREAM_BARRIERS[Number(barrier)] || null;
}

// ---- 等级 / 属性 ----
// ServantUtil.getStep(star)：star<=2→1，否则 star-1（种族值 4 档）
function stepOfStar(star) {
  const s = Number(star) || 5;
  return s <= 2 ? 1 : Math.min(s - 1, 4);
}
// 暗噬成长由 chaos_data.js 的 1001~1006 节点提供，brief.dream_lv 仅是下发的派生字段。
function dreamGrowthOf(brief) {
  return CH.fantasyGrowthOf(brief || {});
}
// 幻梦等级 = ceil(真实等级/4) + dream_lv（客户端 ServantConfigVO 口径，逐字照抄）
function dreamLevelOf(brief) {
  const lv = Math.max(1, Number(brief && brief.level) || 1);
  return Math.ceil(lv / 4) + dreamGrowthOf(brief);
}
// 把真实成长值落到 brief.dream_lv（下发前调用，保证面板显示与服务端算力同源）
function syncDreamLv(list) {
  for (const b of list || []) CH.normalize(b);
}
// 幻梦六维：与面板 getFantasyPropVal 同源（无能源/圣器/核心/信仰加成）
function dreamAttrs(type, level, star, servant) {
  return FC.calcAttrs(type, level, null, 0, null, stepOfStar(star), servant ? CH.phyleOf(servant) : undefined);
}

// ---- 上阵消耗（钥之匙）----
// ServantConfigVO.color = typeId 第 5 位（1N 2R 3SR 4UR）；fightCost 按 color 取，特殊卡按 typeId 覆盖
function colorOf(type) {
  return Math.floor(Number(type) / 10000) % 10;
}
function costOfType(type) {
  const sp = D.FIGHT_COST.special[String(type)];
  if (sp != null) return Number(sp);
  const c = colorOf(type);
  return Number(D.FIGHT_COST.tiers[c - 1]) || 0;
}

// ---- 幻梦普攻（按擅长属性区分物/魔，与客户端 ServantConfigVO.getFantasyAttackType 同源）----
// 物理属性冲击：水~暗取主表物理冲击（Skill.lua/CfgSkillDetail.lua type=1/nature/fightAct 全对齐），
// 虚数属性取 60112 虚数冲击（客户端 CfgSkillDetail 复制粘贴标为 type=2，dreamSkillCfg 覆写回 type=1）。
// 魔法普攻：复用 FC.MAGIC_ARROW（10018/10037/10050/10061/10071/10081/60113）。
const PHY_IMPACT = {
  1: 10016, // 水流冲击
  2: 10030, // 火焰冲击
  3: 10043, // 旋风冲击
  4: 10055, // 碎岩冲击
  5: 10066, // 光能冲击
  6: 10076, // 暗影冲击
  8: 60112, // 虚数冲击
};
const DREAM_BASIC_SKILLS = new Set([...Object.values(FC.MAGIC_ARROW), ...Object.values(PHY_IMPACT)]);
function isBasicSkill(skillId) {
  return DREAM_BASIC_SKILLS.has(Number(skillId));
}
// ServantConfigVO.getFantasyAttackType: phyle[物攻] < phyle[魔攻] → 魔法(2)，否则 → 物理(1)
function fantasyAttackTypeOf(type, servant, star) {
  const customPhyle = servant ? CH.phyleOf(servant) : undefined;
  const st = star != null ? stepOfStar(star) : (servant && servant.star != null ? stepOfStar(servant.star) : undefined);
  const ph = customPhyle || FC.phyleOf(type, st);
  if (!ph) return 2; // 兜底魔法
  return (Number(ph[1]) || 0) < (Number(ph[2]) || 0) ? 2 : 1;
}
function basicSkillOf(type, servant, star) {
  const nat = FC.natureOf(type);
  const atkType = fantasyAttackTypeOf(type, servant, star);
  if (atkType === 1) return PHY_IMPACT[nat] || PHY_IMPACT[1];
  return FC.MAGIC_ARROW[nat] || 10018;
}

// ---- 怒气技 ----
function isRageSkill(skillId) {
  return D.RAGE_SKILLS[String(skillId)] != null;
}
function rageCostOf(skillId) {
  const r = D.RAGE_SKILLS[String(skillId)];
  return r ? Number(r.rageCost) || 0 : 0;
}
// 幻梦战技能配置：威力/命中/类型/PP 走主技能表，effType 被 CfgDream 覆盖；
// 幻梦普攻统一覆写 effType=1002（前方对手，官方规则「普攻均是此攻击范围」），60112 虚数冲击修正为物理(type=1)。
function dreamSkillCfg(skillId) {
  const base = FC.skillCfg(skillId);
  if (!base) return null;
  const sid = Number(skillId);
  const r = D.RAGE_SKILLS[String(sid)];
  if (r) return Object.assign({}, base, { effType: r.effType, rageCost: Number(r.rageCost) || 0 });
  if (DREAM_BASIC_SKILLS.has(sid)) {
    const patch = { effType: 1002 };
    if (sid === 60112) patch.type = 1; // 虚数冲击：客户端表误标为 2，服务端按物理结算
    return Object.assign({}, base, patch);
  }
  return base;
}
// 誓灵默认怒气技 = servantRageSkills 首项（官方切换需暗噬混沌天赋满级，功能未实现）
function defaultRageSkillOf(type) {
  const list = D.SERVANT_RAGE_SKILLS[String(type)];
  return (list && list.length) ? Number(list[0]) : 0;
}
function rageSkillsOfType(type) {
  return (D.SERVANT_RAGE_SKILLS[String(type)] || []).map(Number);
}

// ---- 回合上限 / 特殊机制 ----
function maxRoundOf(barrier) {
  const b = barrierCfg(barrier);
  return (b && b.maxRound) || DEFAULT_MAX_ROUND;
}
function effectsOf(barrier) {
  const b = barrierCfg(barrier);
  return (b && b.effects) || [];
}
// 机制 id 语义（CfgDream.specialEffectTips）：
// 1 回复封印（全场禁疗）/ 2 源力压制（非直接技能伤害单次 ≤ 目标最大生命 args%）/
// 3 精准打击（魔法箭系列优先打后排）/ 4 回复封印-改（仅我方禁疗）/ 5 生命反转（治疗转为等量扣血）
const EFF_HEAL_SEAL = 1, EFF_POWER_CAP = 2, EFF_PRECISE = 3, EFF_HEAL_SEAL_ALLY = 4, EFF_HEAL_REVERSE = 5;
function effectFlags(barrier) {
  const f = { healSeal: false, healSealAlly: false, healReverse: false, precise: false, powerCapPct: 0, ids: [] };
  for (const e of effectsOf(barrier)) {
    f.ids.push(Number(e.id));
    if (Number(e.id) === EFF_HEAL_SEAL) f.healSeal = true;
    else if (Number(e.id) === EFF_HEAL_SEAL_ALLY) f.healSealAlly = true;
    else if (Number(e.id) === EFF_HEAL_REVERSE) f.healReverse = true;
    else if (Number(e.id) === EFF_PRECISE) f.precise = true;
    else if (Number(e.id) === EFF_POWER_CAP) f.powerCapPct = Number((e.args || [])[0]) || 0;
  }
  return f;
}
// 面板机制文案（csformat(tip, args...)）——服务端只用于日志与自检对账
function effectTipsOf(barrier) {
  return effectsOf(barrier).map(e => {
    const tip = D.EFFECT_TIPS[Number(e.id) - 1] || '';
    return tip.replace(/\{0\}/g, String((e.args || [])[0] != null ? e.args[0] : ''));
  });
}
// 治疗结果修正：返回 'ok' | 'block' | 'reverse'
function healModeOf(barrier, side) {
  const f = effectFlags(barrier);
  if (f.healReverse) return 'reverse';
  if (f.healSeal) return 'block';
  if (f.healSealAlly && side === 0) return 'block';
  return 'ok';
}

// ---- 涨怒 ----
// 御四家狂化天赋（97000 八岐大蛇/97010 凤凰/97020 麒麟/97030 天邪鬼）：「幻梦战时每次行动怒气额外增加25%」
const BERSERK_RAGE_TALENTS = new Set([97000, 97010, 97020, 97030]);
function rageAfterRound(rage, talent) {
  const gain = BERSERK_RAGE_TALENTS.has(Number(talent))
    ? Math.round(RAGE_PER_ROUND * 1.25)
    : RAGE_PER_ROUND;
  return Math.min(RAGE_MAX, (Number(rage) || 0) + gain);
}
function rageAfterHit(rage) {
  return Math.min(RAGE_MAX, (Number(rage) || 0) + RAGE_ON_HIT);
}

// ---- 关卡奖励（wiki《银匙之门》奖励表 + CfgDream.reward 预览交叉核对）----
// 每关固定材料：神智的银钥（31000051..55/68 六阶）+ 诡异秘丸（31000046..50/67 六阶）
const KEY_ITEMS = [31000051, 31000052, 31000053, 31000054, 31000055, 31000068]; // 银钥 Ⅰ~Ⅵ
const PILL_ITEMS = [31000046, 31000047, 31000048, 31000049, 31000050, 31000067]; // 秘丸 Ⅰ~Ⅵ
// [起, 止, 阶(1-6), 数量]
const ITEM_RANGES = [
  [1, 5, 1, 4], [6, 10, 1, 5], [11, 15, 1, 4], [16, 20, 1, 5],
  [21, 35, 2, 2], [36, 40, 2, 3],
  [41, 45, 3, 1], [46, 50, 3, 2], [51, 55, 3, 1], [56, 60, 3, 2],
  [61, 68, 4, 1], [69, 70, 4, 2], [71, 78, 4, 1], [79, 80, 4, 2],
  [81, 100, 5, 1],
  [101, 130, 6, 1],
];
// 里程碑关：碎片（固定）+ 誓灵（概率）。CfgDream.reward 预览与 wiki 完全一致
const MILESTONES = {
  20: { frag: 65000001, fragNum: 1, servant: 2633005 },  // 伊塔库亚
  30: { frag: 65000001, fragNum: 2, servant: 2633005 },
  50: { frag: 65000002, fragNum: 1, servant: 2632006 },  // 克图格亚
  60: { frag: 65000002, fragNum: 2, servant: 2632006 },
  80: { frag: 65000003, fragNum: 1, servant: 2648004 },  // 犹格索托斯
  100: { frag: 65000003, fragNum: 1, servant: 2648004 },
  120: { frag: 65000004, fragNum: 1, servant: 2636010 }, // 诺登斯
  130: { frag: 65000004, fragNum: 2, servant: 2636010 },
};
function itemRewardOf(barrier) {
  const b = Number(barrier);
  const out = [];
  for (const [lo, hi, tier, num] of ITEM_RANGES) {
    if (b >= lo && b <= hi) {
      out.push({ id: KEY_ITEMS[tier - 1], num });
      out.push({ id: PILL_ITEMS[tier - 1], num });
      break;
    }
  }
  const ms = MILESTONES[b];
  if (ms) out.push({ id: ms.frag, num: ms.fragNum });
  return out;
}
// 概率掉落誓灵 type（未命中回 0）
function rollServantDrop(barrier, rng) {
  const ms = MILESTONES[Number(barrier)];
  if (!ms) return 0;
  return ((rng || Math.random)() < SERVANT_DROP_RATE) ? ms.servant : 0;
}
function milestoneServantOf(barrier) {
  const ms = MILESTONES[Number(barrier)];
  return ms ? ms.servant : 0;
}

// ---- 经验 ----
function servantExpOf(barrier) {
  return EXP_BASE + Number(barrier) * EXP_PER_BARRIER;
}
function roleExpOf(barrier) {
  return ROLE_EXP_BASE + Number(barrier) * ROLE_EXP_PER_BARRIER;
}

// ---- 买钥之匙 ----
function buyCostOf(times) {
  return Number(D.BUY_KEY.cost[Number(times)]) || 0; // times = 已购次数（0-based）
}

module.exports = {
  D,
  COPY_DREAM, TYPE_DREAM, MAX_BARRIER, MAIN_NUM, MIN_NUM, SUB_POS,
  MAIN_COST_MAX, SUB_COST_MAX, MAX_FAIL, FREE_FAIL_BARRIER, DEFAULT_MAX_ROUND,
  RAGE_MAX, RAGE_START, RAGE_PER_ROUND, RAGE_ON_HIT, DAILY_TIMES_BASE, SERVANT_DROP_RATE,
  TILE_OF_POS, tileOfPos,
  isDreamCopy, barrierOf, copyIdOf, barrierCfg,
  stepOfStar, dreamLevelOf, dreamAttrs, colorOf, costOfType,
  dreamGrowthOf, syncDreamLv,
  isRageSkill, rageCostOf, dreamSkillCfg, defaultRageSkillOf, rageSkillsOfType,
  PHY_IMPACT, DREAM_BASIC_SKILLS, isBasicSkill, fantasyAttackTypeOf, basicSkillOf, BERSERK_RAGE_TALENTS,
  maxRoundOf, effectsOf, effectFlags, effectTipsOf, healModeOf,
  EFF_HEAL_SEAL, EFF_POWER_CAP, EFF_PRECISE, EFF_HEAL_SEAL_ALLY, EFF_HEAL_REVERSE,
  rageAfterRound, rageAfterHit,
  KEY_ITEMS, PILL_ITEMS, ITEM_RANGES, MILESTONES,
  itemRewardOf, rollServantDrop, milestoneServantOf,
  servantExpOf, roleExpOf, buyCostOf,
};
